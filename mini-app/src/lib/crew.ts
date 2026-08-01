import { readLastShift, readShift, writeShift } from "./db/actions";
import type { Shift } from "./types";

/**
 * Состав смены.
 *
 * Quick Resto не хранит должности — там вперемешку официанты, кухня
 * и служебные учётки. Поэтому смену собирает администратор один раз
 * в начале вечера, а дальше при вводе видит только этих людей.
 *
 * Кроме официантов нужны ещё три роли:
 *   — кто вносит записи: попадает в каждую запись, видно, кто отвечает;
 *   — администратор смены: ему уходят 20 % от заработка официантов;
 *   — кассир смены: ему уходит доля от 750 ₽, а в пятницу и субботу — от 1000 ₽.
 * Последние две нужны отчёту: там у каждого своя строка.
 *
 * Состав лежит в общей базе, а не только на одном телефоне: иначе
 * администратор собрал бы смену у себя, а сменщик открыл бы приложение
 * и увидел пустой экран.
 */

// Тип объявлен в types.ts, чтобы на него мог ссылаться серверный слой базы.
// Здесь оставлен для экранов: они берут его отсюда с самого начала.
export type { Shift } from "./types";

export const EMPTY_SHIFT: Shift = {
  crew: [],
  operator: null,
  admin: null,
  cashier: null,
};

export async function getShift(businessDay: string): Promise<Shift> {
  return (await readShift(businessDay)) ?? EMPTY_SHIFT;
}

export async function setShift(
  businessDay: string,
  shift: Shift,
): Promise<void> {
  return writeShift(businessDay, shift);
}

/** Прошлая смена — чтобы не собирать состав заново каждый вечер. */
export async function getLastShift(): Promise<Shift> {
  return (await readLastShift()) ?? EMPTY_SHIFT;
}

/** Смена собрана, можно вводить. Проверка чистая, база для неё не нужна. */
export function isReady(shift: Shift): boolean {
  return shift.crew.length > 0 && shift.operator !== null;
}
