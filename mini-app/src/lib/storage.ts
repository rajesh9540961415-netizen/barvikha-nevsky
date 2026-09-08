import {
  distributeQrTip,
  listEntries,
  listHistory,
  listPendingQrTips,
  markExported,
  readExportMark,
  readHookahMotivation,
} from "./db/actions";
import type { ExportMark } from "./db/actions";
import type { МотивацияСмены } from "./hookahMotivation";
import { enqueueAndSend } from "./offline";
import type { Entry, QrTip } from "./types";

export type { ExportMark };

/**
 * Хранилище записей.
 *
 * Сами запросы к базе живут в db/actions.ts и выполняются на сервере.
 * Здесь — только то, что видят экраны. Форма функций не менялась с тех пор,
 * когда записи лежали в памяти браузера, поэтому экраны переезда не заметили.
 *
 * Чтение идёт в базу напрямую: без связи читать нечего, и отказ здесь честный.
 * Запись идёт через очередь из offline.ts — сначала на диск телефона, потом
 * в базу. Так запись переживает и пропавшую сеть, и закрытую вкладку.
 */

/** Записи за один бизнес-день, свежие сверху. Отменённые не входят. */
export async function listByDay(businessDay: string): Promise<Entry[]> {
  return listEntries(businessDay);
}

/** То же, но вместе с отменёнными — для экрана истории. */
export async function historyByDay(businessDay: string): Promise<Entry[]> {
  return listHistory(businessDay);
}

/** Когда смену выгружали для отчёта и кто. Пусто — значит ещё ни разу. */
export async function exportMark(businessDay: string): Promise<ExportMark | null> {
  return readExportMark(businessDay);
}

/** Отмечает смену выгруженной. Время ставит база, а не телефон. */
export async function markShiftExported(
  businessDay: string,
  by: string,
): Promise<ExportMark> {
  return markExported(businessDay, by);
}

/**
 * Мотивация кальянного бара за последнюю посчитанную смену.
 *
 * Чтение, и только чтение: сама доплата считается на Маке и приезжает
 * в базу готовой. Без связи экран честно откажет — как и вся история.
 */
export async function hookahMotivation(
  businessDay: string,
): Promise<МотивацияСмены> {
  return readHookahMotivation(businessDay);
}

/**
 * Сохраняет запись.
 *
 * Строк на вход может прийти несколько: если одни чаевые делят между
 * официантами, на каждого пишется своя доля. Либо сохранятся все, либо
 * ни одной — половина группы хуже, чем ничего. Поэтому вся группа — один
 * пункт очереди и одна транзакция в базе: разъехаться им негде.
 *
 * Сначала запись ложится в память телефона, и только потом уходит в базу.
 * Пока связь есть, разницы не видно: функция возвращается после ответа базы,
 * как и раньше. Когда связи нет, она возвращается сразу, а запись ждёт
 * своей очереди — и это видно на экране.
 */
export async function save(entries: Entry[]): Promise<void> {
  return enqueueAndSend({ type: "save", entries });
}

/**
 * Все поступления по QR, которые ещё ждут распределения — включая забытые
 * в прошлые смены.
 *
 * Пока поступление не разнесли, деньги ничьи: в заработок они не входят
 * и в итогах смены их нет. Поэтому забытое не должно пропадать с экрана
 * вместе со сменой — оно всплывает на следующей и висит, пока не разнесут.
 */
export async function pendingQrTips(): Promise<QrTip[]> {
  return listPendingQrTips();
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
 *
 * Тоже через очередь. Отменённая без сети запись пропала бы с экрана, а
 * в базе осталась живой — и деньги разошлись бы с тем, что видел человек.
 * Порядок в очереди строгий, поэтому отмена не может доехать раньше самой
 * записи, даже если обе сделаны без сети подряд.
 */
export async function cancel(
  id: string,
  operatorId: number,
  operatorName: string,
): Promise<void> {
  return enqueueAndSend({ type: "cancel", id, operatorId, operatorName });
}

/**
 * Правка записи текущей смены.
 *
 * Не переписывает строку: старое событие помечается отменённым, новое встаёт
 * рядом со ссылкой на него. В базе это одна транзакция, в очереди — один пункт:
 * разорванная пополам правка оставила бы смену либо без этих денег, либо
 * с ними дважды.
 *
 * Поделённые чаевые правятся группой целиком и делятся заново. Иначе, поправив
 * одну долю с 1250 на 1500, получишь 2750 там, где гость оставил 2500, —
 * и это расхождение никто никогда не заметит.
 */
export async function correct(input: {
  businessDay: string;
  /** Что заменяем: метка группы у поделённых, номер записи у обычной. */
  key: string;
  entries: Entry[];
  operatorId: number;
  operatorName: string;
}): Promise<void> {
  return enqueueAndSend({ type: "correct", ...input });
}
