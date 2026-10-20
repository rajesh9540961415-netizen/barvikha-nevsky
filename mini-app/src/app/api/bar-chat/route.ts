import { отказПоКлючу } from "@/lib/apiKey";
import {
  barChatState,
  saveBarChat,
  type ВходящаяМотивация,
  type ВходящийИсточник,
  type ВходящийСостав,
} from "@/lib/db/barChat";

/**
 * Приём состава и мотивации кальянного бара от читателя Telegram: /api/bar-chat
 *
 * Заведено 20.10.2026 по образцу `/api/qr-tips`: тот же варшавский робот,
 * тот же ключ `EXPORT_KEY`, те же правила — всё проверяется до записи,
 * и пачка ложится целиком или не ложится вовсе.
 *
 * Что приходит:
 *   «состав»    — строки раздела «КАЛЬЯННЫЙ БАР» и «КМ» из «РАСПРЕДЕЛЕНИЯ»
 *                 в «НЕВСКИЙ | ОБЩИЙ ЧАТ». Имена опознаёт приложение
 *                 по справочнику бара (`src/lib/barChat.ts`);
 *   «мотивация» — отчёт «Мотивация кальянного бара» из «НЕВСКИЙ | АДМИН»,
 *                 уже разобранный по типам (`tg-reader/bar_parse.py`);
 *   «источники» — видит ли робот эти группы вообще.
 *
 * ⚠️ В отличие от QR, здесь через границу едут имена. Решение владельца
 * 20.10.2026: без них состав бара взять неоткуда. Робот везёт только раздел
 * бара, а не всё распределение.
 *
 * GET  — по какой день уже есть записи;
 * POST — записать прочитанное.
 */

export const dynamic = "force-dynamic";

const ДЕНЬ = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const отказ = отказПоКлючу(request);
  if (отказ) return отказ;

  try {
    return Response.json(await barChatState());
  } catch (e) {
    const err = e as { message?: string };
    return Response.json(
      { ok: false, причина: `база не ответила: ${err.message ?? "неизвестно"}` },
      { status: 500 },
    );
  }
}

type Поля = Record<string, unknown>;

function строка(v: unknown, предел: number): v is string {
  return typeof v === "string" && v.length <= предел;
}

function время(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

/** Общее у обоих видов сообщений: номер, день, время. */
function шапка(п: Поля): string | null {
  const id = Number(п.messageId);
  if (!Number.isSafeInteger(id) || id <= 0) return `messageId — целое число, а пришло «${String(п.messageId)}»`;
  if (typeof п.businessDay !== "string" || !ДЕНЬ.test(п.businessDay)) {
    return `businessDay вида 2026-10-08, а пришло «${String(п.businessDay)}»`;
  }
  if (typeof п.dayFromText !== "boolean") return "dayFromText — да или нет";
  if (!время(п.postedAt)) return `postedAt — время, а пришло «${String(п.postedAt)}»`;
  if (п.editedAt != null && !время(п.editedAt)) return `editedAt — время или пусто`;
  return null;
}

function разобратьСостав(сырое: unknown): ВходящийСостав | string {
  if (typeof сырое !== "object" || сырое === null) return "должен быть объектом";
  const п = сырое as Поля;
  const ошибка = шапка(п);
  if (ошибка) return ошибка;
  if (typeof п.sectionFound !== "boolean") return "sectionFound — да или нет";
  if (!Number.isInteger(п.zones) || (п.zones as number) < 0) return "zones — целое число";
  if (!строка(п.skeleton, 8000)) return "skeleton — строка до 8000 знаков";
  if (!Array.isArray(п.lines) || п.lines.length > 40) return "lines — список до 40 строк";
  const lines = [];
  for (const л of п.lines) {
    const о = л as Поля;
    if (!строка(о?.зона, 200) || !строка(о?.текст, 500)) return "в lines каждая строка — {зона, текст}";
    lines.push({ зона: о.зона as string, текст: о.текст as string });
  }
  return {
    messageId: Number(п.messageId),
    businessDay: п.businessDay as string,
    dayFromText: п.dayFromText as boolean,
    postedAt: п.postedAt as string,
    editedAt: (п.editedAt as string | null) ?? null,
    sectionFound: п.sectionFound as boolean,
    zones: п.zones as number,
    lines,
    skeleton: п.skeleton as string,
  };
}

function разобратьМотивацию(сырое: unknown): ВходящаяМотивация | string {
  if (typeof сырое !== "object" || сырое === null) return "должна быть объектом";
  const п = сырое as Поля;
  const ошибка = шапка(п);
  if (ошибка) return ошибка;
  if (!Array.isArray(п.items) || п.items.length > 50) return "items — список до 50 типов";
  const items = [];
  for (const и of п.items) {
    const о = и as Поля;
    const числа = [о?.штук, о?.ставка, о?.сумма];
    if (!строка(о?.тип, 200) || (о.тип as string).trim() === "") return "у каждого типа нужно название";
    if (!числа.every((ч) => Number.isInteger(ч) && (ч as number) >= 0)) {
      return `«${String(о.тип)}»: штук, ставка и сумма — целые неотрицательные`;
    }
    items.push({
      тип: о.тип as string,
      штук: о.штук as number,
      ставка: о.ставка as number,
      сумма: о.сумма as number,
    });
  }
  if (п.total != null && !(Number.isFinite(п.total) && (п.total as number) >= 0)) {
    return "total — число или пусто";
  }
  if (!Array.isArray(п.remarks) || !п.remarks.every((з) => строка(з, 500))) return "remarks — список строк";
  if (!строка(п.text, 8000)) return "text — строка до 8000 знаков";
  return {
    messageId: Number(п.messageId),
    businessDay: п.businessDay as string,
    dayFromText: п.dayFromText as boolean,
    postedAt: п.postedAt as string,
    editedAt: (п.editedAt as string | null) ?? null,
    items,
    total: (п.total as number | null) ?? null,
    remarks: п.remarks as string[],
    text: п.text as string,
  };
}

function разобратьИсточник(сырое: unknown): ВходящийИсточник | string {
  const п = (сырое ?? {}) as Поля;
  if (п.что !== "состав" && п.что !== "мотивация") return "«что» — «состав» или «мотивация»";
  if (п.группа != null && !Number.isSafeInteger(п.группа)) return "«группа» — номер или пусто";
  if (п.название != null && !строка(п.название, 300)) return "«название» — строка или пусто";
  if (typeof п.видна !== "boolean") return "«видна» — да или нет";
  if (!строка(п.заметка, 2000)) return "«заметка» — строка";
  return {
    что: п.что,
    группа: (п.группа as number | null) ?? null,
    название: (п.название as string | null) ?? null,
    видна: п.видна,
    заметка: п.заметка as string,
  };
}

/** Разобрать список целиком или вернуть первую ошибку с её номером. */
function всё<T>(сырое: unknown, имя: string, разбор: (x: unknown) => T | string): T[] | string {
  if (сырое == null) return [];
  if (!Array.isArray(сырое)) return `«${имя}» — список`;
  const готовые: T[] = [];
  for (const [i, x] of сырое.entries()) {
    const р = разбор(x);
    if (typeof р === "string") return `«${имя}» №${i + 1}: ${р}`;
    готовые.push(р);
  }
  return готовые;
}

export async function POST(request: Request) {
  const отказ = отказПоКлючу(request);
  if (отказ) return отказ;

  let тело: Поля;
  try {
    тело = (await request.json()) as Поля;
  } catch {
    return Response.json({ ok: false, причина: "тело не разобрать как JSON" }, { status: 400 });
  }
  if (typeof тело !== "object" || тело === null) {
    return Response.json({ ok: false, причина: "ожидается объект" }, { status: 400 });
  }

  // Разбираем ВСЁ до записи, как и QR: половина пачки хуже, чем ничего.
  const состав = всё(тело.состав, "состав", разобратьСостав);
  const мотивация = всё(тело.мотивация, "мотивация", разобратьМотивацию);
  const источники = всё(тело.источники, "источники", разобратьИсточник);
  for (const р of [состав, мотивация, источники]) {
    if (typeof р === "string") return Response.json({ ok: false, причина: р }, { status: 400 });
  }

  try {
    const итог = await saveBarChat({
      состав: состав as ВходящийСостав[],
      мотивация: мотивация as ВходящаяМотивация[],
      источники: источники as ВходящийИсточник[],
    });
    return Response.json({
      ok: true,
      изменено: { состав: итог.состав, мотивация: итог.мотивация },
      заметки: итог.заметки,
    });
  } catch (e) {
    const err = e as { message?: string };
    return Response.json(
      { ok: false, причина: `база не ответила: ${err.message ?? "неизвестно"}` },
      { status: 500 },
    );
  }
}
