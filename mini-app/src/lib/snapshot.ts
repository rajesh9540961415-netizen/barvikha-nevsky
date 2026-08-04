import { readLocal, writeLocal } from "./localStore";
import type { Employee, Entry, Shift } from "./types";

/**
 * Снимок последнего удачного чтения из базы.
 *
 * Зачем он нужен. Очередь отправки спасает то, что ввели, но не помогает
 * открыть приложение: при запуске оно спрашивает у базы состав смены,
 * дописанных вручную людей и записи за вечер. Без сети этот вопрос
 * остаётся без ответа, и раньше администратор упирался в экран
 * «Не удалось загрузить смену» — то есть внести чаевые не мог вовсе.
 *
 * Поэтому каждое удачное чтение откладывается в память телефона. Если
 * при следующем открытии связи нет, приложение поднимается на этом снимке
 * и работать можно дальше.
 *
 * Снимок берётся только за тот же бизнес-день. Вчерашний не годится:
 * сегодняшние записи в нём отсутствуют, и администратор увидел бы пустую
 * смену вместо своих же записей. Пустой экран страшнее отказа — по нему
 * человек решит, что ничего не записалось, и начнёт вводить заново.
 */

const KEY = "chaevye.snapshot.v1";

export type Snapshot = {
  /** Бизнес-день, к которому относится снимок. */
  day: string;
  /** Когда сняли, ISO — это показывают человеку. */
  savedAt: string;
  shift: Shift;
  lastShift: Shift;
  manual: Employee[];
  /** Живые записи за день, как их отдала база. Отменённых здесь нет. */
  entries: Entry[];
};

export function saveSnapshot(snapshot: Omit<Snapshot, "savedAt">): void {
  writeLocal(KEY, { ...snapshot, savedAt: new Date().toISOString() });
}

/** Снимок за этот день. Чужой день не отдаём — он бы врал о суммах. */
export function readSnapshot(day: string): Snapshot | null {
  const saved = readLocal<Snapshot>(KEY);
  if (!saved || saved.day !== day) return null;
  if (!Array.isArray(saved.entries) || !saved.shift) return null;
  return saved;
}
