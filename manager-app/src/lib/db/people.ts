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
  const manual = await sql<{ id: number; name: string; short: string }[]>`
    select id, name, short from manual_people
  `;

  const known = [...(quickResto as Employee[]), ...manual];
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
  const person = people.find((p) => p.id === personId);
  if (!person) return null;

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
    const mine = split.waiters.find((w) => w.waiterId === personId);

    // Администраторов за вечер может быть двое — тогда доля делится
    // пополам. Считаем через `adminShares`, а не делением на два: две доли
    // обязаны сложиться в исходную сумму копейка в копейку.
    const админов = [shift?.admin, shift?.admin2].filter(
      (id) => id !== null && id !== undefined,
    ).length;
    const доли = adminShares(split.adminTotal, админов);

    const roles: string[] = [];
    if (shift?.admin === personId) {
      roles.push(админов > 1 ? "администратор, смену делили надвое" : "администратор");
    }
    if (shift?.admin2 === personId) roles.push("администратор, смену делили надвое");
    if (shift?.cashier === personId) roles.push("кассир");
    if (shift?.operator === personId) roles.push("вносил записи");

    const asAdmin =
      shift?.admin === personId
        ? доли[0]
        : shift?.admin2 === personId
          ? доли[1]
          : 0;
    const asCashier = shift?.cashier === personId ? split.cashierTotal : 0;

    const worked =
      crewIds.includes(personId) ||
      roles.length > 0 ||
      dayEntries.some((e) => e.waiterId === personId);

    const mineAccrued = mine ? mine.accrued : 0;

    // Сравниваем с остальными, а не со всей сменой вместе с собой: включив
    // себя в среднее, человек сравнивался бы наполовину сам с собой, и любая
    // разница становилась бы вдвое тише. Тех, кто в этот вечер не собрал
    // ничего, в среднее не берём — сравнение идёт между теми, кто работал
    // с гостями, а не с пустыми строками состава.
    const others = split.waiters.filter(
      (w) => w.waiterId !== personId && w.total > 0,
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
};

export async function listManualPeople(): Promise<ManualPerson[]> {
  const sql = db();
  const rows = await sql<
    { id: number; name: string; short: string; shifts: string; last_day: string | null }[]
  >`
    select p.id, p.name, p.short,
           (select count(distinct e.business_day) from entries e
             where e.waiter_id = p.id and e.deleted_at is null) as shifts,
           (select max(e.business_day) from entries e
             where e.waiter_id = p.id and e.deleted_at is null) as last_day
      from manual_people p
     order by p.name
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    short: r.short,
    shifts: Number(r.shifts),
    lastDay: r.last_day,
  }));
}
