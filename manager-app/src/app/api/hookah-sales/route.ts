import { принятьПродажи, продажиМесяца, ставки } from "@/lib/db/hookah";
import type { ПродажаДня } from "@/lib/hookahMotivation";
import { отказПоКлючуПравок } from "@/lib/tipsFixKey";

/**
 * Служебная дверь мотивации кальянного бара: приём продаж с Мака.
 *
 * Присылает `scripts/hookah_push.py`. Тело:
 *
 *   {"продажи": [{"day":"2026-09-07","position":"Кальян на чаше PERFUME МИКС",
 *                 "category":"Perfume чаша","qty":20,"amount":0}]}
 *
 * 🔴 **Категория приходит готовой и здесь НЕ пересчитывается.** Доплата
 * за «ЧМ» положена только в комплекте с электронной чашей (владелец
 * 08.09.2026), а комплект виден по составу чека — до сервера чеки не
 * доезжают. Решение принимается один раз, на Маке. 08.09.2026 три ошибки
 * счёта выросли ровно из того, что одно правило жило в двух местах.
 *
 * ⚠️ **`qty` — это количество, за которое положена ДОПЛАТА**, а не проданное.
 * У электронной чаши внутри комплекта оно ноль: её оплатили через «ЧМ».
 *
 * ⚠️ **День приходит целиком и заменяет прежний.** Не «добавить»: чеки
 * дозревают в ОФД несколько дней, и поздно доехавший чек должен переписать
 * свой день, а не удвоить его.
 */

export const dynamic = "force-dynamic";

const ДЕНЬ = /^\d{4}-\d{2}-\d{2}$/;

function разобрать(сырое: unknown, ошибки: string[]): ПродажаДня | null {
  if (typeof сырое !== "object" || сырое === null) {
    ошибки.push("продажа должна быть объектом");
    return null;
  }
  const п = сырое as Record<string, unknown>;
  const day = String(п.day ?? "");
  if (!ДЕНЬ.test(day)) {
    ошибки.push(`«${day}» — не дата вида ГГГГ-ММ-ДД`);
    return null;
  }
  const position = String(п.position ?? "").trim();
  if (!position) {
    ошибки.push(`${day}: пустое название позиции`);
    return null;
  }
  for (const поле of ["qty", "amount"] as const) {
    if (typeof п[поле] !== "number" || !Number.isFinite(п[поле])) {
      ошибки.push(`${day}, «${position}»: ${поле} — не число`);
      return null;
    }
  }
  return {
    day,
    position,
    category: String(п.category ?? ""),
    qty: п.qty as number,
    amount: п.amount as number,
  };
}

/**
 * Продажи месяца и ставки — для листа УК, который собирает робот.
 *
 *   GET /api/hookah-sales?month=2026-10        ключ X-Tips-Fix-Key
 *
 * Заведено 21.10.2026: блок мотивации в таблице УК берётся отсюда, а не
 * считается роботом по чекам заново. Тогда источник один — эта база, — и дни,
 * посчитанные по отчёту администратора (8–19.10.2026), в листе не затираются.
 * Ставки — из базы, те же, что на странице «Мотивация».
 */
export async function GET(request: Request) {
  const отказ = отказПоКлючуПравок(request);
  if (отказ) return отказ;

  const месяц = new URL(request.url).searchParams.get("month") ?? "";
  if (!/^\d{4}-\d{2}$/.test(месяц)) {
    return Response.json({ ok: false, причина: "month вида 2026-10" }, { status: 400 });
  }
  try {
    const [продажи, ставкиСейчас] = await Promise.all([продажиМесяца(месяц), ставки()]);
    return Response.json({ ok: true, месяц, продажи, ставки: ставкиСейчас });
  } catch (е) {
    return Response.json({ ok: false, причина: `база не ответила: ${(е as Error).message}` },
                         { status: 500 });
  }
}

export async function POST(request: Request) {
  const отказ = отказПоКлючуПравок(request);
  if (отказ) return отказ;

  let тело: unknown;
  try {
    тело = await request.json();
  } catch {
    return Response.json({ ok: false, причина: "тело не разобралось как JSON" },
                         { status: 400 });
  }

  const сырые = (тело as { продажи?: unknown })?.продажи;
  if (!Array.isArray(сырые)) {
    return Response.json({ ok: false, причина: "в теле нет списка «продажи»" },
                         { status: 400 });
  }
  if (сырые.length === 0) {
    return Response.json({ ok: true, записано: 0, замечание: "список пуст" });
  }

  const ошибки: string[] = [];
  const продажи = сырые
    .map((с) => разобрать(с, ошибки))
    .filter((п): п is ПродажаДня => п !== null);

  // Половина записанного хуже, чем ничего: она выглядит как целое.
  if (ошибки.length > 0) {
    return Response.json(
      {
        ok: false,
        причина: "не записано ничего: в присланном есть плохие поля",
        ошибки: ошибки.slice(0, 10),
        всегоОшибок: ошибки.length,
      },
      { status: 400 },
    );
  }

  try {
    const записано = await принятьПродажи(продажи);
    const дни = [...new Set(продажи.map((п) => п.day))].sort();
    return Response.json({ ok: true, записано, дней: дни.length,
                           с: дни[0], по: дни[дни.length - 1] });
  } catch (е) {
    return Response.json({ ok: false, причина: `база не приняла: ${(е as Error).message}` },
                         { status: 500 });
  }
}
