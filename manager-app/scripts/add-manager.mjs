/**
 * Заводит человека в бэк-офис.
 *
 * Запуск:  npm run manager:add -- "Виктория Борзова" vika owner
 *
 * Пароль не придумывается человеком и не передаётся в командной строке:
 * скрипт создаёт случайный и печатает один раз. В историю команд он
 * не попадёт, а в базе всё равно лежит не пароль, а его отпечаток.
 */

import { randomBytes, scryptSync } from "node:crypto";
import postgres from "postgres";

const ПОДПИСЬ = { owner: "владелец", manager: "управляющий", finance: "финансист" };

const [name, login, role = "manager"] = process.argv.slice(2);
// Роли: owner — всё; manager — чаевые и смены; finance — только финансы,
// только смотрит (заведена 14.09.2026 под второго участника).

if (!name || !login) {
  console.error('Как пользоваться:  npm run manager:add -- "Имя Фамилия" логин [owner|manager|finance]');
  process.exit(1);
}
if (!["owner", "manager", "finance"].includes(role)) {
  console.error(`Роль бывает owner, manager или finance, а не «${role}»`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Не задан DATABASE_URL — искать в manager-app/.env.local");
  process.exit(1);
}

// Те же значения, что в src/lib/auth.ts. При такой стойкости scrypt просит
// около 33 МБ, а Node по умолчанию даёт 32 — предел поднимаем явно.
const COST = 32768;
const MAX_MEM = 64 * 1024 * 1024;
const password = randomBytes(9).toString("base64url");
const salt = randomBytes(16).toString("hex");
const hash = scryptSync(password, salt, 64, { N: COST, maxmem: MAX_MEM }).toString("hex");

const schema = process.env.DATABASE_SCHEMA;
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
    insert into managers (name, login, password_hash, role)
    values (${name}, ${clean}, ${`scrypt$${COST}$${salt}$${hash}`}, ${role})
    on conflict (login) do nothing
    returning id, name, login, role
  `;

  if (!row) {
    console.error(`Логин «${clean}» уже занят. Другого человека заводите с другим логином.`);
    process.exit(1);
  }

  console.log(`✓ Заведён: ${row.name} · ${ПОДПИСЬ[row.role] ?? row.role}`);
  console.log();
  console.log(`   логин:  ${row.login}`);
  console.log(`   пароль: ${password}`);
  console.log();
  console.log("Пароль показан один раз — в базе его нет, только отпечаток.");
  console.log("Передайте человеку, и пусть он его сменит, когда сможем это сделать.");
} catch (e) {
  console.error(`✗ Не получилось: ${e.message}`);
  process.exit(1);
} finally {
  await sql.end();
}
