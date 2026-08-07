/**
 * Кто заведён в бэк-офис.
 *
 * Запуск:  npm run manager:list
 *
 * Паролей здесь нет и быть не может — в базе лежат только отпечатки.
 * Скрипт отвечает на другой вопрос: под каким логином вообще заходить
 * и не отключили ли человека.
 */

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Не задан DATABASE_URL — искать в manager-app/.env.local");
  process.exit(1);
}

const schema = process.env.DATABASE_SCHEMA;
console.log(`База: ${url.replace(/\/\/[^@]*@/, "//…@")}`);
console.log(`Схема: ${schema ?? "public (боевая)"}\n`);

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

const sql = postgres(url, {
  ...(schema ? { connection: { search_path: schema } } : {}),
  ssl: local ? false : "prefer",
  connect_timeout: 15,
  onnotice: () => {},
});

try {
  const rows = await sql`
    select m.login, m.name, m.role, m.active, max(l.at) filter (where l.ok) as last_in
      from managers m
      left join manager_logins l on l.manager_id = m.id
     group by m.id
     order by m.id
  `;

  if (rows.length === 0) {
    console.log("Никого нет. Завести:  npm run manager:add -- \"Имя Фамилия\" логин owner");
  }

  for (const r of rows) {
    const role = r.role === "owner" ? "владелец  " : "управляющий";
    const state = r.active ? "  " : " ⛔ отключён";
    const seen = r.last_in
      ? `заходил ${r.last_in.toLocaleDateString("ru-RU")}`
      : "ни разу не заходил";
    console.log(`  ${r.login.padEnd(12)} ${role} ${r.name.padEnd(20)} ${seen}${state}`);
  }

  console.log("\nЗабыли пароль — выдать новый:  npm run manager:password -- логин");
} catch (e) {
  console.error(`✗ Не получилось: ${e.message}`);
  process.exit(1);
} finally {
  await sql.end();
}
