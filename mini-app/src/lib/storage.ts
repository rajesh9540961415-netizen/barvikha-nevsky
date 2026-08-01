import { deleteEntry, insertEntry, listEntries } from "./db/actions";
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

/** Записи за один бизнес-день, свежие сверху. */
export async function listByDay(businessDay: string): Promise<Entry[]> {
  return listEntries(businessDay);
}

export async function save(entry: Entry): Promise<void> {
  return insertEntry(entry);
}

export async function remove(id: string): Promise<void> {
  return deleteEntry(id);
}
