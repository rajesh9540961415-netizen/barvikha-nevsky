"use server";

import { revalidatePath } from "next/cache";
import quickResto from "@/data/employees.json";
import {
  buildEvents,
  draftError,
  rowsFromDraft,
  type Draft,
  type OfficeEntry,
  type ShiftEvent,
} from "../office";
import type { Employee, Shift } from "../types";
import { currentManager } from "./managers";
import { db } from "./sql";

/**
 * Исправления.
 *
 * Правка НЕ переписывает запись. Старая помечается отменённой, новая встаёт
 * рядом и ссылается на неё. Через год должно быть видно не только «сколько»,
 * но и «что было до того, как поправили, кто поправил и когда». Правка
 * на месте стирает первое и превращает историю в пересказ победителя.
 *
 * Удалять не может никто: ни смена, ни управляющий, ни владелец. Строки
 * только добавляются и помечаются.
 *
 * Всё, что меняет деньги, проверяется здесь заново — и права, и сам черновик.
 * Экран можно обойти, а деньги от этого настоящими быть не перестанут.
 */

export type Answer = { ok: true } | { error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Row = {
  id: string;
  business_day: string;
  hall_id: number | null;
  hall_title: string | null;
  table_id: number | null;
  table_title: string | null;
  waiter_id: number;
  waiter_name: string;
  amount: string;
  gross: string | null;
  commission_rate: string;
  kind: string;
  operator_id: number | null;
  operator_name: string;
  created_at: Date;
  deleted_at: Date | null;
  deleted_by_name: string | null;
  deleted_note: string | null;
  split_group: string | null;
  corrects: string | null;
  source: string;
  manager_id: number | null;
  manager_name: string | null;
  note: string | null;
};

function toEntry(r: Row): OfficeEntry {
  return {
    id: r.id,
    businessDay: r.business_day,
    hallId: r.hall_id,
    hallTitle: r.hall_title,
    tableId: r.table_id,
    tableTitle: r.table_title,
    waiterId: r.waiter_id,
    waiterName: r.waiter_name,
    // Деньги в базе хранятся как numeric и приезжают строкой — иначе
    // копейки округлялись бы на ровном месте.
    amount: Number(r.amount),
    gross: r.gross === null ? Number(r.amount) : Number(r.gross),
    commissionRate: Number(r.commission_rate),
    kind: r.kind as OfficeEntry["kind"],
    operatorId: r.operator_id,
    operatorName: r.operator_name,
    createdAt: r.created_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
    deletedByName: r.deleted_by_name,
    deletedNote: r.deleted_note,
    splitGroup: r.split_group,
    corrects: r.corrects,
    source: r.source as OfficeEntry["source"],
    managerId: r.manager_id,
    managerName: r.manager_name,
    note: r.note,
  };
}

/** Правка состава смены: что было и что стало. */
export type CrewChange = {
  at: string;
  managerName: string;
  before: Shift;
  after: Shift;
  note: string | null;
};

export type DayData = {
  businessDay: string;
  /** Живые записи — из них считается смена. */
  live: OfficeEntry[];
  /** Все события дня, включая отменённые: это и есть история. */
  events: ShiftEvent[];
  shift: Shift;
  /** Официанты смены — в том виде, в каком их ждёт расчёт. */
  crew: Employee[];
  /** Кого вообще можно поставить: справочник кассы плюс дописанные руками. */
  people: Employee[];
  changes: CrewChange[];
};

// Хостес и кальянный бар бэк-офис пока не правит — но обязан их не потерять:
// смена читается здесь, а пишется частями, и пустой список в этом объекте
// однажды затёр бы настоящий состав. Появится экран правки — появится и здесь.
const EMPTY: Shift = {
  crew: [],
  operator: null,
  admin: null,
  admin2: null,
  cashier: null,
  hostess: [],
  hookah: [],
};

async function allPeople(): Promise<Employee[]> {
  const sql = db();
  const manual = await sql<{ id: number; name: string; short: string }[]>`
    select id, name, short from manual_people order by id desc
  `;
  return [...(quickResto as Employee[]), ...manual];
}

/** Всё, что нужно экрану смены, одним чтением. */
export async function readDay(businessDay: string): Promise<DayData | null> {
  if (!DAY.test(businessDay)) return null;
  const sql = db();

  const rows = await sql<Row[]>`
    select e.*, m.name as manager_name
      from entries e
      left join managers m on m.id = e.manager_id
     where e.business_day = ${businessDay}
     order by e.created_at desc
  `;

  const shifts = await sql<
    {
      crew: number[];
      operator_id: number | null;
      admin_id: number | null;
      admin2_id: number | null;
      cashier_id: number | null;
      hostess: number[] | null;
      hookah: number[] | null;
    }[]
  >`select * from shifts where business_day = ${businessDay}`;

  const changeRows = await sql<
    {
      at: Date;
      manager_name: string;
      before_state: Shift;
      after_state: Shift;
      note: string | null;
    }[]
  >`
    select at, manager_name, before_state, after_state, note
      from shift_changes
     where business_day = ${businessDay}
     order by at desc
  `;

  const people = await allPeople();
  const entries = rows.map(toEntry);

  const shift: Shift = shifts[0]
    ? {
        crew: shifts[0].crew,
        operator: shifts[0].operator_id,
        admin: shifts[0].admin_id,
        admin2: shifts[0].admin2_id,
        cashier: shifts[0].cashier_id,
        hostess: shifts[0].hostess ?? [],
        hookah: shifts[0].hookah ?? [],
      }
    : EMPTY;

  // Официант, которого нет в справочнике, всё равно должен попасть в расчёт:
  // без него доля кассира поделилась бы на меньшее число людей, и остальные
  // получили бы больше, чем им причитается. Имя в таком случае берём
  // из записей — там оно хранится рядом с номером как раз на этот случай.
  const crew: Employee[] = shift.crew.map((id) => {
    const known = people.find((p) => p.id === id);
    if (known) return known;
    const seen = entries.find((e) => e.waiterId === id);
    return { id, name: seen?.waiterName ?? `№${id}`, short: seen?.waiterName ?? `№${id}` };
  });

  return {
    businessDay,
    live: entries.filter((e) => !e.deletedAt),
    events: buildEvents(entries),
    shift,
    crew,
    people,
    changes: changeRows.map((c) => ({
      at: c.at.toISOString(),
      managerName: c.manager_name,
      before: c.before_state,
      after: c.after_state,
      note: c.note,
    })),
  };
}

/* ─── Правка записи ──────────────────────────────────────────────────── */

/**
 * Заменяет событие смены новым.
 *
 * Одной транзакцией: старое помечается отменённым, новое встаёт на его место.
 * Если разорвать, смена на секунду окажется либо без этих денег вовсе, либо
 * с ними дважды — а в эту секунду кто-нибудь откроет отчёт.
 *
 * Условие «ещё не отменено» защищает от двух управляющих, открывших одну
 * смену: второй ничего не заменит и получит отказ, а не тихо создаст
 * вторую копию тех же денег.
 */
export async function correctEvent(input: {
  businessDay: string;
  key: string;
  draft: Draft;
  note: string;
}): Promise<Answer> {
  const manager = await currentManager();
  if (!manager) return { error: "Вход истёк — войдите заново" };
  if (!DAY.test(input.businessDay)) return { error: "Непонятная смена" };
  if (!UUID.test(input.key)) return { error: "Непонятная запись" };

  const bad = draftError(input.draft);
  if (bad) return { error: bad };

  const people = await allPeople();
  const sql = db();

  // Раскладка смены перебирает состав, а не записи. Значит деньги, записанные
  // на человека вне состава, в неё просто не попадут — и пропадут молча.
  const [crewRow] = await sql<{ crew: number[] }[]>`
    select crew from shifts where business_day = ${input.businessDay}
  `;
  const inCrew = new Set(crewRow?.crew ?? []);
  const stray = input.draft.waiterIds.find((id) => !inCrew.has(id));
  if (stray !== undefined) {
    return {
      error: `В составе смены нет сотрудника №${stray} — сначала поправьте состав`,
    };
  }

  try {
    await sql.begin(async (tx) => {
      const old = await tx<Row[]>`
        select * from entries
         where business_day = ${input.businessDay}
           and deleted_at is null
           and coalesce(split_group, id) = ${input.key}::uuid
         order by created_at
         for update
      `;
      if (old.length === 0) {
        throw new Error(
          "Эту запись уже поправили или отменили. Обновите страницу и посмотрите, как она выглядит сейчас",
        );
      }

      const first = old[0];
      const fresh = rowsFromDraft(input.draft, {
        businessDay: input.businessDay,
        // Время исходной записи: деньги гость оставил тогда, и в истории
        // смены запись должна остаться на своём месте.
        createdAt: first.created_at.toISOString(),
        operatorId: first.operator_id,
        operatorName: first.operator_name,
        managerId: manager.id,
        corrects: input.key,
        note: input.note.trim() || null,
        nameOf: (id) =>
          people.find((p) => p.id === id)?.name ??
          old.find((r) => r.waiter_id === id)?.waiter_name ??
          `№${id}`,
      });

      await tx`
        update entries
           set deleted_at = now(),
               deleted_by_manager_id = ${manager.id},
               deleted_by_name = ${manager.name}
         where id in ${tx(old.map((r) => r.id))}
           and deleted_at is null
      `;

      for (const e of fresh) {
        await tx`
          insert into entries (
            id, business_day, hall_id, hall_title, table_id, table_title,
            waiter_id, waiter_name, amount, kind, operator_id, operator_name,
            created_at, split_group, gross, commission_rate,
            corrects, source, manager_id, note
          ) values (
            ${e.id}, ${e.businessDay}, ${e.hallId}, ${e.hallTitle},
            ${e.tableId}, ${e.tableTitle}, ${e.waiterId}, ${e.waiterName},
            ${e.amount}, ${e.kind}, ${e.operatorId}, ${e.operatorName},
            ${e.createdAt}, ${e.splitGroup ?? null}, ${e.gross}, ${e.commissionRate},
            ${e.corrects}, 'office', ${e.managerId}, ${e.note}
          )
        `;
      }
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Не получилось сохранить" };
  }

  revalidatePath(`/shift/${input.businessDay}`);
  revalidatePath("/");
  return { ok: true };
}

/**
 * Отменяет событие без замены.
 *
 * Не удаляет: строки остаются в базе и видны в истории перечёркнутыми.
 * Стереть строку нельзя в принципе — это и есть настоящая защита денег,
 * а не запрет на запись.
 */
export async function cancelEvent(input: {
  businessDay: string;
  key: string;
  note: string;
}): Promise<Answer> {
  const manager = await currentManager();
  if (!manager) return { error: "Вход истёк — войдите заново" };
  if (!DAY.test(input.businessDay)) return { error: "Непонятная смена" };
  if (!UUID.test(input.key)) return { error: "Непонятная запись" };

  const sql = db();
  const changed = await sql`
    update entries
       set deleted_at = now(),
           deleted_by_manager_id = ${manager.id},
           deleted_by_name = ${manager.name},
           deleted_note = ${input.note.trim() || null}
     where business_day = ${input.businessDay}
       and deleted_at is null
       and coalesce(split_group, id) = ${input.key}::uuid
     returning id
  `;

  if (changed.length === 0) {
    return { error: "Эту запись уже отменили. Обновите страницу" };
  }

  revalidatePath(`/shift/${input.businessDay}`);
  revalidatePath("/");
  return { ok: true };
}

/* ─── Правка состава смены ───────────────────────────────────────────── */

/**
 * Меняет состав смены и роли задним числом.
 *
 * От состава зависит вся раскладка: доля кассира делится на число официантов,
 * и стоит добавить человека — она уменьшится у каждого. Поэтому здесь тот же
 * порядок, что и у записей: сначала предпросмотр «было / стало», потом
 * сохранение, и обязательно след, кто менял.
 *
 * След своей таблицей, а не по образцу записей: у состава одна строка
 * на смену, и правка её переписывает — иначе не осталось бы ничего.
 */
export async function saveCrew(input: {
  businessDay: string;
  shift: Shift;
  note: string;
}): Promise<Answer> {
  const manager = await currentManager();
  if (!manager) return { error: "Вход истёк — войдите заново" };
  if (!DAY.test(input.businessDay)) return { error: "Непонятная смена" };

  const crew = [...new Set(input.shift.crew)].filter(Number.isInteger);
  if (crew.length === 0) return { error: "В смене должен быть хотя бы один официант" };

  const sqlCheck = db();
  const people = await allPeople();
  // Кого вообще можно поставить. Справочника мало: человека могли дописать
  // руками, потом убрать из списка, а деньги за ним остались — выбросить его
  // из смены значило бы отдать его долю кассира остальным.
  const seen = await sqlCheck<{ waiter_id: number }[]>`
    select distinct waiter_id from entries where business_day = ${input.businessDay}
    union
    select unnest(crew) from shifts where business_day = ${input.businessDay}
  `;
  const allowed = new Set([
    ...people.map((p) => p.id),
    ...seen.map((r) => r.waiter_id),
  ]);

  const role = (id: number | null) =>
    id !== null && Number.isInteger(id) ? id : null;

  const after: Shift = {
    crew,
    operator: role(input.shift.operator),
    admin: role(input.shift.admin),
    admin2: role(input.shift.admin2),
    cashier: role(input.shift.cashier),
    // Бэк-офис этих двух списков не трогает: экрана для них нет, а сам запрос
    // ниже их столбцов не касается. Здесь они нужны, чтобы след «было / стало»
    // не выглядел так, будто правка стёрла хостес и кальянщиков.
    hostess: input.shift.hostess ?? [],
    hookah: input.shift.hookah ?? [],
  };

  const unknown = [
    after.operator,
    after.admin,
    after.admin2,
    after.cashier,
    ...crew,
  ].find((id) => id !== null && !allowed.has(id));
  if (unknown != null) return { error: `Не знаю сотрудника №${unknown}` };
  if (after.operator === null) return { error: "Укажите, кто вносил записи" };

  // Второй администратор без первого — это не «двое», а сдвинутая на одну
  // клетку смена: доля поделилась бы пополам между человеком и пустотой.
  if (after.admin === null && after.admin2 !== null) {
    return { error: "Второй администратор есть, а первого нет" };
  }
  // Один и тот же человек дважды поделил бы его же долю пополам с самим
  // собой — и половина ушла бы в никуда. Ловим здесь, а не на экране:
  // экран можно обойти, сохранение — нет.
  if (after.admin !== null && after.admin === after.admin2) {
    return { error: "Оба администратора — один и тот же человек" };
  }

  const sql = db();
  try {
    await sql.begin(async (tx) => {
      const before = await tx<
        {
          crew: number[];
          operator_id: number | null;
          admin_id: number | null;
          admin2_id: number | null;
          cashier_id: number | null;
          hostess: number[] | null;
          hookah: number[] | null;
        }[]
      >`select * from shifts where business_day = ${input.businessDay} for update`;

      const was: Shift = before[0]
        ? {
            crew: before[0].crew,
            operator: before[0].operator_id,
            admin: before[0].admin_id,
            admin2: before[0].admin2_id,
            cashier: before[0].cashier_id,
            hostess: before[0].hostess ?? [],
            hookah: before[0].hookah ?? [],
          }
        : EMPTY;

      await tx`
        insert into shifts (
          business_day, crew, operator_id, admin_id, admin2_id, cashier_id
        )
        values (
          ${input.businessDay}, ${after.crew}, ${after.operator},
          ${after.admin}, ${after.admin2}, ${after.cashier}
        )
        on conflict (business_day) do update set
          crew = excluded.crew,
          operator_id = excluded.operator_id,
          admin_id = excluded.admin_id,
          admin2_id = excluded.admin2_id,
          cashier_id = excluded.cashier_id,
          updated_at = now()
      `;

      await tx`
        insert into shift_changes (
          business_day, manager_id, manager_name, before_state, after_state, note
        ) values (
          ${input.businessDay}, ${manager.id}, ${manager.name},
          -- json(), а не JSON.stringify: строку драйвер положил бы в jsonb
          -- как строку, и обратно она пришла бы текстом, а не составом.
          ${tx.json(was)}, ${tx.json(after)},
          ${input.note.trim() || null}
        )
      `;
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Не получилось сохранить" };
  }

  revalidatePath(`/shift/${input.businessDay}`);
  revalidatePath("/");
  return { ok: true };
}
