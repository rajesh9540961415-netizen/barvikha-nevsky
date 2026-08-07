/**
 * Приводит базу в соответствие со схемой. Запускается при старте бэк-офиса.
 *
 * Почему при старте, а не руками. С компьютера владельца боевая база
 * недоступна: VPN incy перехватывает соединения на порт 5432, и обойти это
 * не вышло (пробовали 04.08.2026). А бэк-офис живёт в том же дата-центре,
 * что и база, и достаёт её без всяких сложностей. Значит применить схему
 * должен он.
 *
 * Почему это не страшно. Схема написана целиком через «создать, если ещё
 * нет»: она ничего не удаляет и не переписывает, только добавляет
 * недостающее. Её для того и писали такой, чтобы запускать сколько угодно
 * раз — приложение смены делает ровно то же самое командой npm run db:setup.
 *
 * Если схему применить не удалось, приложение не запускается. Это нарочно:
 * бэк-офис без нужных колонок не работает, а падает на первом же экране —
 * и разбираться тогда пришлось бы не с понятной строкой в журнале, а
 * с невнятной ошибкой посреди правки денег.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ Не задан DATABASE_URL.");
  console.error("  На сервере он задаётся в переменных приложения в панели Amvera.");
  process.exit(1);
}

// Показываем адрес, но никогда — пароль.
console.log(`Схема базы: подключаюсь к ${url.replace(/\/\/[^@]*@/, "//…@")}`);

const schema = process.env.DATABASE_SCHEMA;
console.log(`Схема: ${schema ?? "public"}`);

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

const sql = postgres(url, {
  ssl: local ? false : "prefer",
  connect_timeout: 15,
  ...(schema ? { connection: { search_path: schema } } : {}),
  // При повторном запуске PostgreSQL сообщает «таблица уже существует».
  // Это ожидаемо — скрипт для того и написан.
  onnotice: () => {},
});

try {
  if (schema) {
    await sql.unsafe(`create schema if not exists "${schema}"`);
    await sql.unsafe(`set search_path to "${schema}"`);
  }

  await sql.unsafe(readFileSync(join(here, "schema.sql"), "utf8"));

  const where = schema ?? "public";
  const [{ count }] = await sql`
    select count(*) from information_schema.tables
     where table_schema = ${where}
       and table_name in ('entries', 'shifts', 'manual_people',
                          'qr_tips', 'managers', 'manager_logins',
                          'shift_changes')
  `;
  console.log(`✓ Схема на месте: ${count} из 7 таблиц`);

  if (Number(count) !== 7) {
    console.error("✗ Таблиц меньше, чем должно быть. Дальше идти нельзя.");
    process.exit(1);
  }
} catch (e) {
  console.error(`✗ Схему применить не удалось: ${e.message}`);
  process.exit(1);
} finally {
  await sql.end();
}
