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
 *   — кассир смены: ему уходит доля от 750 ₽.
 * Последние две нужны отчёту: там у каждого своя строка.
 */

const KEY = "chaevye.shift.v2";
const LAST_KEY = "chaevye.shift.last.v2";

export type Shift = {
  crew: number[];
  operator: number | null;
  admin: number | null;
  cashier: number | null;
};

export const EMPTY_SHIFT: Shift = {
  crew: [],
  operator: null,
  admin: null,
  cashier: null,
};

type ShiftsByDay = Record<string, Shift>;

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function getShift(businessDay: string): Shift {
  return read<ShiftsByDay>(KEY, {})[businessDay] ?? EMPTY_SHIFT;
}

export function setShift(businessDay: string, shift: Shift): void {
  const all = read<ShiftsByDay>(KEY, {});
  all[businessDay] = shift;
  window.localStorage.setItem(KEY, JSON.stringify(all));
  window.localStorage.setItem(LAST_KEY, JSON.stringify(shift));
}

/** Прошлая смена — чтобы не собирать состав заново каждый вечер. */
export function getLastShift(): Shift {
  return read<Shift>(LAST_KEY, EMPTY_SHIFT);
}

/** Смена собрана, можно вводить. */
export function isReady(shift: Shift): boolean {
  return shift.crew.length > 0 && shift.operator !== null;
}
