import { отказПоКлючу } from "@/lib/apiKey";
import { qrTipsState, saveQrTips, type ВходящееQr } from "@/lib/db/actions";

/**
 * Приём чаевых по QR от читателя Telegram: /api/qr-tips
 *
 * ⚠️ Зачем он вообще понадобился — 13.08.2026.
 *
 * Читатель уведомлений Сбера жил в Москве и писал в базу напрямую. Оказалось,
 * что РКН периодически режет соединения к дата-центрам Telegram из российских
 * регионов: с 4 августа читатель не прочитал ни одного поступления, а это
 * около 1 080 ₽ в день мимо учёта. Amvera подтвердила и посоветовала перенести
 * приложение в Варшаву.
 *
 * В Варшаве Telegram отвечает сразу — но там не разрешается внутреннее имя
 * московской базы: она видна только внутри своего региона.
 *
 * Открывать базе внешний доступ ради этого нельзя: в ней фамилии и заработки
 * 17 человек. Поэтому читатель ходит сюда по обычному https, а в базу пишет
 * приложение — оно с базой в одном дата-центре.
 *
 * 💡 Побочная выгода, которая важнее удобства: **через границу теперь едет
 * только сумма, котёл («Официант 2») и время.** Персональных данных в этом
 * потоке нет вовсе. При прямом доступе к базе за рубежом оказалась бы вся она.
 *
 * Две операции, зеркально тому, что читатель делал с базой сам:
 *   GET  — что база уже знает: номер последнего сообщения и время последнего;
 *   POST — записать прочитанное.
 */

// Ответ не кешируем: читатель спрашивает состояние каждую минуту, и ответ
// из кеша заставил бы его перечитывать одно и то же по кругу.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const отказ = отказПоКлючу(request);
  if (отказ) return отказ;

  try {
    return Response.json(await qrTipsState());
  } catch (e) {
    const err = e as { message?: string };
    return Response.json(
      { ok: false, причина: `база не ответила: ${err.message ?? "неизвестно"}` },
      { status: 500 },
    );
  }
}

/** Проверка одного поступления. Молча принять кривое — значит испортить деньги. */
function разобрать(сырое: unknown): ВходящееQr | string {
  if (typeof сырое !== "object" || сырое === null) return "поступление должно быть объектом";
  const п = сырое as Record<string, unknown>;

  const messageId = Number(п.messageId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return `messageId должен быть целым числом, а пришло «${String(п.messageId)}»`;
  }

  const amount = Number(п.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return `amount должен быть положительным числом, а пришло «${String(п.amount)}»`;
  }

  if (typeof п.businessDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(п.businessDay)) {
    return `businessDay должен быть вида 2026-08-13, а пришло «${String(п.businessDay)}»`;
  }

  if (typeof п.receivedAt !== "string" || Number.isNaN(Date.parse(п.receivedAt))) {
    return `receivedAt должен быть временем, а пришло «${String(п.receivedAt)}»`;
  }

  if (typeof п.team !== "string" || п.team.trim() === "") {
    return "team не должен быть пустым";
  }

  return {
    messageId,
    receivedAt: п.receivedAt,
    businessDay: п.businessDay,
    amount,
    team: п.team,
  };
}

export async function POST(request: Request) {
  const отказ = отказПоКлючу(request);
  if (отказ) return отказ;

  let тело: unknown;
  try {
    тело = await request.json();
  } catch {
    return Response.json({ ok: false, причина: "тело не разобрать как JSON" }, { status: 400 });
  }

  const список = (тело as { tips?: unknown })?.tips;
  if (!Array.isArray(список)) {
    return Response.json(
      { ok: false, причина: "ожидается объект вида { tips: [...] }" },
      { status: 400 },
    );
  }

  // Разбираем ВСЁ до записи: пачка либо ложится целиком, либо не ложится вовсе.
  // Записать половину и отказать по второй половине — худший исход: читатель
  // сдвинет отметку и остаток потеряется молча.
  const готовые: ВходящееQr[] = [];
  for (const [i, сырое] of список.entries()) {
    const разобранное = разобрать(сырое);
    if (typeof разобранное === "string") {
      return Response.json(
        { ok: false, причина: `поступление №${i + 1}: ${разобранное}` },
        { status: 400 },
      );
    }
    готовые.push(разобранное);
  }

  try {
    const добавлено = await saveQrTips(готовые);
    return Response.json({ ok: true, принято: готовые.length, добавлено });
  } catch (e) {
    const err = e as { message?: string };
    return Response.json(
      { ok: false, причина: `база не ответила: ${err.message ?? "неизвестно"}` },
      { status: 500 },
    );
  }
}
