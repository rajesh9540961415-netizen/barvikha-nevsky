import { cancelEntry, insertEntry, listEntries, listHistory } from "./db/actions";
import type { Entry } from "./types";

/**
 * Хранилище записей.
 *
 * Сами запросы к базе живут в db/actions.ts и выполняются на сервере.
 * Здесь — только то, что видят экраны. Форма функций не менялась с тех пор,
 * когда записи лежали в памяти браузера, поэтому экраны переезда не заметили.
 *
 * Ошибку наружу не глотаем: если запись не сохранилась, экран обязан
 * об этом сказать. Молча потерянные чаевые — ровно то, от чего уходим.
 */

/** Записи за один бизнес-день, свежие сверху. Отменённые не входят. */
export async function listByDay(businessDay: string): Promise<Entry[]> {
  return listEntries(businessDay);
}

/** То же, но вместе с отменёнными — для экрана истории. */
export async function historyByDay(businessDay: string): Promise<Entry[]> {
  return listHistory(businessDay);
}

export async function save(entry: Entry): Promise<void> {
  return insertEntry(entry);
}

/**
 * Отмена записи.
 *
 * Строку не удаляем, а помечаем отменённой: иначе проверить себя нельзя.
 * Ошибся, отменил, внёс заново — в базе должен остаться след обоих шагов.
 */
export async function cancel(
  id: string,
  operatorId: number,
  operatorName: string,
): Promise<void> {
  return cancelEntry(id, operatorId, operatorName);
}
