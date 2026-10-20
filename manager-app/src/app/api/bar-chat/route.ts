import { db } from "@/lib/db/sql";
import { отказПоКлючуПравок } from "@/lib/tipsFixKey";

/**
 * Служебная дверь: что робот прочитал в Telegram про кальянный бар.
 *
 *   GET /api/bar-chat?from=2026-10-08&to=2026-10-19     ключ X-Tips-Fix-Key
 *   GET /api/bar-chat?from=…&to=…&text=1                с текстом отчётов
 *   (то же кириллицей: с=, по=, текст=)
 *
 * Только чтение. Заведено 20.10.2026 (`plans/2026-10-20-bar-iz-telegram.md`):
 * робот живёт в Варшаве и пишет через приложение смены, а увидеть результат
 * надо отсюда, не открывая панель Amvera и не заходя в базу.
 *
 * Ключ тот же, что у `tips-fix`: дверь показывает имена и продажи, то есть
 * не меньше, чем та.
 *
 * По каждому дню:
 *   «состав»    — кто стоит в разделе «КАЛЬЯННЫЙ БАР» и «КМ», опознанные
 *                 по справочнику бара и неопознанные как в чате;
 *   «мотивация» — отчёт администратора по типам;
 *   «доля»      — итог отчёта ÷ число опознанных, до десятых рубля, как
 *                 в листе УК. ⚠️ Только для глаза: неопознанный человек
 *                 сделал бы долю остальных больше настоящей;
 *   «сверка»    — по ТИПАМ с нашими продажами из `hookah_sales`, где они есть.
 *                 Не по итогу: итог сходится и при двух ошибках, гасящих друг
 *                 друга (08.09.2026).
 * И отдельно «источники» — видит ли робот обе группы.
 */

export const dynamic = "force-dynamic";

const ДЕНЬ = /^\d{4}-\d{2}-\d{2}$/;

type Позиция = { тип: string; штук: number; ставка: number; сумма: number };

export async function GET(request: Request) {
  const отказ = отказПоКлючуПравок(request);
  if (отказ) return отказ;

  const адрес = new URL(request.url);
  // Латиницей тоже: кириллица в адресе не через всякий прокси проходит.
  const п = адрес.searchParams;
  const с = п.get("с") ?? п.get("from") ?? "0000-00-00";
  const по = п.get("по") ?? п.get("to") ?? "9999-99-99";
  const сТекстом = (п.get("текст") ?? п.get("text")) === "1";
  if (!ДЕНЬ.test(с) || !ДЕНЬ.test(по)) {
    return Response.json({ ok: false, причина: "«с» и «по» — дни вида 2026-10-08" }, { status: 400 });
  }

  const sql = db();
  try {
    const [составы, мотивации, продажи, источники] = await Promise.all([
      sql<
        {
          business_day: string;
          message_id: string;
          posted_at: Date;
          edited_at: Date | null;
          day_from_text: boolean;
          lines: { зона: string; текст: string }[];
          skeleton: string;
          section_found: boolean;
          zones: number;
          crew: number[];
          names: Record<string, string>;
          unknown: string[];
        }[]
      >`
        select business_day, message_id, posted_at, edited_at, day_from_text, lines,
               skeleton, section_found, zones, crew, names, unknown
          from bar_crew_chat
         where business_day between ${с} and ${по}
      `,
      sql<
        {
          business_day: string;
          message_id: string;
          posted_at: Date;
          edited_at: Date | null;
          day_from_text: boolean;
          items: Позиция[];
          total: string | null;
          remarks: string[];
          text: string;
        }[]
      >`
        select business_day, message_id, posted_at, edited_at, day_from_text, items,
               total, remarks, text
          from bar_motivation_chat
         where business_day between ${с} and ${по}
      `,
      sql<{ business_day: string; category: string; qty: string }[]>`
        select business_day, category, sum(qty) as qty
          from hookah_sales
         where business_day between ${с} and ${по}
         group by business_day, category
      `,
      sql<
        { source: string; chat_id: string | null; title: string | null; seen: boolean; note: string; checked_at: Date }[]
      >`select source, chat_id, title, seen, note, checked_at from tg_sources order by source`,
    ]);

    const дни = [
      ...new Set([...составы.map((r) => r.business_day), ...мотивации.map((r) => r.business_day)]),
    ].sort();

    const наши = new Map<string, Map<string, number>>();
    for (const п of продажи) {
      if (!наши.has(п.business_day)) наши.set(п.business_day, new Map());
      наши.get(п.business_day)!.set(п.category, Number(п.qty));
    }

    const поДням = дни.map((день) => {
      const с = составы.find((r) => r.business_day === день);
      const м = мотивации.find((r) => r.business_day === день);
      const итог = м?.total == null ? null : Number(м.total);
      const людей = с?.crew.length ?? 0;

      // Сверка по типам — только когда есть с чем: продажи бара в базу
      // приезжают с Мака из чеков ОФД, и не за каждый день.
      let сверка: unknown = "наших продаж за этот день в базе нет";
      const нашиДня = наши.get(день);
      if (м && нашиДня) {
        const его = new Map<string, number>();
        for (const п of м.items) его.set(п.тип, (его.get(п.тип) ?? 0) + п.штук);
        const типы = [...new Set([...его.keys(), ...нашиДня.keys()])]
          .filter((т) => т !== "без мотивации" && т !== "")
          .sort();
        сверка = типы.map((т) => {
          const а = его.get(т) ?? 0;
          const б = нашиДня.get(т) ?? 0;
          return { тип: т, уАдминистратора: а, уНас: б, разница: б - а };
        });
      }

      return {
        день,
        состав: с
          ? {
              люди: с.crew.map((id) => ({ номер: id, имя: с.names[String(id)] ?? null })),
              неопознаны: с.unknown,
              строки: с.lines,
              разделНайден: с.section_found,
              зон: с.zones,
              деньИзТекста: с.day_from_text,
              сообщение: Number(с.message_id),
              написано: с.posted_at.toISOString(),
              правлено: с.edited_at?.toISOString() ?? null,
              ...(сТекстом ? { скелет: с.skeleton } : {}),
            }
          : null,
        мотивация: м
          ? {
              итог,
              позиции: м.items,
              замечания: м.remarks,
              деньИзТекста: м.day_from_text,
              сообщение: Number(м.message_id),
              написано: м.posted_at.toISOString(),
              правлено: м.edited_at?.toISOString() ?? null,
              ...(сТекстом ? { текст: м.text } : {}),
            }
          : null,
        доля: итог != null && людей > 0 ? Math.round((итог / людей) * 10) / 10 : null,
        сверка,
      };
    });

    return Response.json({
      ok: true,
      с,
      по,
      источники: источники.map((и) => ({
        что: и.source,
        группа: и.chat_id == null ? null : Number(и.chat_id),
        название: и.title,
        видна: и.seen,
        заметка: и.note,
        проверено: и.checked_at.toISOString(),
      })),
      // Дни периода, за которые нет ни состава, ни отчёта, — чтобы пропуск
      // был виден, а не выглядел как «всё на месте».
      безЗаписей: пропуски(с, по, дни),
      дни: поДням,
    });
  } catch (e) {
    const err = e as { message?: string };
    return Response.json(
      { ok: false, причина: `база не ответила: ${err.message ?? "неизвестно"}` },
      { status: 500 },
    );
  }
}

function пропуски(с: string, по: string, есть: string[]): string[] {
  if (с.startsWith("0000") || по.startsWith("9999")) return [];
  const вышло: string[] = [];
  const d = new Date(`${с}T00:00:00Z`);
  const конец = new Date(`${по}T00:00:00Z`);
  for (let i = 0; d <= конец && i < 400; i++) {
    const день = d.toISOString().slice(0, 10);
    if (!есть.includes(день)) вышло.push(день);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return вышло;
}
