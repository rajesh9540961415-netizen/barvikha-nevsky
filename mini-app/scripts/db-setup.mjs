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

// Показываем адрес, но никогда — пароль.
const shown = url.replace(/\/\/[^@]*@/, "//…@");
console.log(`Подключаюсь: ${shown}`);

const sql = postgres(url, { ssl: "require", connect_timeout: 15 });

try {
  const [{ version }] = await sql`select version()`;
  console.log(`✓ Связь есть: ${version.split(",")[0]}`);

  await sql.unsafe(readFileSync(join(here, "schema.sql"), "utf8"));
  console.log("✓ Таблицы на месте");

  const tables = await sql`
    select table_name, (
      select count(*) from information_schema.columns c
      where c.table_name = t.table_name
    ) as columns
    from information_schema.tables t
    where table_schema = 'public'
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
