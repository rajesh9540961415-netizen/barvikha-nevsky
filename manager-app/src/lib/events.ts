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

import { COMMISSION_RATE, contourOf, netAmount, shares } from "./split";
import type { Contour, Entry, Kind } from "./types";

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

/**
 * Получатель денег и котёл, в который ложится ЕГО доля.
 *
 * Котёл у каждого свой, а не один на событие. Гость за столом оставляет
 * чаевые и просит поделить их между официантом и кальянным баром: сумма
 * одна, событие одно, а правила у долей разные — зальная делится
 * с администратором и кассиром, барская не делится ни с кем.
 *
 * ⚠️ До 20.08.2026 контур был свойством события целиком. Так было верно,
 * пока событие целиком принадлежало одному котлу; смешанное такой моделью
 * не описывается вовсе.
 */
export type Payee = { id: number; contour: Contour };

export type ShiftEvent<T extends EventRow = EventRow> = {
  key: string;
  rows: T[];
  kind: Kind;
  /**
   * Главный котёл события: зал, если в событии есть хоть один зальный
   * получатель, иначе котёл стороны.
   *
   * Одним значением всё событие больше не описывается — смотрите
   * `contours` и котёл у каждого получателя в `waiters`. Это поле
   * оставлено для того, что спрашивает про событие в целом: как его
   * подписать в истории и какие виды денег предлагать при правке.
   */
  contour: Contour;
  /** Все котлы, задетые событием. У смешанного их два. */
  contours: Contour[];
  /** Сколько оставил гость — до комиссии, по всему событию. */
  gross: number;
  /** Сколько дошло до официантов — после комиссии. */
  amount: number;
  hallId: number | null;
  hallTitle: string | null;
  tableId: number | null;
  tableTitle: string | null;
  /** Кому и в какой котёл. Порядок — как в базе, доли считаются по нему же. */
  waiters: { id: number; name: string; contour: Contour }[];
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
    // Котёл берём у каждой строки свой: в смешанном событии первая строка
    // зальная, вторая барская, и по одной первой судить обо всём событии
    // значит записать барские деньги в зал.
    const contours = [
      ...new Set(group.map((r) => contourOf(r as unknown as Entry))),
    ];
    events.push({
      key,
      rows: group,
      kind: first.kind,
      contour: mainContour(contours),
      contours,
      // Суммы складываем по строкам: у поделённых чаевых событие — это
      // сумма долей, а не сумма одной из них.
      gross: round(group.reduce((s, r) => s + (r.gross ?? r.amount), 0)),
      amount: round(group.reduce((s, r) => s + r.amount, 0)),
      hallId: first.hallId,
      hallTitle: first.hallTitle,
      tableId: first.tableId,
      tableTitle: first.tableTitle,
      waiters: group.map((r) => ({
        id: r.waiterId,
        name: r.waiterName,
        contour: contourOf(r as unknown as Entry),
      })),
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
  /**
   * Кому и в какой котёл. Больше одного — сумма делится поровну.
   *
   * Котёл у каждого свой и правкой не меняется: он переезжает из исходной
   * записи как есть. Иначе поправленные чаевые хостес стали бы зальными
   * и начали делиться с администратором и кассиром — на экране правки
   * не изменилось бы ничего, а деньги у людей изменились бы.
   */
  payees: Payee[];
};

export function draftOf(event: ShiftEvent): Draft {
  return {
    kind: event.kind,
    gross: event.gross,
    hallId: event.hallId,
    hallTitle: event.hallTitle,
    tableId: event.tableId,
    tableTitle: event.tableTitle,
    payees: event.waiters.map((w) => ({ id: w.id, contour: w.contour })),
  };
}

/** Котлы, задетые событием: у смешанного их два. */
export function contoursOf(payees: Payee[]): Contour[] {
  return [...new Set(payees.map((p) => p.contour))];
}

/**
 * Главный котёл: зал, если в событии есть хоть один зальный получатель.
 *
 * Зал главнее не по важности, а потому, что он задаёт правила события:
 * зальные деньги приходят за столом и делятся с администратором и кассиром.
 * Событие без единого зального получателя целиком принадлежит своей стороне.
 */
export function mainContour(contours: Contour[]): Contour {
  if (contours.length === 0 || contours.includes("hall")) return "hall";
  return contours[0];
}

/** Бывает ли у такого вида денег стол. У QR и питания — нет. */
export function canHaveTable(kind: Kind): boolean {
  return kind === "cash" || kind === "terminal" || kind === "service";
}

/**
 * Обязателен ли стол.
 *
 * Зальные деньги приходят за столом, и без стола запись зала неполна.
 * У хостес и кальянного бара стол не обязателен: хостес благодарят
 * на выходе, а бару платят мимо зала.
 *
 * ⚠️ «Не обязателен» — не то же самое, что «не бывает». С 20.08.2026 гость
 * может попросить поделить чаевые со стола между официантом и баром,
 * и у барской доли стол есть. Стирать его нельзя: он говорит, откуда деньги.
 */
export function needsTable(
  kind: Kind,
  contours: Contour | Contour[] = "hall",
): boolean {
  const список = Array.isArray(contours) ? contours : [contours];
  if (!список.includes("hall")) return false;
  return canHaveTable(kind);
}

/**
 * Чем платят хостес и кальянному бару, когда платят им напрямую.
 *
 * Своего терминала у них нет — это решение владельца 18.08.2026, и в этой
 * части оно в силе. Терминал у них появляется только вместе со столом:
 * гость платит на зальном терминале и просит поделить (владелец 20.08.2026).
 * Отдельного экрана для этого нет и не нужно — такое вводится за столом.
 */
export const SIDE_KINDS: Kind[] = ["cash", "qr", "service"];

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
  if (draft.payees.length === 0) return "Выберите хотя бы одного получателя";
  const ids = draft.payees.map((p) => p.id);
  if (new Set(ids).size !== ids.length) {
    return "Один и тот же получатель выбран дважды";
  }
  if (draft.kind === "staff" && draft.payees.length > 1) {
    return "Питание делить между людьми нельзя: это личный вычет";
  }
  const контуры = contoursOf(draft.payees);
  if (draft.kind === "staff" && контуры.includes("hookah")) {
    // Кальянщики у другого юрлица, заведение их не кормит: вычитать
    // из их чаевых нечего. Решение владельца 18.08.2026.
    return "Питание кальянному бару не вычитается";
  }
  if (needsTable(draft.kind, контуры) && draft.tableId === null) {
    return "Выберите стол";
  }
  if (
    draft.kind === "terminal" &&
    !контуры.includes("hall") &&
    draft.tableId === null
  ) {
    // Своего терминала у хостес и бара нет — решение владельца 18.08.2026,
    // и в этой части оно в силе. Терминал бывает у них только вместе
    // со столом: гость платит на зальном терминале и просит поделить.
    return "Терминал бывает только за столом — своего у хостес и бара нет";
  }
  if (draft.kind === "qr" && контуры.length > 1) {
    // Поступление по QR приходит уже адресованным котлу: Сбер называет
    // «Официант 5» или «Хостес». Разнести одно поступление сразу в два
    // котла значит переложить деньги из чужого котла в свой.
    return "Поступление по QR принадлежит одному котлу — разнести его в два нельзя";
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
  /** Ключ события, которое заменяем. Пусто у записи, заведённой с нуля. */
  corrects: string | null;
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
  /**
   * Ключ события, которое заменяем.
   *
   * Пусто у записи, заведённой задним числом: она ничего не заменяет,
   * а восполняет то, чего в приложении не было вовсе. Такое бывает,
   * когда человека забыли внести в смену — за август так потерялось
   * 13 116 ₽ по трём вечерам, и увидеть это можно было только по бумаге.
   */
  corrects: string | null;
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
  const split = draft.payees.length > 1;
  const group = split ? crypto.randomUUID() : null;
  // Комиссия снимается со ВСЕЙ суммы гостя сразу, и делится уже дошедшее.
  // Так доли складываются ровно в то, что дошло, — в том числе когда часть
  // суммы уходит в другой котёл: Сберу всё равно, между кем её делят.
  const net = netAmount(draft.gross, draft.kind);
  const parts = shares(net, draft.payees.length);
  const grossParts = shares(draft.gross, draft.payees.length);
  // Стол оставляем по виду денег, а не по котлу: у барской доли, которую
  // гость оставил за столом, стол есть, и стирать его нельзя — он говорит,
  // откуда деньги. Обязателен он только залу, см. `needsTable`.
  const table = canHaveTable(draft.kind);

  return draft.payees.map(({ id: waiterId, contour }, i) => ({
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
    contour,
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
