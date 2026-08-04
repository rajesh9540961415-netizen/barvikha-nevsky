import postgres from "postgres";

/**
 * Подключение к базе.
 *
 * База общая с приложением смены — та же PostgreSQL на Amvera. Никаких копий
 * и выгрузок между приложениями: у двух копий одних и тех же денег рано или
 * поздно расходятся суммы, и выяснить, какая права, уже нельзя.
 *
 * Живёт только на сервере: браузер с PostgreSQL напрямую не разговаривает,
 * иначе пароль от базы уехал бы в каждый открытый бэк-офис.
 */

let client: ReturnType<typeof postgres> | null = null;

export function db() {
  if (client) return client;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Не задан DATABASE_URL. На сервере строка подключения задаётся " +
        "в переменных приложения в панели Amvera (имя переменной — ровно " +
        "DATABASE_URL), на этом компьютере — в файле manager-app/.env.local",
    );
  }

  const schema = process.env.DATABASE_SCHEMA;

  // Своя база на компьютере разработчика работает без шифрования, и это
  // правильно: трафик не покидает машину. Для всех остальных адресов
  // шифрование включается само.
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

  client = postgres(url, {
    ...(schema ? { connection: { search_path: schema } } : {}),
    ssl: local ? false : "prefer",
    // Бэк-офисом пользуются несколько человек днём, а не вся смена сразу.
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return client;
}
