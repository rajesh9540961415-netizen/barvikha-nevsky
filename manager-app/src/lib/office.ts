import {
  COMMISSION_RATE,
  netAmount,
  shares,
  splitShift,
  type ShiftSplit,
} from "./split";
import type { Employee, Entry, Kind } from "./types";

/**
 * Событие смены — то, что правят.
 *
 * В базе лежат записи, а правят не записи, а события. Разница появляется
 * там, где большой стол обслуживали вдвоём: гость оставил одни чаевые,
 * а в базе они лежат двумя строками, каждому своя доля.
 *
 * Решение владельца 07.08.2026: править группу целиком. Меняешь сумму гостя
 * или список официантов — приложение делит заново. Иначе, поправив одну долю
 * с 1250 на 1500, получишь в сумме 2750 там, где гость оставил 2500, и это
 * расхождение никто никогда не заметит.
 *
 * Ключ события — метка группы, а у обычной записи её собственный номер.
 * Одинаково для обоих случаев, поэтому ссылка «что заменило что» одна.
 */

export type OfficeEntry = Omit<Entry, "operatorId"> & {
  /**
   * Кто внёс запись в смене. Пусто может быть только у записи, заведённой
   * прямо из бэк-офиса, — таких пока не бывает: правка всегда наследует
   * оператора у той записи, которую заменяет.
   */
  operatorId: number | null;
  /** Ключ события, которое эта запись заменила. Пусто у первоначальных. */
  corrects: string | null;
  /** Откуда пришла: из приложения смены или из бэк-офиса. */
  source: "shift" | "office";
  /** Кто поправил. Пусто у записей смены. */
  managerId: number | null;
  managerName: string | null;
  /** Зачем поправили. Заполняется по желанию. */
  note: string | null;
  /** Зачем отменили. */
  deletedNote: string | null;
};

export function eventKey(row: Pick<OfficeEntry, "id" | "splitGroup">): string {
  return row.splitGroup ?? row.id;
}

export type ShiftEvent = {
  key: string;
  rows: OfficeEntry[];
  kind: Kind;
  /** Сколько оставил гость — до комиссии, по всему событию. */
  gross: number;
  /** Сколько дошло до официантов — после комиссии. */
  amount: number;
  hallId: number | null;
  hallTitle: string | null;
  tableId: number | null;
  tableTitle: string | null;
  waiters: { id: number; name: string }[];
  createdAt: string;
  /** Кто внёс в смене. */
  operatorName: string;
  deletedAt: string | null;
  deletedByName: string | null;
  deletedNote: string | null;
  /** Что это событие заменило. */
  corrects: string | null;
  /** Кто поправил, если событие пришло из бэк-офиса. */
  managerName: string | null;
  note: string | null;
  /**
   * Чем заменено. Проставляется при сборке: отмена ради правки и отмена
   * насовсем выглядят в базе одинаково, а на экране должны читаться
   * по-разному — «поправлено» и «отменено» это разные вещи.
   */
  replacedBy: string | null;
};

/** Собирает записи в события: поделённые чаевые — одно событие, а не два. */
export function buildEvents(rows: OfficeEntry[]): ShiftEvent[] {
  const byKey = new Map<string, OfficeEntry[]>();
  for (const row of rows) {
    const key = eventKey(row);
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }

  const events: ShiftEvent[] = [];
  for (const [key, group] of byKey) {
    const first = group[0];
    events.push({
      key,
      rows: group,
      kind: first.kind,
      // Суммы складываем по строкам: у поделённых чаевых событие — это
      // сумма долей, а не сумма одной из них.
      gross: round(group.reduce((s, r) => s + r.gross, 0)),
      amount: round(group.reduce((s, r) => s + r.amount, 0)),
      hallId: first.hallId,
      hallTitle: first.hallTitle,
      tableId: first.tableId,
      tableTitle: first.tableTitle,
      waiters: group.map((r) => ({ id: r.waiterId, name: r.waiterName })),
      createdAt: first.createdAt,
      operatorName: first.operatorName,
      deletedAt: first.deletedAt ?? null,
      deletedByName: first.deletedByName ?? null,
      deletedNote: first.deletedNote,
      corrects: first.corrects,
      managerName: first.managerName,
      note: first.note,
      replacedBy: null,
    });
  }

  // Кто кого заменил. Событие, у которого есть замена, было отменено правкой,
  // а не выброшено: на экране это разные строки.
  const byCorrects = new Map<string, string>();
  for (const e of events) if (e.corrects) byCorrects.set(e.corrects, e.key);
  for (const e of events) e.replacedBy = byCorrects.get(e.key) ?? null;

  // Порядок ввода: событие с правкой сохраняет время исходного, поэтому
  // замена стоит рядом с тем, что заменила, а не улетает в начало списка.
  events.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return events;
}

/* ─── Черновик правки ──────────────────────────────────────────────── */

/** Что можно поменять в событии. */
export type Draft = {
  kind: Kind;
  /** Сумма, которую оставил гость — до комиссии. Её и вводят. */
  gross: number;
  hallId: number | null;
  hallTitle: string | null;
  tableId: number | null;
  tableTitle: string | null;
  /** Кому. Больше одного — чаевые делятся поровну. */
  waiterIds: number[];
};

export function draftOf(event: ShiftEvent): Draft {
  return {
    kind: event.kind,
    gross: event.gross,
    hallId: event.hallId,
    hallTitle: event.hallTitle,
    tableId: event.tableId,
    tableTitle: event.tableTitle,
    waiterIds: event.waiters.map((w) => w.id),
  };
}

/** У QR и питания стола нет: гость платит по чеку, а не за столом. */
export function needsTable(kind: Kind): boolean {
  return kind === "cash" || kind === "terminal" || kind === "service";
}

/**
 * Что не так с черновиком. Пусто — значит можно сохранять.
 *
 * Одна и та же проверка работает и на экране, и на сервере. На экране —
 * чтобы кнопка не была живой зря; на сервере — потому что экран можно
 * обойти, а деньги от этого настоящими быть не перестанут.
 */
export function draftError(draft: Draft): string | null {
  if (!Number.isFinite(draft.gross) || draft.gross <= 0) {
    return "Сумма должна быть больше нуля";
  }
  if (Math.round(draft.gross * 100) !== draft.gross * 100) {
    return "Сумма — не больше двух знаков после запятой";
  }
  if (draft.waiterIds.length === 0) return "Выберите хотя бы одного официанта";
  if (new Set(draft.waiterIds).size !== draft.waiterIds.length) {
    return "Один и тот же официант выбран дважды";
  }
  if (draft.kind === "staff" && draft.waiterIds.length > 1) {
    return "Питание делить между людьми нельзя: это личный вычет";
  }
  if (needsTable(draft.kind) && draft.tableId === null) {
    return "Выберите стол";
  }
  return null;
}

type RowTemplate = {
  businessDay: string;
  /**
   * Время исходного события, а не момент правки.
   *
   * Деньги гость оставил тогда, и в истории смены запись должна стоять
   * на своём месте. Когда именно правили, видно по отменённой записи:
   * у неё проставлено время отмены.
   */
  createdAt: string;
  operatorId: number | null;
  operatorName: string;
  managerId: number;
  /** Ключ события, которое заменяем. */
  corrects: string;
  note: string | null;
  /** Имена официантов по номерам — берутся из справочника, не с экрана. */
  nameOf: (id: number) => string;
};

/**
 * Строки, которые лягут в базу вместо старых.
 *
 * Повторяет приложение смены буква в букву: комиссия снимается со всей
 * суммы сразу, делится уже дошедшее, время одно на всю группу. Иначе доли
 * не сложились бы в то, что оставил гость, и «Расхождение» в отчёте
 * показывало бы копейки из ниоткуда.
 */
export function rowsFromDraft(draft: Draft, t: RowTemplate): OfficeEntry[] {
  const split = draft.waiterIds.length > 1;
  const group = split ? crypto.randomUUID() : null;
  const net = netAmount(draft.gross, draft.kind);
  const parts = shares(net, draft.waiterIds.length);
  const grossParts = shares(draft.gross, draft.waiterIds.length);
  const table = needsTable(draft.kind);

  return draft.waiterIds.map((waiterId, i) => ({
    id: crypto.randomUUID(),
    businessDay: t.businessDay,
    hallId: table ? draft.hallId : null,
    hallTitle: table ? draft.hallTitle : null,
    tableId: table ? draft.tableId : null,
    tableTitle: table ? draft.tableTitle : null,
    waiterId,
    waiterName: t.nameOf(waiterId),
    amount: parts[i],
    gross: grossParts[i],
    commissionRate: COMMISSION_RATE[draft.kind],
    kind: draft.kind,
    // Кто вносил в смене — сохраняем от исходной записи: событие то же
    // самое, а бэк-офис лишь поправил, каким оно записано.
    operatorId: t.operatorId,
    operatorName: t.operatorName,
    createdAt: t.createdAt,
    splitGroup: group,
    deletedAt: null,
    deletedByName: null,
    deletedNote: null,
    corrects: t.corrects,
    source: "office",
    managerId: t.managerId,
    managerName: null,
    note: t.note,
  }));
}

/**
 * Смена после правки — для предпросмотра «было / стало».
 *
 * Строки заменяемого события выкидываются целиком, новые встают на их место.
 * Считать по этому набору можно тем же splitShift, что считает смену
 * по-настоящему: в том и смысл, что предпросмотр и сохранение проходят
 * через один и тот же расчёт.
 */
export function withReplacement(
  live: OfficeEntry[],
  replacedKey: string,
  fresh: OfficeEntry[],
): OfficeEntry[] {
  return [...live.filter((r) => eventKey(r) !== replacedKey), ...fresh];
}

/**
 * Раскладка смены — тем же расчётом, что и в приложении смены.
 *
 * Единственная разница между Entry и OfficeEntry, которая мешает передать
 * записи напрямую, — автор: в бэк-офисе он может быть не заполнен. Расчёту
 * автор не нужен вовсе, он смотрит только на официанта, вид денег и суммы,
 * поэтому подставляем ноль здесь и никуда его не сохраняем.
 */
export function splitOffice(
  rows: OfficeEntry[],
  crew: Employee[],
  businessDay: string,
): ShiftSplit {
  return splitShift(
    rows.map((r) => ({ ...r, operatorId: r.operatorId ?? 0 })),
    crew,
    businessDay,
  );
}

/*
 * «Начислено» — заработок минус доли администратора и кассира, без вычета
 * за питание — считает сам расчёт смены: `w.accrued` у официанта
 * и `waitersAccrued` по смене целиком.
 *
 * Здесь эта величина когда-то считалась своей функцией: 07.08.2026 бэк-офис
 * решили показывать как начисления, а в приложении смены такого числа ещё
 * не было. 08.08.2026 оно появилось и там — отчёту понадобилось ровно то же
 * самое. Свою функцию убрали: два места, считающие одни деньги, однажды
 * разойдутся, и разницу заметят по расхождению в отчёте, а не по коду.
 */

export const KIND_TITLE: Record<Kind, string> = {
  cash: "наличные",
  terminal: "терминал",
  qr: "QR",
  service: "сервисный сбор",
  staff: "питание",
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
