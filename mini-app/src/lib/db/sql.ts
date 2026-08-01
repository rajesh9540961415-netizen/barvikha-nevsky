import postgres from "postgres";

/**
 * Подключение к базе.
 *
 * Живёт только на сервере: браузер с PostgreSQL напрямую разговаривать
 * не умеет и не должен — иначе пароль от базы уехал бы на телефон каждому,
 * кто открыл приложение. Экраны обращаются к серверным функциям
 * из actions.ts, а те уже ходят в базу.
 *
 * Строка подключения — в `mini-app/.env.local`, в git не уходит.
 */

let client: ReturnType<typeof postgres> | null = null;

export function db() {
  if (client) return client;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Не задан DATABASE_URL. Строка подключения к базе живёт в mini-app/.env.local",
    );
  }

  client = postgres(url, {
    // Amvera пускает к базе только по шифрованному каналу.
    ssl: "require",
    // Больше и не нужно: приложением пользуются несколько человек в смену.
    max: 5,
    // Не держим соединение открытым вечно: связь в зале может пропасть,
    // и мёртвое соединение молча съело бы первую же запись.
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return client;
}
