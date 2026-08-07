/**
 * Выдуманная смена для проверок.
 *
 * Запуск:  npm run seed
 *
 * Нужна, чтобы было что править: экран исправлений нельзя проверить на пустой
 * базе. Данные здесь целиком выдуманы — суммы, столы и порядок событий взяты
 * с потолка. Настоящих денег ресторана в этой базе нет и не будет.
 *
 * ⚠️ Скрипт отказывается работать, если база не на этом компьютере или схема
 * не тестовая. Проверяются оба условия сразу: одной ошибки в строке
 * подключения должно быть мало, чтобы выдумки попали к настоящим деньгам.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
const schema = process.env.DATABASE_SCHEMA;

if (!url) {
  console.error("✗ Не задан DATABASE_URL — он должен лежать в manager-app/.env.local");
  process.exit(1);
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
if (!isLocal) {
  console.error("✗ База не на этом компьютере. Выдуманные записи кладём только");
  console.error("  в свою базу, а не туда, где живут настоящие деньги смены.");
  process.exit(1);
}
if (!schema || schema === "public") {
  console.error("✗ Схема не тестовая. В public лежат боевые данные — туда нельзя.");
  console.error("  В manager-app/.env.local должно быть DATABASE_SCHEMA=test");
  process.exit(1);
}

const sql = postgres(url, {
  ssl: false,
  connection: { search_path: schema },
  onnotice: () => {},
});

/* ─── Кто работает ────────────────────────────────────────────────────
 *
 * Номера настоящие, из справочника Quick Resto: по ним экран найдёт имена
 * в employees.json, как и на боевых данных. Выдуманы только деньги.
 */
const YANA = { id: 911, name: "Яна Миллес" };
const SASHA = { id: 492, name: "Александра Селютина" };
const REGITA = { id: 844, name: "Регита Бактияр" };
const ZHENYA = { id: 900, name: "Евгений Геращенко" };
const ANNA = { id: 822, name: "Анна Кононовская" };

const ALESYA = { id: 697, name: "Алеся Смирнова" };
const ARTEMY = { id: 704, name: "Артемий Воронков" };

const ADMIN = ANNA;

const HALL = { id: 69, title: "Большой зал" };
const SMALL = { id: 68, title: "Малый зал" };

/**
 * Две недели смен — чтобы было видно динамику.
 *
 * Состав меняется от вечера к вечеру намеренно: экран сотрудника обязан
 * показывать смены, в которые человек НЕ выходил, и без разного состава
 * это не проверить. Алеся выходит редко, Артемий появляется только
 * во второй неделе, Регита пропускает три вечера подряд.
 *
 * Суммы заданы списком, а не случайными числами: проверка должна давать
 * один и тот же результат сегодня и через месяц.
 */
const SHIFTS = [
  { day: "2026-07-24", crew: [YANA, SASHA, REGITA], cashier: REGITA,
    tips: [[YANA, 2400], [SASHA, 1780], [REGITA, 990]] },
  { day: "2026-07-25", crew: [YANA, SASHA, REGITA, ZHENYA], cashier: ZHENYA,
    tips: [[YANA, 3100], [SASHA, 2050], [REGITA, 1420], [ZHENYA, 880]] },
  { day: "2026-07-26", crew: [YANA, ZHENYA], cashier: ZHENYA,
    tips: [[YANA, 1950], [ZHENYA, 1310]] },
  { day: "2026-07-28", crew: [SASHA, REGITA, ALESYA], cashier: REGITA,
    tips: [[SASHA, 1640], [REGITA, 2210], [ALESYA, 720]] },
  { day: "2026-07-30", crew: [YANA, SASHA, ZHENYA], cashier: ZHENYA,
    tips: [[YANA, 2760], [SASHA, 1290], [ZHENYA, 1505]] },
  { day: "2026-07-31", crew: [YANA, SASHA, REGITA, ZHENYA, ARTEMY], cashier: ZHENYA,
    tips: [[YANA, 3400], [SASHA, 1870], [REGITA, 1150], [ZHENYA, 2020], [ARTEMY, 640]] },
  { day: "2026-08-01", crew: [YANA, ARTEMY, ALESYA], cashier: ARTEMY,
    tips: [[YANA, 2890], [ARTEMY, 1730], [ALESYA, 1180]] },
  { day: "2026-08-03", crew: [SASHA, REGITA, ZHENYA, ARTEMY], cashier: ZHENYA,
    tips: [[SASHA, 2140], [REGITA, 1690], [ZHENYA, 1260], [ARTEMY, 1980]] },
];

/**
 * Две последние смены расписаны подробно и вручную: на них проверяется
 * всё остальное — порог, поделённые чаевые, питание, отменённая запись.
 * Пятница важна отдельно: там кассиру уходит 1000 ₽, а не 750 ₽.
 */
const THURSDAY = "2026-08-05";
const FRIDAY = "2026-08-06";
const CREW = [YANA, SASHA, REGITA, ZHENYA];
const CASHIER = ZHENYA;

let clock = 0;

/**
 * Одна запись. Время идёт вперёд от начала смены, чтобы история
 * читалась в том же порядке, в каком вносили.
 */
function entry(day, waiter, kind, gross, table, extra = {}) {
  const rate = kind === "terminal" ? 0.08 : 0;
  const amount = rate ? Math.round(gross * (1 - rate) * 100) / 100 : gross;
  const at = new Date(`${day}T17:00:00+03:00`);
  at.setMinutes(at.getMinutes() + clock++ * 7);

  return {
    id: randomUUID(),
    business_day: day,
    hall_id: table ? table.hall.id : null,
    hall_title: table ? table.hall.title : null,
    table_id: table ? table.id : null,
    table_title: table ? table.title : null,
    waiter_id: waiter.id,
    waiter_name: waiter.name,
    amount,
    gross,
    commission_rate: rate,
    kind,
    operator_id: ADMIN.id,
    operator_name: ADMIN.name,
    created_at: at.toISOString(),
    split_group: null,
    ...extra,
  };
}

const t = (hall, id, title) => ({ hall, id, title });

const rows = [];

/* ─── Две недели обычных смен ────────────────────────────────────────
 *
 * Каждому по три записи: наличные, терминал и сервисный сбор. Столы
 * раздаются по кругу — на этих сменах важны не столы, а то, кто в какой
 * вечер выходил и сколько получил.
 */
const TABLES = [
  t(HALL, 1189, "Б3"), t(HALL, 1191, "VIP-3"), t(HALL, 1194, "VIP-5"),
  t(SMALL, 1185, "6"), t(SMALL, 1676, "9"), t(HALL, 1196, "Б11"),
];
let table = 0;

for (const shift of SHIFTS) {
  clock = 0;
  for (const [person, total] of shift.tips) {
    // Раскладываем сумму по видам денег в одной и той же пропорции:
    // половина наличными, треть терминалом, остальное сервисным сбором.
    const cash = Math.round(total * 0.5);
    const terminal = Math.round(total * 0.3);
    const service = total - cash - terminal;
    rows.push(entry(shift.day, person, "cash", cash, TABLES[table++ % TABLES.length]));
    rows.push(entry(shift.day, person, "terminal", terminal, TABLES[table++ % TABLES.length]));
    if (service > 0) {
      rows.push(entry(shift.day, person, "service", service, TABLES[table++ % TABLES.length]));
    }
  }
}

/* ─── Четверг ────────────────────────────────────────────────────────
 *
 * Смена собрана так, чтобы на ней было видно всё, ради чего делается экран:
 * порог 1300 ₽ рядом с обеих сторон, поделённые чаевые, отменённая запись
 * и вычет за питание.
 */

// Отсчёт времени начинаем заново: иначе четверг продолжил бы нумерацию
// предыдущих смен и начался бы под вечер.
clock = 0;

// Яна — уверенно выше порога.
rows.push(entry(THURSDAY, YANA, "cash", 3000, t(HALL, 1189, "Б3")));
rows.push(entry(THURSDAY, YANA, "terminal", 2500, t(HALL, 1191, "VIP-3")));
rows.push(entry(THURSDAY, YANA, "service", 1800, t(HALL, 1191, "VIP-3")));

// Александра — 1250 ₽, чуть НИЖЕ порога. Главный случай для проверки:
// добавь ей полсотни правкой — и пересчитается вся смена.
rows.push(entry(THURSDAY, SASHA, "cash", 800, t(SMALL, 1185, "6")));
rows.push(entry(THURSDAY, SASHA, "cash", 450, t(SMALL, 1676, "9")));

// Регита и Евгений вдвоём держали большой стол: гость оставил 2 500 ₽
// за стол целиком, и запись легла двумя строками по 1 250 ₽.
//
// Время у обеих строк одно: это одно событие, а не два подряд. Так пишет
// приложение смены, и здесь должно быть так же — иначе проверка шла бы
// по данным, каких в жизни не бывает.
const group = randomUUID();
const half = entry(THURSDAY, REGITA, "cash", 1250, t(HALL, 1194, "VIP-5"), {
  split_group: group,
});
rows.push(half);
rows.push(
  entry(THURSDAY, ZHENYA, "cash", 1250, t(HALL, 1194, "VIP-5"), {
    split_group: group,
    created_at: half.created_at,
  }),
);

// Регите ещё немного, чтобы она перешагнула порог, а Евгений остался под ним.
rows.push(entry(THURSDAY, REGITA, "qr", 700, null));

// Питание: вычитается из выплаты и может увести человека в минус.
rows.push(entry(THURSDAY, ZHENYA, "staff", 640, null));

// Отменённая запись: ошиблись столом и отменили тут же, на смене.
// Она должна быть видна в истории перечёркнутой и не попадать в суммы.
const cancelled = entry(THURSDAY, YANA, "cash", 5000, t(HALL, 1196, "Б11"));
// Отменили через три минуты после ввода. Считаем от времени самой записи:
// жёстко заданный час однажды оказался бы раньше, чем запись появилась.
cancelled.deleted_at = new Date(
  new Date(cancelled.created_at).getTime() + 3 * 60_000,
).toISOString();
cancelled.deleted_by_id = ADMIN.id;
cancelled.deleted_by_name = ADMIN.name;
rows.push(cancelled);

/* ─── Пятница ─── смена поменьше, зато кассиру идёт 1000 ₽. */
clock = 0;
rows.push(entry(FRIDAY, YANA, "cash", 2200, t(HALL, 1189, "Б3")));
rows.push(entry(FRIDAY, SASHA, "terminal", 1900, t(SMALL, 1253, "Бар 1")));
rows.push(entry(FRIDAY, REGITA, "service", 900, t(HALL, 1191, "VIP-3")));
rows.push(entry(FRIDAY, ZHENYA, "qr", 1400, null));

// Состав каждой смены: две недели обычных плюс две расписанные подробно.
const crews = [
  ...SHIFTS.map((s) => ({ day: s.day, crew: s.crew, cashier: s.cashier })),
  { day: THURSDAY, crew: CREW, cashier: CASHIER },
  { day: FRIDAY, crew: CREW, cashier: CASHIER },
];
const days = crews.map((c) => c.day);

try {
  await sql.begin(async (tx) => {
    // Начинаем с чистого листа: иначе повторный запуск удвоил бы смены
    // и порог сработал бы там, где на самом деле не сработал.
    await tx`delete from entries       where business_day in ${tx(days)}`;
    await tx`delete from shift_changes where business_day in ${tx(days)}`;
    await tx`delete from shifts        where business_day in ${tx(days)}`;

    for (const c of crews) {
      await tx`
        insert into shifts (business_day, crew, operator_id, admin_id, cashier_id)
        values (
          ${c.day}, ${c.crew.map((p) => p.id)}, ${ADMIN.id},
          ${ADMIN.id}, ${c.cashier.id}
        )
      `;
    }

    for (const r of rows) {
      await tx`insert into entries ${tx(r)}`;
    }
  });

  const [{ count }] = await sql`
    select count(*) from entries where business_day in ${sql(days)}
  `;
  console.log(`✓ Готово: ${count} записей в схеме ${schema}`);
  console.log(`  Смен: ${days.length}, с ${days[0]} по ${FRIDAY}`);
  console.log(`  Подробно расписаны ${THURSDAY} (порог, деление, питание) и ${FRIDAY}`);
  console.log("  Все суммы выдуманы.");
} catch (e) {
  console.error(`✗ Не получилось: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
