import { отказПоКлючу } from "@/lib/apiKey";
import { listEntries, listManual, readShift } from "@/lib/db/actions";
import { buildExport } from "@/lib/exportShift";
import { getQuickRestoPeople } from "@/lib/people";
import type { Shift } from "@/lib/types";

/**
 * Выдача смены для отчёта: /api/export/2026-08-11
 *
 * Отдаёт ровно тот же JSON, что и кнопка «Выгрузить смену для отчёта».
 * Нужен, чтобы отчёт в Excel собирался сам, а не ждал, пока администратор
 * нажмёт кнопку, принесёт файл на компьютер владельца и там запустит
 * scripts/report_fill.py. Этого не сделал ни разу никто: в отчёте за август
 * на 11.08.2026 заполнена одна ячейка.
 *
 * ⚠️ Почему адрес в приложении, а не чтение базы скриптом на Маке.
 *
 * Деление денег живёт в split.ts: порог 1300 ₽, 20 % администратору, доля
 * кассира. Скрипту на Питоне пришлось бы написать эти правила заново —
 * третьей копией, на другом языке. Две копии уже есть (приложение смены
 * и бэк-офис), и держатся они только проверкой `npm run copies`, которая
 * не даёт бэк-офису запуститься при расхождении. Третью такой проверкой
 * не накрыть, и разошлась бы она молча — в деньгах людей.
 *
 * Здесь же вызывается тот самый `buildExport`, что и под кнопкой. Одни
 * правила, один результат, расходиться нечему.
 *
 * Побочно: компьютеру владельца не нужны ни пароль от боевой базы, ни
 * отключённый VPN. Он ходит по обычному https, как браузер.
 *
 * Ключ передаётся заголовком `X-Export-Key`, а не в адресе: адреса оседают
 * в журналах сервера и в истории команд, и ключ утёк бы туда вместе с ними.
 */

// Ответ не кешируем: смену правят в течение вечера, и вчерашний ответ
// из кеша тихо подсунул бы в отчёт неполные деньги.
export const dynamic = "force-dynamic";

const ПУСТАЯ_СМЕНА: Shift = {
  crew: [],
  operator: null,
  admin: null,
  cashier: null,
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ day: string }> },
) {
  // Проверка ключа общая на все служебные адреса, см. `@/lib/apiKey`.
  const отказ = отказПоКлючу(request);
  if (отказ) return отказ;

  const { day } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return Response.json(
      { ok: false, причина: `день должен быть вида 2026-08-11, а пришло «${day}»` },
      { status: 400 },
    );
  }

  try {
    const [записи, дописанные, смена] = await Promise.all([
      listEntries(day),
      listManual(),
      readShift(day),
    ]);

    // Ровно так же, как на экране: люди из Quick Resto плюс дописанные руками.
    const все = [...getQuickRestoPeople(), ...дописанные];
    const состав = смена ? все.filter((p) => смена.crew.includes(p.id)) : [];

    return Response.json(
      buildExport(day, записи, состав, смена ?? ПУСТАЯ_СМЕНА, все),
    );
  } catch (e) {
    const err = e as { message?: string };
    return Response.json(
      { ok: false, причина: `база не ответила: ${err.message ?? "неизвестно"}` },
      { status: 500 },
    );
  }
}
