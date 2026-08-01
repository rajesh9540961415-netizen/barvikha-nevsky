import { db } from "@/lib/db/sql";

/**
 * Проверка связи с базой: /api/health
 *
 * Нужна, потому что обычный экран на любую беду отвечает одинаково —
 * «Не удалось загрузить смену». Пользователю в зале этого достаточно,
 * а для починки нужно знать, что именно сломалось: не задан адрес базы,
 * не подошёл пароль или база не отвечает.
 *
 * Строку подключения и пароль наружу не отдаём никогда — только то,
 * чем ответила сама база.
 */

// Ответ не кешируем: проверка должна показывать положение дел сейчас.
export const dynamic = "force-dynamic";

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return Response.json(
      {
        ok: false,
        причина: "переменная DATABASE_URL не задана — приложение не знает, где база",
      },
      { status: 500 },
    );
  }

  try {
    const sql = db();
    const [row] = await sql<{ v: number }[]>`select 1 as v`;
    return Response.json({ ok: row.v === 1, база: "отвечает" });
  } catch (e) {
    const err = e as { message?: string; code?: string };
    return Response.json(
      {
        ok: false,
        код: err.code ?? null,
        причина: err.message ?? "неизвестная ошибка",
      },
      { status: 500 },
    );
  }
}
