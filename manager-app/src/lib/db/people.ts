"use server";

import { revalidatePath } from "next/cache";

import quickResto from "@/data/employees.json";
import { splitOffice, type OfficeEntry } from "../office";
import { adminShares } from "../split";
import type { Employee, Shift } from "../types";
import { currentManager } from "./managers";
import { db } from "./sql";

/**
 * Статистика по сотруднику и динамика его работы.
 *
 * Главное требование владельца 07.08.2026: **смены не должны пропадать**.
 * Если человек в этот вечер не работал, строка всё равно стоит на месте
 * с пометкой «не в смене». Иначе таблица из пятнадцати строк подряд выглядит
 * как пятнадцать смен, а на деле это может быть три смены за месяц.
 *
 * Показываем все смены заведения за период, а не все календарные дни: день,
 * когда заведение вообще не работало, — не прогул, и ставить его в упрёк
 * человеку нельзя.
 *
 * Считаем через тот же splitShift, что и везде. Иначе никак: доля кассира
 * делится на число официантов смены, поэтому «сколько начислено Ивану
 * 5 августа» нельзя посчитать, не собрав всю смену 5 августа целиком.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

type EntryRow = {
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
  split_group: string | null;
};

function toEntry(r: EntryRow): OfficeEntry {
  return {
    id: r.id,
    businessDay: r.business_day,
    hallId: r.hall_id,
    hallTitle: r.hall_title,
    tableId: r.table_id,
    tableTitle: r.table_title,
    waiterId: r.waiter_id,
    waiterName: r.waiter_name,
    amount: Number(r.amount),
    gross: r.gross === null ? Number(r.amount) : Number(r.gross),
    commissionRate: Number(r.commission_rate),
    kind: r.kind as OfficeEntry["kind"],
    operatorId: r.operator_id,
    operatorName: r.operator_name,
    createdAt: r.created_at.toISOString(),
    deletedAt: null,
    deletedByName: null,
    deletedNote: null,
    splitGroup: r.split_group,
    corrects: null,
    source: "shift",
    managerId: null,
    managerName: null,
    note: null,
  };
}

/** Кого можно выбрать: все, кто хоть раз стоял в смене или получал деньги. */
export async function listPeople(): Promise<Employee[]> {
  const sql = db();
  const rows = await sql<{ id: number; name: string | null }[]>`
    select waiter_id as id, max(waiter_name) as name
      from entries where deleted_at is null group by waiter_id
    union
    select unnest(crew) as id, null as name from shifts
  `;
  const manual = await sql<
    { id: number; name: string; short: string; hidden_at: Date | null }[]
  >`
    select id, name, short, hidden_at from manual_people
  `;

  const known: Employee[] = [
    ...(quickResto as Employee[]),
    ...manual.map((m) => ({
      id: m.id,
      name: m.name,
      short: m.short,
      hidden: m.hidden_at !== null,
    })),
  ];
  const seen = new Map<number, Employee>();
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    const person = known.find((p) => p.id === r.id);
    seen.set(
      r.id,
      person ?? { id: r.id, name: r.name ?? `№${r.id}`, short: r.name ?? `№${r.id}` },
    );
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/** Одна смена глазами одного человека. */
export type PersonDay = {
  businessDay: string;
  /** Стоял ли в составе смены или получал в ней деньги. */
  worked: boolean;
  /** Особые роли в этой смене. */
  roles: string[];
  cash: number;
  terminal: number;
  qr: number;
  service: number;
  /** Заработок официанта: чаевые плюс сервисный сбор. */
  earned: number;
  /** Начислено после долей администратору и кассиру. */
  accrued: number;
  /**
   * Сколько удержал Сбер с чаевых на терминале.
   *
   * Нужно на экране: в колонке «терминал» стоит то, что дошло до человека,
   * а гость оставил больше. Без этой цифры разница выглядит опиской.
   */
  commission: number;
  toAdmin: number;
  toCashier: number;
  aboveThreshold: boolean;
  /** Доля, полученная как администратор смены. */
  asAdmin: number;
  /** Доля, полученная как кассир смены. */
  asCashier: number;
  /** Всё, что человек получил за этот вечер. */
  got: number;
  /**
   * Средний заработок остальных официантов этой смены.
   *
   * Пусто, когда сравнивать не с кем: человек работал один или больше
   * никто ничего не собрал.
   */
  peers: number | null;
  /**
   * На сколько процентов человек собрал больше или меньше коллег
   * в этот же вечер. Пусто — сравнивать не с чем.
   *
   * Сравнение именно с коллегами того же вечера, а не с его собственным
   * средним, — потому что абсолютные суммы говорят о людности зала,
   * а не о человеке. В слабый вторник мало собрали все, и ставить это
   * в упрёк одному нельзя. Людность одинакова для всех, кто работал
   * в этот вечер, поэтому она сама и вычитается из сравнения.
   */
  vsPeers: number | null;
};

export type PersonStats = {
  person: Employee;
  from: string;
  to: string;
  days: PersonDay[];
  shiftsWorked: number;
  shiftsTotal: number;
  totals: {
    cash: number;
    terminal: number;
    qr: number;
    service: number;
    earned: number;
    accrued: number;
    commission: number;
    asAdmin: number;
    asCashier: number;
    got: number;
  };
  /** Средний заработок за отработанную смену. Пустые смены знаменатель не портят. */
  avgPerShift: number;
  /**
   * Насколько человек в среднем сильнее или слабее коллег за период.
   * Пусто, если сравнить было не с кем ни в одну смену.
   */
  avgVsPeers: number | null;
  /** Сколько раз не дотянул до порога 1300 ₽ — не отдавал доли, но и заработал мало. */
  belowThreshold: number;
};

export async function readPerson(
  personId: number,
  from: string,
  to: string,
): Promise<PersonStats | null> {
  if (!Number.isInteger(personId) || !DAY.test(from) || !DAY.test(to)) return null;

  const sql = db();
  const people = await listPeople();
  const склеено = await склейки();

  // Открыли склеенную запись — показываем человека целиком, а не половину.
  // Склейка и заводилась ради того, чтобы у работника была одна история,
  // и страница, показывающая только один из двух его номеров, эту работу
  // обесценивала бы ровно там, где на неё смотрят.
  const главный = склеено.get(personId) ?? personId;
  const person = people.find((p) => p.id === главный);
  if (!person) return null;

  // Все номера этого человека: его собственный и все, что на него склеены.
  const свои = new Set<number>([главный]);
  for (const [номер, цель] of склеено) if (цель === главный) свои.add(номер);

  // Тянем период целиком одним запросом, а не по дню: тридцать запросов
  // подряд превратили бы страницу в ту самую, что думает минуту.
  const rows = await sql<EntryRow[]>`
    select * from entries
     where business_day between ${from} and ${to}
       and deleted_at is null
     order by business_day, created_at
  `;
  const shiftRows = await sql<
    {
      business_day: string;
      crew: number[];
      operator_id: number | null;
      admin_id: number | null;
      admin2_id: number | null;
      cashier_id: number | null;
      hostess: number[] | null;
      hookah: number[] | null;
    }[]
  >`
    select * from shifts where business_day between ${from} and ${to}
  `;

  const entries = rows.map(toEntry);

  const byDay = new Map<string, OfficeEntry[]>();
  for (const e of entries) {
    const list = byDay.get(e.businessDay);
    if (list) list.push(e);
    else byDay.set(e.businessDay, [e]);
  }

  const shifts = new Map<string, Shift>();
  for (const s of shiftRows) {
    shifts.set(s.business_day, {
      crew: s.crew,
      operator: s.operator_id,
      admin: s.admin_id,
      admin2: s.admin2_id,
      cashier: s.cashier_id,
      hostess: s.hostess ?? [],
      hookah: s.hookah ?? [],
    });
  }

  // Все смены заведения за период — и те, где состав собран, и те, где есть
  // только записи. Отсортированы от свежих к старым: свежее важнее.
  const allDays = [...new Set([...byDay.keys(), ...shifts.keys()])].sort().reverse();

  const days: PersonDay[] = allDays.map((businessDay) => {
    const dayEntries = byDay.get(businessDay) ?? [];
    const shift = shifts.get(businessDay);

    // Состав смены. Если строки состава нет, собираем его из тех, за кем
    // в этот вечер числятся деньги, — иначе доля кассира поделилась бы
    // не на то число людей.
    const crewIds = shift?.crew?.length
      ? shift.crew
      : [...new Set(dayEntries.map((e) => e.waiterId))];

    const crew: Employee[] = crewIds.map(
      (id) =>
        people.find((p) => p.id === id) ?? {
          id,
          name: `№${id}`,
          short: `№${id}`,
        },
    );

    const split = splitOffice(dayEntries, crew, businessDay);

    // Складываем все свои номера, а не берём первый попавшийся. Пересечься
    // в один вечер они почти не могут — до оформления человек работает под
    // одним номером, после под другим, — но «почти» в деньгах не считается.
    const мои = split.waiters.filter((w) => свои.has(w.waiterId));
    const сложить = (взять: (w: (typeof мои)[number]) => number) =>
      round(мои.reduce((acc, w) => acc + взять(w), 0));
    const mine = мои.length
      ? {
          cash: сложить((w) => w.cash),
          terminal: сложить((w) => w.terminal),
          qr: сложить((w) => w.qr),
          service: сложить((w) => w.service),
          total: сложить((w) => w.total),
          accrued: сложить((w) => w.accrued),
          commission: сложить((w) => w.commission),
          toAdmin: сложить((w) => w.toAdmin),
          toCashier: сложить((w) => w.toCashier),
          // Порог считается по каждой записи отдельно, и хватило одной —
          // значит вечер порог перешагнул.
          aboveThreshold: мои.some((w) => w.aboveThreshold),
        }
      : undefined;

    // Администраторов за вечер может быть двое — тогда доля делится
    // пополам. Считаем через `adminShares`, а не делением на два: две доли
    // обязаны сложиться в исходную сумму копейка в копейку.
    const админов = [shift?.admin, shift?.admin2].filter(
      (id) => id !== null && id !== undefined,
    ).length;
    const доли = adminShares(split.adminTotal, админов);

    const roles: string[] = [];
    const свой = (id: number | null | undefined) =>
      id !== null && id !== undefined && свои.has(id);

    if (свой(shift?.admin)) {
      roles.push(админов > 1 ? "администратор, смену делили надвое" : "администратор");
    }
    if (свой(shift?.admin2)) roles.push("администратор, смену делили надвое");
    if (свой(shift?.cashier)) roles.push("кассир");
    if (свой(shift?.operator)) roles.push("вносил записи");

    const asAdmin = свой(shift?.admin)
      ? доли[0]
      : свой(shift?.admin2)
        ? доли[1]
        : 0;
    const asCashier = свой(shift?.cashier) ? split.cashierTotal : 0;

    const worked =
      crewIds.some((id) => свои.has(id)) ||
      roles.length > 0 ||
      dayEntries.some((e) => свои.has(e.waiterId));

    const mineAccrued = mine ? mine.accrued : 0;

    // Сравниваем с остальными, а не со всей сменой вместе с собой: включив
    // себя в среднее, человек сравнивался бы наполовину сам с собой, и любая
    // разница становилась бы вдвое тише. Тех, кто в этот вечер не собрал
    // ничего, в среднее не берём — сравнение идёт между теми, кто работал
    // с гостями, а не с пустыми строками состава.
    const others = split.waiters.filter(
      (w) => !свои.has(w.waiterId) && w.total > 0,
    );
    const peers = others.length
      ? round(others.reduce((s, w) => s + w.total, 0) / others.length)
      : null;
    const earned = mine?.total ?? 0;
    const vsPeers =
      peers && peers > 0 && earned > 0
        ? Math.round((earned / peers - 1) * 100)
        : null;

    return {
      businessDay,
      worked,
      roles,
      cash: mine?.cash ?? 0,
      terminal: mine?.terminal ?? 0,
      qr: mine?.qr ?? 0,
      service: mine?.service ?? 0,
      earned,
      accrued: mineAccrued,
      commission: mine?.commission ?? 0,
      toAdmin: mine?.toAdmin ?? 0,
      toCashier: mine?.toCashier ?? 0,
      aboveThreshold: mine?.aboveThreshold ?? false,
      asAdmin,
      asCashier,
      got: round(mineAccrued + asAdmin + asCashier),
      peers,
      vsPeers,
    };
  });

  const worked = days.filter((d) => d.worked);
  const sum = (pick: (d: PersonDay) => number) =>
    round(days.reduce((acc, d) => acc + pick(d), 0));

  const earned = sum((d) => d.earned);

  // Средним берём среднее по сменам, а не отношение сумм за период: иначе
  // одна сильная пятница перевесила бы месяц обычных вечеров и человек
  // выглядел бы ровно настолько, насколько ему повезло однажды.
  const compared = days.filter((d) => d.vsPeers !== null);
  const avgVsPeers = compared.length
    ? Math.round(compared.reduce((s, d) => s + (d.vsPeers ?? 0), 0) / compared.length)
    : null;

  return {
    person,
    from,
    to,
    days,
    shiftsWorked: worked.length,
    shiftsTotal: days.length,
    totals: {
      cash: sum((d) => d.cash),
      terminal: sum((d) => d.terminal),
      qr: sum((d) => d.qr),
      service: sum((d) => d.service),
      earned,
      accrued: sum((d) => d.accrued),
      commission: sum((d) => d.commission),
      asAdmin: sum((d) => d.asAdmin),
      asCashier: sum((d) => d.asCashier),
      got: sum((d) => d.got),
    },
    // Делим на отработанные смены, а не на все: иначе выходной занижал бы
    // средний чай и человек выглядел бы хуже, чем работал.
    avgPerShift: worked.length ? round(earned / worked.length) : 0,
    avgVsPeers,
    belowThreshold: worked.filter((d) => d.earned > 0 && !d.aboveThreshold).length,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ─── Переименование вписанного руками ───────────────────────────────────
 *
 * Зачем. 14.08.2026 владелец заметила несоответствие: в отчёте стоят
 * «Настя С.», «Алексей Г.», «Лиза П.». Приложение ничего не сокращает —
 * оно записывает ровно то, что администратор набрал в зале, а набирал он
 * коротко. Людей этих нет в Quick Resto, поэтому иначе как руками их
 * и не внести.
 *
 * Почему правится и прошлое тоже. Имя человека лежит в двух местах:
 * в `manual_people` — на будущее, и копией в каждой записи о деньгах
 * (`entries.waiter_name`). Поправить одно `manual_people` мало: прошлые
 * записи остались бы со старым именем, и один человек навсегда встал бы
 * в отчёте двумя строками. Ровно это несоответствие и заметили.
 *
 * ⚠️ Деньги при этом не трогаются вовсе. Меняется подпись, а номер человека
 * (`waiter_id`) и суммы остаются те же — так что это не правка денег,
 * а исправление имени. Обе таблицы правятся одной сделкой: разойдись они
 * посередине, человек оказался бы под двумя именами сразу.
 *
 * 💡 Заодно это заменяет заплатку в отчёте: `СКЛЕЙКА` в `report_build.py`
 * склеивала «Лиза Н.» с «Елизаветой Недорезовой» на бумаге. Один способ
 * вместо двух — переименовать по-настоящему.
 */
export async function renameManual(
  _previous: { ok: boolean; текст: string } | null,
  form: FormData,
): Promise<{ ok: boolean; текст: string }> {
  const manager = await currentManager();
  if (!manager) return { ok: false, текст: "Войдите заново" };
  // Имя человека — это то, под чем ему начислены деньги. Правит владелец.
  if (manager.role !== "owner") {
    return { ok: false, текст: "Переименовывать может только владелец" };
  }

  const id = Number(form.get("id"));
  const имя = String(form.get("name") ?? "").trim().replace(/\s+/g, " ");

  // Номера вписанных руками отрицательны — так они отличаются от кассовых.
  // Проверка не формальность: положительный номер означал бы попытку
  // переименовать человека из Quick Resto, а он приезжает из кассы
  // и был бы переписан обратно при следующей выгрузке.
  if (!Number.isInteger(id) || id >= 0) {
    return { ok: false, текст: "Переименовать можно только вписанного руками" };
  }
  if (имя.length < 2) return { ok: false, текст: "Слишком короткое имя" };

  const sql = db();
  try {
    const итог = await sql.begin(async (tx) => {
      const занято = await tx`
        select 1 from manual_people
         where lower(name) = lower(${имя}) and id <> ${id} limit 1
      `;
      if (занято.length > 0) return { ok: false, текст: `«${имя}» уже есть в списке` };

      // Старое имя читаем отдельной строкой, до обновления. Достать его
      // подзапросом внутри `returning` можно, но это работает по тонкому
      // правилу о снимке данных — а такое ломается молча и не там, где
      // писалось. В деньгах людей хитрости не нужны.
      const прежние = await tx<{ name: string }[]>`
        select name from manual_people where id = ${id} for update
      `;
      if (прежние.length === 0) return { ok: false, текст: "Человек не найден" };
      const было = прежние[0].name;

      await tx`
        update manual_people set name = ${имя}, short = ${имя} where id = ${id}
      `;

      const записи = await tx<{ id: string }[]>`
        update entries set waiter_name = ${имя}
         where waiter_id = ${id} returning id
      `;
      return {
        ok: true,
        текст:
          `«${было}» теперь «${имя}». ` +
          `Поправлено записей о деньгах: ${записи.length}. Суммы не тронуты.`,
      };
    });
    if (итог.ok) revalidatePath("/people");
    return итог;
  } catch (e) {
    const err = e as { message?: string };
    return { ok: false, текст: `База не ответила: ${err.message ?? "неизвестно"}` };
  }
}

/**
 * Кого можно переименовать: вписанные руками, они же с номером ниже нуля.
 *
 * Вместе с именем отдаём, сколько смен за человеком и когда последняя.
 * Это ответ на вопрос «насколько это срочно»: имя, за которым восемь смен,
 * чинят иначе, чем имя, мелькнувшее однажды в июле.
 *
 * 💡 Денег здесь намеренно нет. Правила их подсчёта живут в `split.ts`
 * и уже лежат копиями в двух приложениях; третья копия, посчитанная
 * «на глазок» ради строчки в списке, разошлась бы с ними молча. Поэтому
 * имя — ссылка на карточку человека, где деньги считаются как везде.
 */
export type ManualPerson = Employee & {
  /** Сколько разных смен за человеком. */
  shifts: number;
  /** Последняя смена, в ключах бизнес-дня. null — записей нет вовсе. */
  lastDay: string | null;
  /** Как запись звалась до склейки. Пусто, если склейки нет. */
  nameBeforeMerge?: string;
  /** Сколько живых записей о деньгах — столько имён поправит склейка. */
  entries: number;
};

export async function listManualPeople(): Promise<ManualPerson[]> {
  const sql = db();
  const rows = await sql<
    {
      id: number;
      name: string;
      short: string;
      shifts: string;
      last_day: string | null;
      hidden_at: Date | null;
      merged_into: number | null;
      merge_undo: { name: string } | null;
      entries: string;
    }[]
  >`
    select p.id, p.name, p.short, p.hidden_at, p.merged_into, p.merge_undo,
           (select count(distinct e.business_day) from entries e
             where e.waiter_id = p.id and e.deleted_at is null) as shifts,
           (select max(e.business_day) from entries e
             where e.waiter_id = p.id and e.deleted_at is null) as last_day,
           (select count(*) from entries e
             where e.waiter_id = p.id and e.deleted_at is null) as entries
      from manual_people p
     order by p.name
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    short: r.short,
    shifts: Number(r.shifts),
    lastDay: r.last_day,
    hidden: r.hidden_at !== null,
    mergedInto: r.merged_into ?? undefined,
    // Имя до склейки — чтобы на экране было видно, откуда взялась запись
    // с чужим именем, а не приходилось это восстанавливать в голове.
    nameBeforeMerge: r.merge_undo?.name,
    entries: Number(r.entries),
  }));
}

/**
 * Кто с кем склеен: {номер вписанного руками → номер главной записи}.
 *
 * Отдельной функцией, потому что спрашивают об этом трое: список выбора
 * (склеенного предлагать не надо), карточка человека (истории складываются)
 * и сама страница «Люди».
 */
export async function склейки(): Promise<Map<number, number>> {
  const sql = db();
  const rows = await sql<{ id: number; merged_into: number }[]>`
    select id, merged_into from manual_people where merged_into is not null
  `;
  return new Map(rows.map((r) => [r.id, r.merged_into]));
}

/**
 * Возвращает убранного человека в список выбора.
 *
 * ⚠️ Зачем это здесь, если в зале имя и так возвращает человека само.
 * Затем, что в зале возвращают ПО ИМЕНИ, а имя могли и переименовать.
 * Владельцу нужен способ вернуть человека, глядя на список, а не угадывая
 * написание.
 */
export async function вернутьВСписок(
  _previous: { ok: boolean; текст: string } | null,
  form: FormData,
): Promise<{ ok: boolean; текст: string }> {
  const manager = await currentManager();
  if (!manager) return { ok: false, текст: "Войдите заново" };
  if (manager.role !== "owner") {
    return { ok: false, текст: "Возвращать в список может только владелец" };
  }

  const id = Number(form.get("id"));
  if (!Number.isInteger(id) || id >= 0) {
    return { ok: false, текст: "Это человек из кассы — его список ведёт Quick Resto" };
  }

  const sql = db();
  const строки = await sql<{ name: string }[]>`
    update manual_people set hidden_at = null where id = ${id} returning name
  `;
  if (строки.length === 0) return { ok: false, текст: "Человек не найден" };

  revalidatePath("/people");
  return {
    ok: true,
    текст: `${строки[0].name} снова в списке — его можно отмечать в смене.`,
  };
}

/**
 * Склеивает вписанного руками с главной записью человека.
 *
 * Что делает разом две вещи, и обе нужны:
 *
 *   1. **записывает решение** — «номер −5 это тот же человек, что №920»;
 *   2. **приводит имя к имени главной записи** — и в справочнике,
 *      и во всех прошлых записях о деньгах.
 *
 * ⚠️ Второе не украшение. Отчёт складывает людей ПО ИМЕНИ, и до сих пор это
 * держалось на том, что администратор набрал имя буква в букву как в кассе.
 * Наберёт «Михаэла» вместо «Михаела» — и у человека в отчёте две строки,
 * а деньги разъехались по ним. После склейки совпадение имени перестаёт быть
 * везением: оно следствие записанного решения.
 *
 * ⚠️ А вот номер в записях НЕ меняем. Запись — денежный документ: в тот вечер
 * деньги внесли именно на этот номер, и через год должно быть видно, как было.
 * Отсюда же и обратимость: склейку можно снять, а переписанные номера
 * назад не соберёшь.
 *
 * 💡 Почему решение хранится здесь, а не словарём в сборщике отчёта. Словарь
 * `СКЛЕЙКА` в `report_build.py` делал ровно это же, но жил в коде на другом
 * компьютере: правит его тот, кто открывает Питон, а знает про людей тот,
 * кто открывает бэк-офис. Решение должно лежать там, где его принимают.
 */
export async function склеить(
  _previous: { ok: boolean; текст: string } | null,
  form: FormData,
): Promise<{ ok: boolean; текст: string }> {
  const manager = await currentManager();
  if (!manager) return { ok: false, текст: "Войдите заново" };
  if (manager.role !== "owner") {
    return { ok: false, текст: "Склеивать людей может только владелец" };
  }

  const id = Number(form.get("id"));
  const главный = Number(form.get("target"));
  return склеитьЯдро(id, главный);
}

/**
 * Склейка как таковая, без входа и без формы.
 *
 * Вынесена отдельно 08.09.2026, чтобы её могли звать двое: экран «Сотрудники»
 * и служебная дверь правок `/api/tips-fix`. Причина не в удобстве. Новичка
 * вписывают руками в первую же смену, а в справочнике из кассы он появляется
 * через несколько дней — двойник получается КАЖДЫЙ раз: так было с Саблиной,
 * Горбуновым, Бобылевой и 08.09 со Львом Леоновым.
 *
 * ⚠️ Проверки живут ЗДЕСЬ, а не у зовущих. Два места, проверяющие одно и то же,
 * однажды разойдутся — сегодня ровно этим кончились три ошибки в счёте
 * мотивации кальянного бара.
 */
export async function склеитьЯдро(
  id: number,
  главный: number,
): Promise<{ ok: boolean; текст: string }> {

  // Склеивать можно только вписанного руками: имя человека из Quick Resto
  // приезжает из кассы и вернулось бы обратно при следующей выгрузке.
  if (!Number.isInteger(id) || id >= 0) {
    return { ok: false, текст: "Склеить можно только вписанного руками" };
  }
  if (!Number.isInteger(главный)) return { ok: false, текст: "Не выбран человек" };
  if (главный === id) return { ok: false, текст: "Человек не может быть сам себе двойником" };

  // ⚠️ Ищем в СПРАВОЧНИКЕ, а не в `listPeople()`. Тот список — «кто хоть раз
  // стоял в смене или получал деньги», и главной записи там может не быть
  // вовсе: стажёра заводят в кассе ДО первой смены под новым номером, и до
  // неё он ни в одной смене не значится. 19.08.2026 на этом склейка отвергала
  // ровно тех, ради кого делалась, — Саблину, Горбунова и Бобылеву: все трое
  // есть в кассе и ни один не отработал под кассовым номером ни вечера.
  //
  // 💡 Ошибка вышла из половинчатой починки: список в окне выбора я поправил,
  // а проверку здесь оставил прежней. Два списка, отвечающих на один вопрос,
  // разошлись молча — и разошлись между экраном и тем, что он делает.
  const справочник: Employee[] = [
    ...(quickResto as Employee[]),
    ...(await listManualPeople()),
  ];
  const цель = справочник.find((p) => p.id === главный);
  if (!цель) return { ok: false, текст: "Такого человека нет" };

  // Цепочек не допускаем: A → B → C читалось бы по-разному в трёх местах,
  // и однажды прочиталось бы неверно в деньгах.
  const уже = await склейки();
  if (уже.has(главный)) {
    return {
      ok: false,
      текст: "Этот человек сам склеен с другим — выберите ту запись, к которой ведёт склейка",
    };
  }
  if ([...уже.values()].includes(id)) {
    return { ok: false, текст: "С этой записью уже склеен кто-то другой" };
  }

  const sql = db();
  try {
    const итог = await sql.begin(async (tx) => {
      const прежние = await tx<{ name: string }[]>`
        select name from manual_people where id = ${id} for update
      `;
      if (прежние.length === 0) return { ok: false, текст: "Человек не найден" };
      const было = прежние[0].name;

      await tx`
        update manual_people
           set name = ${цель.name}, short = ${цель.short},
               merged_into = ${главный},
               -- Склеенного больше не предлагаем отмечать: человек один,
               -- и отмечать надо главную запись.
               hidden_at = coalesce(hidden_at, now())
         where id = ${id}
      `;

      const записи = await tx<{ id: string }[]>`
        update entries set waiter_name = ${цель.name}
         where waiter_id = ${id} returning id
      `;

      return {
        ok: true,
        текст:
          `«${было}» теперь считается тем же человеком, что «${цель.name}» (№${главный}). ` +
          `Имя приведено к главной записи, поправлено записей о деньгах: ${записи.length}. ` +
          "Суммы не тронуты, номера в записях остались прежними.",
      };
    });
    if (итог.ok) revalidatePath("/people");
    return итог;
  } catch (e) {
    const err = e as { message?: string };
    return { ok: false, текст: `База не ответила: ${err.message ?? "неизвестно"}` };
  }
}

/**
 * Снимает склейку.
 *
 * ⚠️ Имя обратно НЕ переименовывает. Мы не знаем, каким оно должно стать:
 * прежнее было тем самым неверным написанием, из-за которого склейку
 * и делали. Вернуть его молча значило бы снова развалить строку в отчёте.
 * Имя правится отдельно и осознанно — кнопкой «переименовать».
 */
export async function расклеить(
  _previous: { ok: boolean; текст: string } | null,
  form: FormData,
): Promise<{ ok: boolean; текст: string }> {
  const manager = await currentManager();
  if (!manager) return { ok: false, текст: "Войдите заново" };
  if (manager.role !== "owner") {
    return { ok: false, текст: "Снимать склейку может только владелец" };
  }

  const id = Number(form.get("id"));
  if (!Number.isInteger(id) || id >= 0) {
    return { ok: false, текст: "Это не вписанный руками" };
  }

  const sql = db();
  try {
    const итог = await sql.begin(async (tx) => {
      const [строка] = await tx<
        {
          name: string;
          merged_into: number | null;
          merge_undo: { name: string; short: string; hiddenAt: string | null } | null;
        }[]
      >`
        select name, merged_into, merge_undo from manual_people
         where id = ${id} for update
      `;
      if (!строка) return { ok: false, текст: "Человек не найден" };
      if (строка.merged_into === null) {
        return { ok: false, текст: `${строка.name}: склейки на этой записи нет` };
      }

      const вернуть = строка.merge_undo;
      if (!вернуть) {
        // Склейка сделана до 20.08.2026, когда прежнее состояние ещё
        // не запоминали. Указатель снимаем, но имя вернуть неоткуда —
        // и говорим об этом прямо, а не делаем вид, что вернули всё.
        await tx`
          update manual_people set merged_into = null, merge_undo = null
           where id = ${id}
        `;
        return {
          ok: true,
          текст:
            `${строка.name}: склейка снята, но имя вернуть неоткуда — ` +
            "эту склейку делали до того, как приложение стало запоминать " +
            "прежнее имя. Поправьте имя кнопкой «переименовать».",
        };
      }

      await tx`
        update manual_people
           set name = ${вернуть.name},
               short = ${вернуть.short},
               hidden_at = ${вернуть.hiddenAt},
               merged_into = null,
               merge_undo = null
         where id = ${id}
      `;

      const записи = await tx<{ id: string }[]>`
        update entries set waiter_name = ${вернуть.name}
         where waiter_id = ${id} returning id
      `;

      return {
        ok: true,
        текст:
          `Склейка снята. «${строка.name}» снова «${вернуть.name}», ` +
          `имя возвращено в записях о деньгах: ${записи.length}. ` +
          (вернуть.hiddenAt
            ? "Запись, как и была, убрана из списка."
            : "Запись снова в списке."),
      };
    });
    if (итог.ok) revalidatePath("/people");
    return итог;
  } catch (e) {
    const err = e as { message?: string };
    return { ok: false, текст: `База не ответила: ${err.message ?? "неизвестно"}` };
  }
}

/**
 * Вписывает человека руками — из бэк-офиса, не трогая ни одной смены.
 *
 * Зачем понадобилось. До 19.08.2026 завести человека умело только приложение
 * смены, и там кнопка «вписать» сразу ставит его в СЕГОДНЯШНЮЮ смену — в состав
 * или в роль, смотря из какого раздела вписывают. Для сегодняшнего вечера это
 * правильно: администратор вписывает того, кто вышел прямо сейчас.
 *
 * А для разбора прошлого — нет. 19.08.2026 выяснилось, что запись «Елизавета
 * Недорезова» держит двух разных людей: 28 308,91 ₽ официантских за 11, 14, 15
 * и 17 августа — Настины, а 10 435,59 ₽ администраторских за 5 и 18 — Лизины.
 * Чтобы развести их, Лизе нужна отдельная запись, а заводить её через живой
 * зал посреди рабочего вечера — напрашиваться на ошибку в сегодняшних деньгах.
 *
 * ⚠️ Здесь человек заводится и только. Ни в какую смену он не попадает: куда
 * его ставить, решают потом, на экране нужного дня.
 */
export async function вписатьРуками(
  _previous: { ok: boolean; текст: string } | null,
  form: FormData,
): Promise<{ ok: boolean; текст: string }> {
  const manager = await currentManager();
  if (!manager) return { ok: false, текст: "Войдите заново" };
  if (manager.role !== "owner") {
    return { ok: false, текст: "Вписывать людей может только владелец" };
  }

  const имя = String(form.get("name") ?? "").trim().replace(/\s+/g, " ");
  if (имя.length < 2) return { ok: false, текст: "Слишком короткое имя" };

  // Человек из кассы. Вписывать его руками нельзя: вышел бы двойник с двумя
  // номерами, а имя из кассы всё равно приедет обратно при следующей выгрузке.
  const вКассе = (quickResto as Employee[]).find(
    (p) => p.name.toLowerCase() === имя.toLowerCase(),
  );
  if (вКассе) {
    return {
      ok: false,
      текст: `${вКассе.name} уже заведён в кассе — выбирайте его в общем списке, вписывать руками не нужно.`,
    };
  }

  const sql = db();
  let ответ = { ok: true, текст: "" };

  await sql.begin(async (tx) => {
    const [есть] = await tx<{ id: number; name: string; hidden_at: Date | null }[]>`
      select id, name, hidden_at from manual_people
       where lower(name) = lower(${имя}) limit 1
    `;
    if (есть) {
      // Имя занято. Если человека убирали — возвращаем того же, а не заводим
      // второго: иначе у одного работника стало бы два номера и две истории.
      if (есть.hidden_at !== null) {
        await tx`update manual_people set hidden_at = null where id = ${есть.id}`;
        ответ = {
          ok: true,
          текст: `${есть.name} уже был в списке — вернули его (№${есть.id}), а не завели заново.`,
        };
      } else {
        ответ = { ok: false, текст: `${есть.name} и так в списке` };
      }
      return;
    }

    // Номер выдаём здесь же, внутри сделки: между «посчитать» и «вставить»
    // никто не должен влезть, иначе двое получат один и тот же.
    const [следующий] = await tx<{ id: number }[]>`
      select coalesce(min(id), 0) - 1 as id from manual_people
    `;
    await tx`
      insert into manual_people (id, name, short)
      values (${следующий.id}, ${имя}, ${имя})
    `;
    ответ = {
      ok: true,
      текст:
        `${имя} вписан, номер ${следующий.id}. ` +
        "Ни в одну смену он пока не поставлен — откройте нужный день и поправьте состав.",
    };
  });

  if (ответ.ok) revalidatePath("/people");
  return ответ;
}
