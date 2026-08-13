/**
 * Создаёт таблицы в базе и проверяет связь.
 *
 * Запуск:  npm run db:setup
 *
 * Строку подключения берёт из mini-app/.env.local, на экран её не печатает.
 * Выполнять можно сколько угодно раз — уже созданное не трогается.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ Не задан DATABASE_URL.");
  console.error("  Строка подключения должна лежать в mini-app/.env.local");
  process.exit(1);
}

// Значение должно быть ТОЛЬКО строкой подключения — проверяем это до того,
// как отдать её разборщику.
//
// ⚠️ 13.08.2026 в такую переменную у бэк-офиса попало лишнее: перед адресом
// оказалось имя другой переменной со своим ключом. Собственная строка журнала
// пароль спрятала — а Node, споткнувшись о разбор, напечатал исходное значение
// ЦЕЛИКОМ. Так два секрета утекли в журнал приложения.
//
// Правило: **сомнительное значение не показываем вовсе.**
if (!/^postgres(ql)?:\/\//.test(url.trim())) {
  console.error("✗ DATABASE_URL не похож на строку подключения.");
  console.error("  Ожидается postgres://пользователь:пароль@адрес:порт/база");
  console.error("  и БОЛЬШЕ НИЧЕГО: ни имени переменной, ни второй строки, ни пробелов.");
  console.error("  Само значение здесь не печатаем — в нём пароль.");
  process.exit(1);
}

// Показываем адрес, но никогда — пароль.
const shown = url.replace(/\/\/[^@]*@/, "//…@");
console.log(`Подключаюсь: ${shown}`);

// Тестовая схема: та же база, но отдельный набор таблиц. Боевые данные
// лежат в public и этим скриптом не затрагиваются.
const schema = process.env.DATABASE_SCHEMA;
if (schema) console.log(`Схема: ${schema} (тестовая, не боевая)`);

// Своя база на этом компьютере работает без шифрования — и это правильно:
// трафик не покидает машину, шифровать нечего. Для всех остальных адресов
// шифрование обязательно: там строка подключения идёт через интернет.
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

const sql = postgres(url, {
  ssl: isLocal ? false : "require",
  connect_timeout: 15,
  ...(schema ? { connection: { search_path: schema } } : {}),
  // При повторном запуске PostgreSQL сообщает «таблица уже существует».
  // Это ожидаемо — скрипт для того и написан, чтобы его можно было
  // запускать сколько угодно раз. Но выглядело бы как ошибка.
  onnotice: () => {},
});

try {
  const [{ version }] = await sql`select version()`;
  console.log(`✓ Связь есть: ${version.split(",")[0]}`);

  if (schema) {
    await sql.unsafe(`create schema if not exists "${schema}"`);
    await sql.unsafe(`set search_path to "${schema}"`);
    console.log(`✓ Схема ${schema} на месте`);
  }

  await sql.unsafe(readFileSync(join(here, "schema.sql"), "utf8"));
  console.log("✓ Таблицы на месте");

  const where = schema ?? "public";
  const tables = await sql`
    select table_name, (
      select count(*) from information_schema.columns c
      where c.table_name = t.table_name and c.table_schema = ${where}
    ) as columns
    from information_schema.tables t
    where table_schema = ${where}
      and table_name in ('entries', 'shifts', 'manual_people')
    order by table_name
  `;
  for (const t of tables) {
    console.log(`  ${t.table_name} — ${t.columns} колонок`);
  }

  if (tables.length !== 3) {
    console.error(`✗ Ожидались 3 таблицы, нашлось ${tables.length}`);
    process.exit(1);
  }

  console.log("\nГотово. База настроена.");
} catch (e) {
  console.error(`✗ Не получилось: ${e.message}`);
  process.exit(1);
} finally {
  await sql.end();
}
