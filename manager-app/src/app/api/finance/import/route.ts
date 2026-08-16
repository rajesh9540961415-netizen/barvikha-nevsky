import { отказПоФинансовомуКлючу } from "@/lib/financeKey";
import {
  financeState,
  saveFinance,
  saveFinanceSource,
  type ВходящаяВыручка,
  type ВходящийОстаток,
  type ВходящаяОперация,
  type ВходящийДень,
  type Замена,
} from "@/lib/db/finance";

/**
 * Приём финансовых данных: /api/finance/import
 *
 * План — plans/2026-08-15-razdel-finansy.md, Фаза 1.
 *
 * ⚠️ **Зачем адрес вообще нужен.** Выписки приходят ссылкой в почту владельца,
 * то есть на её Мак. С Мака до этой базы не достучаться: VPN incy перехватывает
 * соединения на порт 5432, пробовали 04.08.2026 и не обошли. Открывать базе
 * внешний доступ ради этого нельзя — в ней фамилии и заработки 17 человек,
 * дверь закрыли 14.08.2026 и открывать обратно не станем.
 *
 * Поэтому Мак разбирает выписку у себя и присылает сюда готовые строки,
 * а в базу пишет приложение — оно с базой в одном дата-центре. Тот же приём
 * год работает на QR-чаевых, см. mini-app/src/app/api/qr-tips/route.ts.
 *
 * Две операции:
 *   GET  — что база уже знает: сколько строк, за какой период, докуда источники;
 *   POST — принять платежи и дни.
 */

// Ответ не кешируем: отправитель спрашивает состояние перед каждой отправкой,
// и ответ из кеша заставил бы его слать уже загруженное по кругу.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const отказ = отказПоФинансовомуКлючу(request);
  if (отказ) return отказ;

  try {
    return Response.json(await financeState());
  } catch (e) {
    const err = e as { message?: string };
    return Response.json(
      { ok: false, причина: `база не ответила: ${err.message ?? "неизвестно"}` },
      { status: 500 },
    );
  }
}

const ДЕНЬ = /^\d{4}-\d{2}-\d{2}$/;

/** Строка или `null`, но не пустая строка: пустая в базе читается как «есть, но пусто». */
function текст(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function число(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Проверка одного платежа. Молча принять кривое — значит испортить деньги.
 *
 * ⚠️ Сумму проверяем на конечность, а не на положительность: направление
 * хранится отдельным полем, и минус в сумме означал бы, что отправитель
 * понял договор иначе. Такое лучше отвергнуть, чем сложить с остальными.
 */
function разобратьОперацию(сырое: unknown): ВходящаяОперация | string {
  if (typeof сырое !== "object" || сырое === null) return "платёж должен быть объектом";
  const п = сырое as Record<string, unknown>;

  if (typeof п.day !== "string" || !ДЕНЬ.test(п.day)) {
    return `day должен быть вида 2026-08-14, а пришло «${String(п.day)}»`;
  }
  if (п.source !== "bank" && п.source !== "cash") {
    return `source должен быть bank или cash, а пришло «${String(п.source)}»`;
  }
  if (п.direction !== "in" && п.direction !== "out") {
    return `direction должен быть in или out, а пришло «${String(п.direction)}»`;
  }

  const amount = Number(п.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return `amount должен быть неотрицательным числом, а пришло «${String(п.amount)}»`;
  }

  // У банковского платежа обязан быть счёт: без него не собрать ключ повтора,
  // и такая строка удвоилась бы при следующей отправке.
  if (п.source === "bank" && текст(п.account) === null) {
    return `у банковского платежа за ${п.day} нет счёта — без него не отличить повтор`;
  }

  return {
    day: п.day,
    source: п.source,
    entity: текст(п.entity),
    account: текст(п.account),
    direction: п.direction,
    amount,
    counterparty: текст(п.counterparty),
    article: текст(п.article),
    opClass: текст(п.opClass),
    purpose: текст(п.purpose),
    docNo: текст(п.docNo),
    why: текст(п.why),
  };
}

function разобратьДень(сырое: unknown): ВходящийДень | string {
  if (typeof сырое !== "object" || сырое === null) return "день должен быть объектом";
  const д = сырое as Record<string, unknown>;

  if (typeof д.day !== "string" || !ДЕНЬ.test(д.day)) {
    return `day должен быть вида 2026-08-14, а пришло «${String(д.day)}»`;
  }

  return {
    day: д.day,
    revenueCard: число(д.revenueCard),
    revenueCash: число(д.revenueCash),
    tablesCount: число(д.tablesCount),
    checksCount: число(д.checksCount),
    balanceTotal: число(д.balanceTotal),
  };
}

/**
 * Строка выручки одного юрлица за один день.
 *
 * ⚠️ Юрлицо обязательно. Пустое означало бы «выручка непонятно чья» — а такая
 * строка на экране разбивки хуже её отсутствия: она выглядит данными.
 */
function разобратьВыручку(сырое: unknown): ВходящаяВыручка | string {
  if (typeof сырое !== "object" || сырое === null) return "выручка должна быть объектом";
  const в = сырое as Record<string, unknown>;

  if (typeof в.day !== "string" || !ДЕНЬ.test(в.day)) {
    return `у выручки day должен быть вида 2026-08-14, а пришло «${String(в.day)}»`;
  }
  const entity = текст(в.entity);
  if (entity === null) {
    return `у выручки за ${в.day} не указано юрлицо — чья она, определить нечем`;
  }

  return {
    day: в.day,
    entity,
    revenueCard: число(в.revenueCard),
    revenueCash: число(в.revenueCash),
    checksCount: число(в.checksCount),
  };
}

/**
 * Остаток на счёте за день.
 *
 * ⚠️ Счёт обязателен: остаток без счёта — это остаток непонятно чего,
 * и на экране он выглядел бы данными, не будучи ими.
 */
function разобратьОстаток(сырое: unknown): ВходящийОстаток | string {
  if (typeof сырое !== "object" || сырое === null) return "остаток должен быть объектом";
  const о = сырое as Record<string, unknown>;

  if (typeof о.day !== "string" || !ДЕНЬ.test(о.day)) {
    return `у остатка day должен быть вида 2026-08-14, а пришло «${String(о.day)}»`;
  }
  const account = текст(о.account);
  if (account === null) {
    return `у остатка за ${о.day} не указан счёт — непонятно, чей это остаток`;
  }

  return {
    day: о.day,
    account,
    entity: текст(о.entity),
    opening: число(о.opening),
    debit: число(о.debit),
    credit: число(о.credit),
    closing: число(о.closing),
  };
}

export async function POST(request: Request) {
  const отказ = отказПоФинансовомуКлючу(request);
  if (отказ) return отказ;

  let тело: unknown;
  try {
    тело = await request.json();
  } catch {
    return Response.json({ ok: false, причина: "тело не разобрать как JSON" }, { status: 400 });
  }

  if (typeof тело !== "object" || тело === null) {
    return Response.json({ ok: false, причина: "тело должно быть объектом" }, { status: 400 });
  }
  const т = тело as Record<string, unknown>;

  const сырыеОперации = Array.isArray(т.operations) ? т.operations : [];
  const сырыеДни = Array.isArray(т.days) ? т.days : [];
  const сыраяВыручка = Array.isArray(т.revenue) ? т.revenue : [];
  const сырыеОстатки = Array.isArray(т.balances) ? т.balances : [];

  // ⚠️ Всё или ничего: одна кривая строка отвергает всю пачку. Принять
  // остальные значило бы записать неполный день и не сказать об этом —
  // а в учёте неполный день неотличим от полного.
  const операции: ВходящаяОперация[] = [];
  for (const сырое of сырыеОперации) {
    const разобрано = разобратьОперацию(сырое);
    if (typeof разобрано === "string") {
      return Response.json({ ok: false, причина: разобрано }, { status: 400 });
    }
    операции.push(разобрано);
  }

  const дни: ВходящийДень[] = [];
  for (const сырое of сырыеДни) {
    const разобрано = разобратьДень(сырое);
    if (typeof разобрано === "string") {
      return Response.json({ ok: false, причина: разобрано }, { status: 400 });
    }
    дни.push(разобрано);
  }

  const выручка: ВходящаяВыручка[] = [];
  for (const сырое of сыраяВыручка) {
    const разобрано = разобратьВыручку(сырое);
    if (typeof разобрано === "string") {
      return Response.json({ ok: false, причина: разобрано }, { status: 400 });
    }
    выручка.push(разобрано);
  }

  const остатки: ВходящийОстаток[] = [];
  for (const сырое of сырыеОстатки) {
    const разобрано = разобратьОстаток(сырое);
    if (typeof разобрано === "string") {
      return Response.json({ ok: false, причина: разобрано }, { status: 400 });
    }
    остатки.push(разобрано);
  }

  if (операции.length === 0 && дни.length === 0) {
    return Response.json(
      { ok: false, причина: "ни одного платежа и ни одного дня — присылать нечего" },
      { status: 400 },
    );
  }

  // Замена наличных за период. Наличные ведутся руками и при перепроверке
  // ИСПРАВЛЯЮТСЯ, поэтому дописывать их нельзя — старая неверная сумма
  // осталась бы рядом с новой. Решение владельца 15.08.2026.
  //
  // ⚠️ Только наличные. Банк стирать нечем и незачем: выписки задним числом
  // не переписываются, а случайно снесённый период банка — это потерянный
  // учёт, который восстанавливать выгрузками заново.
  let замена: Замена | undefined;
  const з = т.replace as Record<string, unknown> | undefined;
  if (з && typeof з === "object") {
    if (з.source !== "cash") {
      return Response.json(
        {
          ok: false,
          причина:
            `заменять можно только наличные, а просят «${String(з.source)}». ` +
            "Банковские выписки задним числом не переписываются, и стирать их период нельзя",
        },
        { status: 400 },
      );
    }
    if (typeof з.from !== "string" || !ДЕНЬ.test(з.from) ||
        typeof з.to !== "string" || !ДЕНЬ.test(з.to)) {
      return Response.json(
        { ok: false, причина: "у замены from и to должны быть датами вида 2026-08-01" },
        { status: 400 },
      );
    }
    if (з.from > з.to) {
      return Response.json(
        { ok: false, причина: `у замены начало ${з.from} позже конца ${з.to}` },
        { status: 400 },
      );
    }
    замена = { source: "cash", from: з.from, to: з.to };
  }

  try {
    const итог = await saveFinance(операции, дни, замена, выручка, остатки);

    // Отметка «докуда доведён источник» — только если её прислали явно.
    // Вывести её из самих строк нельзя: три дня без наличных расходов —
    // это не пробел, а просто три дня без расходов.
    const отметка = т.filledTo as Record<string, unknown> | undefined;
    if (отметка && typeof отметка === "object") {
      for (const [источник, дата] of Object.entries(отметка)) {
        if (typeof дата === "string" && ДЕНЬ.test(дата)) {
          await saveFinanceSource(источник, дата);
        }
      }
    }

    return Response.json({ ok: true, ...итог });
  } catch (e) {
    const err = e as { message?: string };
    return Response.json(
      { ok: false, причина: `не записалось: ${err.message ?? "неизвестно"}` },
      { status: 500 },
    );
  }
}
