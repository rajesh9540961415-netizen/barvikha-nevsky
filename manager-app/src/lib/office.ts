import {
  buildEvents as buildSharedEvents,
  rowsFromDraft as sharedRowsFromDraft,
  type DraftRow,
  type Draft,
  type ShiftEvent as SharedEvent,
} from "./events";
import {
  isHookah,
  splitShift,
  splitSide,
  type ShiftSplit,
  type SideSplit,
} from "./split";
import type { Contour, Employee, Entry, Kind, Shift } from "./types";

/**
 * Бэк-офис поверх общего расчёта.
 *
 * Как устроены события смены, черновик правки и построение новых строк —
 * лежит в `events.ts`, общем с приложением смены: смена правит свою смену
 * этой же ночью, бэк-офис — любой период задним числом, но считаются обе
 * правки одинаково. Два места, считающие одни деньги, однажды разойдутся.
 *
 * Здесь остаётся только своё: запись, у которой автором может быть
 * управляющий, расчёт смены по таким записям и названия видов денег.
 */

export {
  buildEvents,
  contoursOf,
  draftError,
  draftOf,
  eventKey,
  needsTable,
  withReplacement,
  type Draft,
  type Payee,
} from "./events";

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

/** Событие смены в том виде, в каком его показывает и правит бэк-офис. */
export type ShiftEvent = SharedEvent<OfficeEntry>;

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
  /** Ключ события, которое заменяем. Пусто у записи, заведённой с нуля. */
  corrects: string | null;
  note: string | null;
  /** Имена официантов по номерам — берутся из справочника, не с экрана. */
  nameOf: (id: number) => string;
};

/**
 * Строки, которые лягут в базу вместо старых.
 *
 * Деление, комиссия и время события — общим расчётом. Здесь дописывается
 * только подпись бэк-офиса: кто из управляющих правил и что запись пришла
 * не из смены.
 */
export function rowsFromDraft(draft: Draft, t: RowTemplate): OfficeEntry[] {
  const rows: DraftRow[] = sharedRowsFromDraft(draft, {
    businessDay: t.businessDay,
    createdAt: t.createdAt,
    operatorId: t.operatorId,
    operatorName: t.operatorName,
    corrects: t.corrects,
    source: "office",
    note: t.note,
    nameOf: t.nameOf,
  });
  return rows.map((row) => ({
    ...row,
    corrects: row.corrects,
    source: "office" as const,
    managerId: t.managerId,
    managerName: null,
    note: row.note,
    deletedNote: null,
  }));
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

/**
 * Котёл хостес или кальянного бара — тем же расчётом, что и в приложении
 * смены. Автор подставляется по той же причине, что и выше.
 *
 * ⚠️ Заведён 20.08.2026. До этого бэк-офис эти деньги не считал вовсе:
 * они были видны только в списке записей, а в раскладке их не было —
 * и «Заработано за смену» тут и в приложении смены за один вечер
 * называли разные суммы.
 */
export function splitSideOffice(
  rows: OfficeEntry[],
  contour: Contour,
  people: Employee[],
): SideSplit {
  return splitSide(
    rows.map((r) => ({ ...r, operatorId: r.operatorId ?? 0 })),
    contour,
    people,
  );
}

/**
 * Сборка записей бэк-офиса в события — с проставленным «чем заменено».
 *
 * Отдельным именем, чтобы не терять тип: общий расчёт возвращает события
 * над теми записями, что ему дали, а бэк-офису нужны именно свои.
 */
export function officeEvents(rows: OfficeEntry[]): ShiftEvent[] {
  return buildSharedEvents(rows);
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

/**
 * В какой котёл положить деньги человека, которого ДОБАВЛЯЮТ в событие
 * из бэк-офиса.
 *
 * ⚠️ Это не «определить котёл по роли». Котёл записи ставится в момент
 * записи и потом не пересматривается: у тех, кто в событии уже есть, он
 * переезжает из самой записи как есть (см. `draftOf`). Здесь речь только
 * о новом получателе, у которого своего котла ещё нет вовсе, — и тогда
 * единственный честный источник это состав ТОЙ смены.
 *
 * Кальянщик узнаётся по номеру: у второй кассы он сдвинут на миллион,
 * и спутать его не с кем. Хостес — только по составу: номер у неё
 * обычный, зальный.
 *
 * Человек, отмеченный в смене и официантом, и хостес, попадёт в зал.
 * Так задумано: зал — это то, где считается порог и доли, и ошибиться
 * в его пользу безопаснее. Если нужно иначе, запись правится в приложении
 * смены, где котлы выбираются списками.
 */
export function контурНового(id: number, shift: Shift): Contour {
  // Кальянщик узнаётся по номеру: у второй кассы он сдвинут на миллион,
  // и спутать его не с кем.
  if (isHookah(id)) return "hookah";
  // Зал раньше хостес намеренно: человека могли отметить и там, и там,
  // а порог и доли считаются в зале. Ошибиться в его пользу безопаснее —
  // такая запись видна в раскладке, а не пропадает в чужом котле.
  if (shift.crew.includes(id)) return "hall";
  if (shift.hostess.includes(id)) return "hostess";
  return "hall";
}
