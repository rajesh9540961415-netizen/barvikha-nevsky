/**
 * ⚠️ У этого файла есть копия в manager-app/src/lib/ — как у split.ts и types.ts.
 * Причина и порядок обновления описаны в manager-app/scripts/copies.mjs.
 *
 * Правим здесь, потом в бэк-офисе:  npm run copies
 *
 * ───────────────────────────────────────────────────────────────────────
 *
 * События смены и правка записей.
 *
 * Общее для двух приложений: смена правит свою смену этой же ночью, бэк-офис —
 * любой период задним числом. Правила при этом одни и те же, и жить они должны
 * в одном месте. Два места, считающие одни деньги, однажды разойдутся —
 * и заметят это по расхождению в отчёте, а не по коду.
 *
 * Здесь только чистый расчёт: ни базы, ни экранов. Кто имеет право править
 * и что при этом записывается в след — дело того приложения, которое правит.
 */

import { COMMISSION_RATE, netAmount, shares } from "./split";
import type { Entry, Kind } from "./types";

/**
 * Запись в том виде, в каком её хватает для сборки событий.
 *
 * Автор ослаблен намеренно: в смене запись всегда вносит человек с номером
 * сотрудника, а в бэк-офисе автором может быть управляющий, у которого номера
 * сотрудника нет вовсе. Расчёту автор не нужен — ему важны официант, вид денег
 * и суммы.
 */
export type EventRow = Omit<Entry, "operatorId"> & {
  operatorId?: number | null;
  /** Кто поправил из бэк-офиса. У записей смены пусто. */
  managerName?: string | null;
};

/**
 * Ключ события.
 *
 * В базе лежат записи, а правят не записи, а события. Разница появляется там,
 * где большой стол обслуживали вдвоём: гость оставил одни чаевые, а в базе они
 * лежат двумя строками, каждому своя доля. У поделённых ключ — метка группы,
 * у обычной записи — её собственный номер. Одинаково для обоих случаев,
 * поэтому ссылка «что заменило что» одна.
 */
export function eventKey(row: Pick<EventRow, "id" | "splitGroup">): string {
  return row.splitGroup ?? row.id;
}

export type ShiftEvent<T extends EventRow = EventRow> = {
  key: string;
  rows: T[];
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
export function buildEvents<T extends EventRow>(rows: T[]): ShiftEvent<T>[] {
  const byKey = new Map<string, T[]>();
  for (const row of rows) {
    const key = eventKey(row);
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }

  const events: ShiftEvent<T>[] = [];
  for (const [key, group] of byKey) {
    const first = group[0];
    events.push({
      key,
      rows: group,
      kind: first.kind,
      // Суммы складываем по строкам: у поделённых чаевых событие — это
      // сумма долей, а не сумма одной из них.
      gross: round(group.reduce((s, r) => s + (r.gross ?? r.amount), 0)),
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
      deletedNote: first.deletedNote ?? null,
      corrects: first.corrects ?? null,
      managerName: first.managerName ?? null,
      note: first.note ?? null,
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

/* ─── Черновик правки ──────────────────────────────────────────────────── */

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

/**
 * Строка, которая ляжет в базу вместо старой.
 *
 * Автор ослаблен по той же причине, что и в EventRow: у правки из бэк-офиса
 * номера сотрудника может не быть. Приложение смены подставляет свой номер
 * сразу же — у него автор есть всегда.
 */
export type DraftRow = Omit<Entry, "operatorId"> & {
  operatorId: number | null;
  /** Ключ события, которое заменяем. У правки он есть всегда. */
  corrects: string;
  source: "shift" | "office";
  note: string | null;
};

export type RowTemplate = {
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
  /** Ключ события, которое заменяем. */
  corrects: string;
  source: "shift" | "office";
  note: string | null;
  /** Имена официантов по номерам — берутся из справочника, не с экрана. */
  nameOf: (id: number) => string;
};

/**
 * Строки, которые лягут в базу вместо старых.
 *
 * Повторяет обычный ввод буква в букву: комиссия снимается со всей суммы
 * сразу, делится уже дошедшее, время одно на всю группу. Иначе доли
 * не сложились бы в то, что оставил гость, и «Расхождение» в отчёте
 * показывало бы копейки из ниоткуда.
 */
export function rowsFromDraft(draft: Draft, t: RowTemplate): DraftRow[] {
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
    operatorId: t.operatorId,
    operatorName: t.operatorName,
    createdAt: t.createdAt,
    splitGroup: group,
    deletedAt: null,
    deletedByName: null,
    deletedNote: null,
    corrects: t.corrects,
    source: t.source,
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
export function withReplacement<T extends EventRow>(
  live: T[],
  replacedKey: string,
  fresh: T[],
): T[] {
  return [...live.filter((r) => eventKey(r) !== replacedKey), ...fresh];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
