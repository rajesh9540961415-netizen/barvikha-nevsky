import type { Entry } from "./types";

/**
 * Хранилище записей.
 *
 * Пока пишем в память браузера (localStorage) — этого хватает, чтобы
 * проверить работу на месте. Когда подключим Supabase, меняется
 * только этот файл: экраны его не увидят.
 */

// Версия в ключе: при изменении состава полей старые записи не подхватываются
// и не ломают экран. v2 — добавились официант и способ оплаты.
const KEY = "chaevye.entries.v2";

function readAll(): Entry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Entry[]) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: Entry[]): void {
  window.localStorage.setItem(KEY, JSON.stringify(entries));
}

/** Записи за один бизнес-день, свежие сверху. */
export function listByDay(businessDay: string): Entry[] {
  return readAll()
    .filter((e) => e.businessDay === businessDay)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function save(entry: Entry): void {
  writeAll([...readAll(), entry]);
}

export function remove(id: string): void {
  writeAll(readAll().filter((e) => e.id !== id));
}
