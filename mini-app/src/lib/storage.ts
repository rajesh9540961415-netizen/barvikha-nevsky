import {
  cancelEntry,
  distributeQrTip,
  insertEntries,
  listEntries,
  listHistory,
  listPendingQrTips,
} from "./db/actions";
import type { Entry, QrTip } from "./types";

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

/**
 * Сохраняет запись.
 *
 * Строк на вход может прийти несколько: если одни чаевые делят между
 * официантами, на каждого пишется своя доля. Либо сохранятся все, либо
 * ни одной — половина группы хуже, чем ничего.
 */
export async function save(entries: Entry[]): Promise<void> {
  return insertEntries(entries);
}

/**
 * Поступления по QR за смену, которые ещё ждут распределения.
 *
 * Пока поступление не разнесли, деньги ничьи: в заработок они не входят
 * и в итогах смены их нет.
 */
export async function pendingQrTips(businessDay: string): Promise<QrTip[]> {
  return listPendingQrTips(businessDay);
}

/** Разносит поступление по QR на официантов — записи и отметка вместе. */
export async function distributeQr(
  messageId: number,
  entries: Entry[],
  operatorName: string,
): Promise<void> {
  return distributeQrTip(messageId, entries, operatorName);
}

/**
 * Отмена записи.
 *
 * Строку не удаляем, а помечаем отменённой: иначе проверить себя нельзя.
 * Ошибся, отменил, внёс заново — в базе должен остаться след обоих шагов.
 * Поделённые чаевые отменяются группой целиком.
 */
export async function cancel(
  id: string,
  operatorId: number,
  operatorName: string,
): Promise<void> {
  return cancelEntry(id, operatorId, operatorName);
}
