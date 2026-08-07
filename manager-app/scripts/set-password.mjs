/**
 * Выдаёт человеку новый пароль.
 *
 * Запуск:  npm run manager:password -- vika
 *
 * Пароль забывается — это нормально, и восстановить его нельзя ни при каком
 * старании: в базе лежит не пароль, а необратимый отпечаток. Значит
 * единственный способ вернуть человеку доступ — выдать новый.
 *
 * Как и при заведении, пароль придумывает скрипт и печатает один раз.
 * В командной строке его не передают: она сохраняется в истории терминала,
 * и пароль остался бы лежать там в открытом виде.
 */

import { randomBytes, scryptSync } from "node:crypto";
import postgres from "postgres";

const [login] = process.argv.slice(2);

if (!login) {
  console.error("Как пользоваться:  npm run manager:password -- логин");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Не задан DATABASE_URL — искать в manager-app/.env.local");
  process.exit(1);
}

// Показываем, в какой базе меняем, но никогда — пароль от неё. Перепутать
// свою базу с боевой легко, а последствия у этих двух разные.
const schema = process.env.DATABASE_SCHEMA;
console.log(`База: ${url.replace(/\/\/[^@]*@/, "//…@")}`);
console.log(`Схема: ${schema ?? "public (боевая)"}`);

// Те же значения, что в src/lib/auth.ts.
const COST = 32768;
const MAX_MEM = 64 * 1024 * 1024;
const password = randomBytes(9).toString("base64url");
const salt = randomBytes(16).toString("hex");
const hash = scryptSync(password, salt, 64, { N: COST, maxmem: MAX_MEM }).toString("hex");

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

const sql = postgres(url, {
  ...(schema ? { connection: { search_path: schema } } : {}),
  ssl: local ? false : "prefer",
  connect_timeout: 15,
  onnotice: () => {},
});

try {
  const clean = login.trim().toLowerCase();
  const [row] = await sql`
    update managers
       set password_hash = ${`scrypt$${COST}$${salt}$${hash}`}
     where login = ${clean}
    returning name, login, role, active
  `;

  if (!row) {
    console.error(`\n✗ Человека с логином «${clean}» в этой базе нет.`);
    console.error("  Кто заведён:  npm run manager:list");
    process.exit(1);
  }

  console.log(`\n✓ Новый пароль у: ${row.name} · ${row.role === "owner" ? "владелец" : "управляющий"}`);
  console.log();
  console.log(`   логин:  ${row.login}`);
  console.log(`   пароль: ${password}`);
  console.log();
  console.log("Показан один раз — в базе его нет, только отпечаток.");

  // Отключённого человека новый пароль не пустит: доступ снимали намеренно,
  // и вернуть его должна отдельная осознанная команда, а не смена пароля.
  if (!row.active) {
    console.log();
    console.log("⚠️ Этот человек отключён — с новым паролем он всё равно не войдёт.");
  }
} catch (e) {
  console.error(`✗ Не получилось: ${e.message}`);
  process.exit(1);
} finally {
  await sql.end();
}
