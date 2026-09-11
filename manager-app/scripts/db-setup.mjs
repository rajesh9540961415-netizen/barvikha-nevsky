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

// Значение должно быть ТОЛЬКО строкой подключения — проверяем это до того,
// как отдать её разборщику.
//
// ⚠️ Зачем проверка отдельно. 13.08.2026 в переменную попало лишнее: перед
// адресом оказалось имя другой переменной со своим ключом. Наша собственная
// строка журнала пароль спрятала — а вот Node, споткнувшись о разбор,
// напечатал исходное значение ЦЕЛИКОМ, вместе с паролем. Так два секрета
// утекли в журнал приложения, который потом пересылают в переписке.
//
// Отсюда правило: **сомнительное значение не показываем вовсе.** Сказать
// «непохоже на строку подключения» достаточно, чтобы починить, и ничего
// не выдаёт.
if (!/^postgres(ql)?:\/\//.test(url.trim())) {
  console.error("✗ DATABASE_URL не похож на строку подключения.");
  console.error("  Ожидается postgres://пользователь:пароль@адрес:порт/база");
  console.error("  и БОЛЬШЕ НИЧЕГО: ни имени переменной, ни второй строки, ни пробелов.");
  console.error("  Само значение здесь не печатаем — в нём пароль.");
  process.exit(1);
}

// Показываем адрес, но никогда — пароль.
console.log(`Схема базы: подключаюсь к ${url.replace(/\/\/[^@]*@/, "//…@")}`);

const schema = process.env.DATABASE_SCHEMA;
console.log(`Схема: ${schema ?? "public"}`);

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

// Разбор строки — за оградой: если он всё же споткнётся, наружу пойдёт
// объяснение, а не само значение.
let sql;
try {
  sql = postgres(url, {
    ssl: local ? false : "prefer",
    connect_timeout: 15,
    ...(schema ? { connection: { search_path: schema } } : {}),
    // При повторном запуске PostgreSQL сообщает «таблица уже существует».
    // Это ожидаемо — скрипт для того и написан.
    onnotice: () => {},
  });
} catch {
  console.error("✗ Строку подключения не удалось разобрать.");
  console.error("  Проверьте DATABASE_URL в переменных приложения.");
  console.error("  Само значение не печатаем — в нём пароль.");
  process.exit(1);
}

try {
  if (schema) {
    await sql.unsafe(`create schema if not exists "${schema}"`);
    await sql.unsafe(`set search_path to "${schema}"`);
  }

  await sql.unsafe(readFileSync(join(here, "schema.sql"), "utf8"));

  // Дневные итоги «Обзора» — отдельным файлом, см. schema-dashboard.sql.
  // Порядок важен: schema.sql первым, он заводит схему и всё остальное.
  await sql.unsafe(readFileSync(join(here, "schema-dashboard.sql"), "utf8"));

  // Заимствования между площадками — экран «Москва», см. schema-zaimy.sql.
  await sql.unsafe(readFileSync(join(here, "schema-zaimy.sql"), "utf8"));

  // ⚠️ Список полный нарочно, вместе с финансовыми таблицами. Проверка стоит
  // перед запуском (`db-setup && npm start` в Dockerfile) ровно затем, чтобы
  // приложение не поднялось с неполной схемой и не упало потом на живом
  // экране. Таблицу, которой в списке нет, эта проверка не сторожит вовсе —
  // 16.08.2026 так и было: четыре fin_-таблицы отсутствовали в списке,
  // и недостающая обнаружилась бы только глазами владельца.
  const where = schema ?? "public";
  const НУЖНЫ = [
    "entries", "shifts", "manual_people", "qr_tips",
    "managers", "manager_logins", "shift_changes",
    "fin_operations", "fin_days", "fin_revenue", "fin_balances", "fin_sources",
    "dashboard_days", "interbranch_moves",
  ];
  const есть = await sql`
    select table_name from information_schema.tables
     where table_schema = ${where}
       and table_name in ${sql(НУЖНЫ)}
  `;
  console.log(`✓ Схема на месте: ${есть.length} из ${НУЖНЫ.length} таблиц`);

  if (есть.length !== НУЖНЫ.length) {
    // Называем недостающие поимённо: «таблиц меньше» заставляет искать руками,
    // а список сразу говорит, чего ждать от следующей выкладки.
    const найдено = new Set(есть.map((т) => т.table_name));
    console.error(
      `✗ Не хватает таблиц: ${НУЖНЫ.filter((т) => !найдено.has(т)).join(", ")}.`,
    );
    console.error("  Дальше идти нельзя: приложение упадёт на первом же экране.");
    process.exit(1);
  }
} catch (e) {
  console.error(`✗ Схему применить не удалось: ${e.message}`);
  process.exit(1);
} finally {
  await sql.end();
}
