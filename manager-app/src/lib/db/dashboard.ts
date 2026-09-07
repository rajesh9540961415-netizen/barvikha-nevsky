"use server";

import { db } from "./sql";

/**
 * Дневные итоги для экрана «Обзор».
 *
 * До 07.09.2026 они лежали файлом внутри сборки и обновлялись только вместе
 * с выкладкой. Владелец: «делай живое обновление через базу». Теперь дни
 * лежат в `dashboard_days`, а кладёт их туда `scripts/dashboard_push.py`
 * через служебную дверь `/api/dashboard`.
 *
 * ⚠️ Складываем дни в приложении, а не в базе — намеренно, вопреки правилу
 * из `shifts.ts` «считать в базе». Причина в том, что складывать надо не
 * только числа, но и два поля jsonb: направления и 24 часа. Сложение jsonb
 * в SQL читается вдвое хуже той выгоды, которую даёт: за год строк 365, они
 * маленькие, и тянуть их целиком дешевле, чем однажды не разобраться,
 * что именно считает запрос.
 */

// ⚠️ Не экспортируем ни константы, ни обычные функции: файл помечен
// "use server", и в таком КАЖДЫЙ вывоз обязан быть асинхронной функцией.
// 07.09.2026 вывезенный отсюда расчёт дат уронил разом и страницу, и дверь,
// и соседний /api/health: «Server Actions must be async functions».
const НАПРАВЛЕНИЯ = ["бар", "кухня", "кальяны", "аренда"] as const;
const ПОДПИСЬ_НАПРАВЛЕНИЯ: Record<string, string> = {
  бар: "Бар",
  кухня: "Кухня",
  кальяны: "Кальяны",
  аренда: "Аренда VIP",
};

export type ДеньОбзора = {
  день: string;
  выручка: number;
  чеков: number;
  нал: number;
  безнал: number;
  возвраты: number;
  возвратов: number;
  направления: Record<string, number>;
  часы: number[];
  чаевые: number | null;
};

export type Показатели = {
  выручка: number;
  чеков: number;
  среднийЧек: number;
  нал: number;
  безнал: number;
  долянала: number;
  возвраты: number;
  возвратов: number;
  доляВозвратов: number;
  чаевые: number;
  днейСЧаевыми: number;
  направления: { имя: string; сумма: number; доля: number }[];
  часы: number[];
  дниНедели: number[];
  дней: number;
  днейСЧеками: number;
  с: string;
  по: string;
};

type Строка = {
  business_day: string;
  revenue: string;
  checks: number;
  cash: string;
  cashless: string;
  refunds: string;
  refund_count: number;
  directions: Record<string, number>;
  hours: number[];
  tips: string | null;
};

const ч = (v: string | number | null | undefined): number => Number(v ?? 0);

/** «2026-09-06» из того, что вернул драйвер: date приходит объектом Date. */
function ключДня(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Последний день, за который вообще есть чеки, и когда слепок обновляли. */
export async function состояние(): Promise<{ последний: string | null; обновлено: string | null }> {
  const sql = db();
  const [строка] = await sql<{ последний: unknown; обновлено: Date | null }[]>`
    select max(business_day) as последний, max(updated_at) as обновлено
      from dashboard_days
  `;
  return {
    последний: строка?.последний ? ключДня(строка.последний) : null,
    обновлено: строка?.обновлено ? строка.обновлено.toISOString() : null,
  };
}

export async function дниЗаПериод(с: string, по: string): Promise<ДеньОбзора[]> {
  const sql = db();
  const строки = await sql<Строка[]>`
    select business_day, revenue, checks, cash, cashless,
           refunds, refund_count, directions, hours, tips
      from dashboard_days
     where business_day between ${с}::date and ${по}::date
     order by business_day
  `;
  return строки.map((с) => ({
    день: ключДня(с.business_day),
    выручка: ч(с.revenue),
    чеков: ч(с.checks),
    нал: ч(с.cash),
    безнал: ч(с.cashless),
    возвраты: ч(с.refunds),
    возвратов: ч(с.refund_count),
    направления: с.directions ?? {},
    часы: Array.isArray(с.hours) ? с.hours.map(ч) : [],
    чаевые: с.tips === null ? null : ч(с.tips),
  }));
}

/**
 * Сложить окно [с; по] включительно.
 *
 * Число дней берём как длину окна, а не как «дней с чеками»: заведение
 * работает не каждый день, и делить выручку на дни с чеками значило бы
 * показывать выручку в день выше, чем она была.
 */
export async function заПериод(с: string, по: string): Promise<Показатели> {
  const дни = await дниЗаПериод(с, по);

  let выручка = 0, чеков = 0, нал = 0, безнал = 0;
  let возвраты = 0, возвратов = 0, чаевые = 0, днейСЧаевыми = 0;
  const напр: Record<string, number> = {};
  const часы = new Array(24).fill(0);
  const дниНедели = new Array(7).fill(0);

  for (const д of дни) {
    выручка += д.выручка;
    чеков += д.чеков;
    нал += д.нал;
    безнал += д.безнал;
    возвраты += д.возвраты;
    возвратов += д.возвратов;
    if (д.чаевые !== null) {
      чаевые += д.чаевые;
      днейСЧаевыми += 1;
    }
    for (const н of НАПРАВЛЕНИЯ) напр[н] = (напр[н] ?? 0) + (д.направления[н] ?? 0);
    for (let i = 0; i < 24; i++) часы[i] += д.часы[i] ?? 0;
    // Понедельник первым: неделя начинается с тихого понедельника
    // и кончается субботой, а не наоборот.
    дниНедели[(new Date(д.день + "T12:00:00Z").getUTCDay() + 6) % 7] += д.выручка;
  }

  const суммаНаправлений = Object.values(напр).reduce((a, b) => a + b, 0);
  const дней = Math.round(
    (Date.parse(по + "T12:00:00Z") - Date.parse(с + "T12:00:00Z")) / 86400000) + 1;

  return {
    выручка, чеков,
    среднийЧек: чеков ? выручка / чеков : 0,
    нал, безнал,
    долянала: выручка ? (нал / выручка) * 100 : 0,
    возвраты, возвратов,
    доляВозвратов: выручка ? (возвраты / выручка) * 100 : 0,
    чаевые, днейСЧаевыми,
    направления: НАПРАВЛЕНИЯ.map((н) => ({
      имя: ПОДПИСЬ_НАПРАВЛЕНИЯ[н],
      сумма: напр[н] ?? 0,
      доля: суммаНаправлений ? ((напр[н] ?? 0) / суммаНаправлений) * 100 : 0,
    })).sort((a, b) => b.сумма - a.сумма),
    часы, дниНедели, дней, днейСЧеками: дни.length, с, по,
  };
}

/**
 * Залить дни, присланные с Мака. Один день — одна строка, поверх прежней.
 *
 * Поверх, а не «добавить»: слепок собирается заново из чеков целиком,
 * и поздно доехавший чек должен переписать день, а не удвоить его.
 * Дни, которых в присланном нет, не трогаем — заливать можно кусками.
 */
export async function залить(дни: ДеньОбзора[]): Promise<number> {
  if (дни.length === 0) return 0;
  const sql = db();

  // ⚠️ `sql.json(…)`, а не `JSON.stringify(…)`. 07.09.2026 часы дважды легли
  // в базу СКАЛЯРОМ — строкой «"[0,0,…]"» вместо списка, и `jsonb_typeof`
  // показывал `string`. Драйвер переводит значение в JSON сам, а получив уже
  // переведённое, переводит второй раз. Ошибка тихая: запись проходит, экран
  // не падает, а часы просто перестают складываться.
  //
  // По строке, а не одним запросом: дверь стоит рядом с базой, 516 строк
  // проходят за секунды, а понятная запись дороже этих секунд. Всё внутри
  // одной сделки: половина залитого хуже, чем ничего, — она выглядит целой.
  await sql.begin(async (sql) => {
    for (const д of дни) {
      await sql`
        insert into dashboard_days
          (business_day, revenue, checks, cash, cashless,
           refunds, refund_count, directions, hours, tips, updated_at)
        values
          (${д.день}::date, ${д.выручка}, ${д.чеков}, ${д.нал}, ${д.безнал},
           ${д.возвраты}, ${д.возвратов},
           ${sql.json(д.направления)},
           ${sql.json(д.часы)},
           ${д.чаевые}, now())
        on conflict (business_day) do update set
          revenue      = excluded.revenue,
          checks       = excluded.checks,
          cash         = excluded.cash,
          cashless     = excluded.cashless,
          refunds      = excluded.refunds,
          refund_count = excluded.refund_count,
          directions   = excluded.directions,
          hours        = excluded.hours,
          tips         = excluded.tips,
          updated_at   = excluded.updated_at
      `;
    }
  });
  return дни.length;
}
