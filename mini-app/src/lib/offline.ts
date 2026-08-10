import { cancelEntry, insertEntries, writeShift } from "./db/actions";
import { readLocal, hasLocalStore, writeLocal } from "./localStore";
import type { Entry, Shift } from "./types";

/**
 * Очередь отправки — то, что позволяет работать без сети.
 *
 * Как это устроено. Любое изменение сначала кладётся в очередь в памяти
 * телефона и только потом отправляется в базу. Получилось отправить — ушло
 * из очереди. Не получилось — осталось ждать и уйдёт само, когда связь
 * вернётся. Поэтому запись не пропадает ни от пропавшей сети, ни от закрытой
 * вкладки, ни от перезагрузки телефона: она уже на диске.
 *
 * Порядок строгий — что положили раньше, то и уйдёт раньше. Это важно:
 * отмена записи не должна доехать до базы раньше самой записи, иначе
 * отменять будет нечего и запись останется живой.
 *
 * Повтор не задваивает деньги. Номер записи придумывает сам браузер ещё
 * до отправки, а база вставляет строку «если такой ещё нет». Поэтому
 * отправить одно и то же дважды безопасно: во второй раз ничего не
 * произойдёт. Это главная защита от случая «отправили, ответ не дошёл,
 * отправили снова».
 */

/** Что именно ждёт отправки. */
export type QueuedOp =
  | { type: "save"; entries: Entry[] }
  | { type: "cancel"; id: string; operatorId: number; operatorName: string }
  | { type: "shift"; businessDay: string; shift: Shift };

export type QueueItem = {
  /** Свой номер — чтобы отличать пункты очереди друг от друга. */
  opId: string;
  /** Когда положили в очередь, ISO. */
  queuedAt: string;
  /** Сколько раз пытались отправить: видно, что дело не идёт. */
  attempts: number;
  lastError: string | null;
  op: QueuedOp;
};

export type QueueState = {
  items: QueueItem[];
  /** Прямо сейчас идёт отправка. */
  sending: boolean;
  /** Чем закончилась последняя неудача — это показывают человеку. */
  lastError: string | null;
  /** Когда очередь в последний раз ушла целиком, ISO. */
  lastSentAt: string | null;
  /**
   * Память телефона недоступна — например, запрещено хранение в настройках
   * браузера. Тогда очередь живёт только пока открыта вкладка, и об этом
   * надо сказать прямо: обещание «ничего не потеряется» здесь не работает.
   */
  durable: boolean;
  /**
   * Приложение обновилось, а эта страница осталась от прошлой версии.
   *
   * Отдельно от обычной ошибки намеренно: все прочие беды проходят сами,
   * когда вернётся связь, а эта не пройдёт никогда. Очередь будет упорно
   * повторять то, что сервер уже не примет, и человек увидит растущее
   * «не отправлено» без единой подсказки, что делать.
   *
   * Лечится только перезагрузкой страницы. Записи при этом не теряются:
   * очередь лежит в памяти телефона и уйдёт сразу после обновления.
   */
  needsReload: boolean;
};

/**
 * Та самая ошибка: «Failed to find Server Action …».
 *
 * Next.js даёт каждой сборке свои внутренние адреса для серверных действий.
 * Страница, открытая до выкладки, помнит старые, и новый сервер их не знает.
 * Поймано в бою 10.08.2026 сразу после выкладки.
 */
export function isStaleDeploy(error: unknown): boolean {
  const text =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /Failed to find Server Action/i.test(text);
}

const KEY = "chaevye.outbox.v1";

/**
 * Сколько ждать ответа базы, прежде чем отпустить экран.
 *
 * Когда сети нет совсем, браузер отказывает мгновенно и ждать нечего.
 * Но в зале бывает хуже: сеть вроде есть, а запрос висит. Держать в это
 * время администратора перед надписью «сохраняю…» нельзя — запись уже
 * в очереди и никуда не денется, поэтому через шесть секунд экран
 * отпускаем, а отправка продолжается сама.
 */
export const SEND_TIMEOUT_MS = 6000;

let state: QueueState = {
  items: [],
  sending: false,
  lastError: null,
  lastSentAt: null,
  durable: true,
  needsReload: false,
};

let loaded = false;
const listeners = new Set<() => void>();

function load(): void {
  if (loaded) return;
  loaded = true;
  state = { ...state, durable: hasLocalStore() };
  const saved = readLocal<QueueItem[]>(KEY);
  if (Array.isArray(saved)) {
    state = { ...state, items: saved.filter(looksLikeItem) };
  }
}

/**
 * Проверка на всякий случай: в памяти телефона могло остаться содержимое
 * от старой версии приложения. Пропускаем только то, что умеем отправить.
 */
function looksLikeItem(item: unknown): item is QueueItem {
  if (!item || typeof item !== "object") return false;
  const op = (item as QueueItem).op;
  if (!op || typeof op !== "object") return false;
  return op.type === "save" || op.type === "cancel" || op.type === "shift";
}

function persist(): void {
  const ok = writeLocal(KEY, state.items);
  if (!ok && state.durable) {
    // Память отказала на ходу — чаще всего кончилось место. Молчать нельзя:
    // человек считает, что запись сохранена на телефоне, а её там нет.
    state = { ...state, durable: false };
  }
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // Сбой на перерисовке экрана не должен ломать отправку очереди:
      // экран — дело поправимое, деньги — нет.
    }
  }
}

function patch(next: Partial<QueueState>): void {
  state = { ...state, ...next };
  notify();
}

/** Текущее состояние очереди. */
export function queueState(): QueueState {
  load();
  return state;
}

/**
 * То же самое для отрисовки на сервере: там памяти телефона нет, и очередь
 * всегда пуста. Значение одно и то же на все вызовы — иначе React решил бы,
 * что состояние меняется на каждом шаге, и перерисовывал бы экран без конца.
 */
const EMPTY_ON_SERVER: QueueState = {
  items: [],
  sending: false,
  lastError: null,
  lastSentAt: null,
  durable: true,
  needsReload: false,
};

export function queueStateOnServer(): QueueState {
  return EMPTY_ON_SERVER;
}

/** Подписка на изменения — экран перерисовывается, когда очередь меняется. */
export function subscribeQueue(fn: () => void): () => void {
  load();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Кладёт изменение в очередь. Возвращает управление сразу — диск уже записан. */
export function enqueue(op: QueuedOp): QueueItem {
  load();
  const item: QueueItem = {
    opId: crypto.randomUUID(),
    queuedAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    op,
  };
  state = { ...state, items: [...state.items, item] };
  persist();
  notify();
  return item;
}

async function send(op: QueuedOp): Promise<void> {
  switch (op.type) {
    case "save":
      return insertEntries(op.entries);
    case "cancel":
      return cancelEntry(op.id, op.operatorId, op.operatorName);
    case "shift":
      return writeShift(op.businessDay, op.shift);
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "нет связи";
}

let running: Promise<void> | null = null;

/**
 * Отправляет очередь.
 *
 * Одновременно идёт не больше одной отправки: если вызвать во второй раз,
 * вернётся та же самая, уже начатая. Иначе таймер и нажатие человека
 * отправили бы одно и то же дважды.
 */
export function flushQueue(): Promise<void> {
  if (running) return running;
  running = drain().finally(() => {
    running = null;
    // Подстраховка: что бы ни случилось внутри, надпись «Отправляю…»
    // не должна остаться на экране навсегда.
    if (state.sending) patch({ sending: false });
  });
  return running;
}

async function drain(): Promise<void> {
  load();
  if (state.items.length === 0) return;
  // Браузер точно знает, когда сети нет. Обратное он знает плохо (бывает
  // «сеть есть», а интернета нет), поэтому доверяем только отрицательному
  // ответу: он избавляет от заведомо бесполезной попытки.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    patch({ sending: false, lastError: "нет сети" });
    return;
  }

  patch({ sending: true, lastError: null });

  // Строго по одному и строго по порядку. Параллельно нельзя: отмена
  // обогнала бы свою запись, а второй половине поделённых чаевых нечего
  // было бы отменять.
  while (state.items.length > 0) {
    const item = state.items[0];
    try {
      await send(item.op);
    } catch (error) {
      const text = errorText(error);
      // Пункт остаётся на месте, попытки считаем. Дальше по очереди
      // не идём намеренно: порядок важнее скорости.
      state = {
        ...state,
        items: [
          { ...item, attempts: item.attempts + 1, lastError: text },
          ...state.items.slice(1),
        ],
      };
      persist();
      // Страница осталась от прошлой версии — повторять бессмысленно, сервер
      // не примет это никогда. Поднимаем отдельный признак: полоса покажет
      // не «не отправлено», а «обновите страницу», и это единственная беда,
      // где от человека действительно что-то требуется.
      patch({
        sending: false,
        lastError: text,
        needsReload: state.needsReload || isStaleDeploy(error),
      });
      return;
    }
    state = { ...state, items: state.items.slice(1) };
    persist();
    notify();
  }

  patch({
    sending: false,
    lastError: null,
    lastSentAt: new Date().toISOString(),
  });
}

/**
 * Кладёт изменение в очередь и пытается отправить сразу.
 *
 * Ждём ответа, но не дольше SEND_TIMEOUT_MS: пока сеть есть, всё происходит
 * как раньше — экран закрывается после того, как база подтвердила запись.
 * Когда сети нет, ждать нечего, и экран освобождается сразу.
 *
 * Ошибку наружу не отдаём намеренно: запись сохранена на телефоне и уйдёт
 * сама. Сказать «не сохранилось» было бы неправдой, и администратор внёс бы
 * те же чаевые второй раз.
 */
export async function enqueueAndSend(op: QueuedOp): Promise<void> {
  const item = enqueue(op);
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  await Promise.race([
    flushQueue().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, SEND_TIMEOUT_MS)),
  ]);
  // Отправка могла закончиться ровно между тем, как мы положили пункт
  // в очередь, и тем, как она проверила очередь в последний раз. Тогда наш
  // пункт остался бы ждать таймера. Толкаем ещё раз, ответа не ждём.
  if (state.items.some((i) => i.opId === item.opId)) {
    void flushQueue().catch(() => undefined);
  }
}

/**
 * Записи из очереди, которые относятся к этому дню.
 *
 * Нужны экранам: пока запись не ушла, она всё равно должна быть видна
 * и входить в итог смены. Иначе администратор увидит сумму меньше
 * настоящей и начнёт вводить заново поверх уже введённого.
 */
export function pendingEntries(items: QueueItem[], day: string): Entry[] {
  const rows: Entry[] = [];
  for (const item of items) {
    if (item.op.type !== "save") continue;
    for (const entry of item.op.entries) {
      if (entry.businessDay === day) rows.push(entry);
    }
  }
  return rows;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Что именно ждёт отправки, словами: «2 записи и 1 отмена».
 *
 * Одним числом сказать нельзя: отмена — тоже пункт очереди, и надпись
 * «4 записи, из них 5 не ушли» получилась бы арифметически невозможной.
 * Считаем раздельно и называем своими именами.
 */
export function pendingSummary(items: QueueItem[]): string {
  let saves = 0;
  let cancels = 0;
  let shifts = 0;
  for (const item of items) {
    if (item.op.type === "save") saves += 1;
    else if (item.op.type === "cancel") cancels += 1;
    else shifts += 1;
  }
  const parts: string[] = [];
  if (saves > 0) {
    parts.push(`${saves} ${plural(saves, "запись", "записи", "записей")}`);
  }
  if (cancels > 0) {
    parts.push(`${cancels} ${plural(cancels, "отмена", "отмены", "отмен")}`);
  }
  if (shifts > 0) parts.push("состав смены");
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} и ${parts[parts.length - 1]}`;
}

/**
 * Складывает то, что пришло из базы, с тем, что ещё ждёт отправки.
 *
 * Правила простые:
 *   — записи из базы главнее: если запись уже доехала, берём её версию;
 *   — ждущие отправки добавляются, если такой ещё нет;
 *   — отмены из очереди убирают запись из списка, а поделённые — всей группой,
 *     как это делает база.
 *
 * Совпадение ищем по номеру записи. Он придуман браузером до отправки
 * и не меняется, поэтому запись, только что доехавшая до базы, не может
 * посчитаться дважды.
 */
export function mergeEntries(
  fromDb: Entry[],
  items: QueueItem[],
  day: string,
): Entry[] {
  const byId = new Map<string, Entry>();
  for (const entry of fromDb) {
    if (entry.businessDay === day) byId.set(entry.id, entry);
  }
  for (const entry of pendingEntries(items, day)) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }

  for (const item of items) {
    if (item.op.type !== "cancel") continue;
    const target = byId.get(item.op.id);
    if (!target) continue;
    if (target.splitGroup) {
      for (const [id, entry] of byId) {
        if (entry.splitGroup === target.splitGroup) byId.delete(id);
      }
    } else {
      byId.delete(item.op.id);
    }
  }

  // Свежие сверху — тем же порядком, что отдаёт база. Время записано
  // строкой вида 2026-08-04T21:47:00.000Z, поэтому обычное сравнение
  // строк совпадает с хронологическим.
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
