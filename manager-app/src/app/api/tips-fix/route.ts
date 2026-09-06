import { draftOf } from "@/lib/events";
import {
  cancelEvent,
  correctEvent,
  readDay,
  добавитьЗапись,
} from "@/lib/db/corrections";
import { db } from "@/lib/db/sql";
import { HOOKAH_POT_ID } from "@/lib/split";
import { отказПоКлючуПравок } from "@/lib/tipsFixKey";
import type { Manager } from "@/lib/db/managers";

/**
 * Служебная дверь для пачки правок чаевых.
 *
 * ⚠️ Сама в базу не пишет. Всё идёт через `correctEvent`, `cancelEvent`
 * и `добавитьЗапись` — те же функции, что у экрана, со всеми их проверками:
 * получатель обязан быть в составе, правка не стирает запись, отменённое
 * второй раз не отменяется. Здесь только разбор запроса и подпись.
 *
 * Три вида операций:
 *
 *   {"вид":"замена","день":"2026-08-07","с":919,"на":916,"почему":"…"}
 *      — во ВСЕХ живых записях дня получатель `с` меняется на `на`.
 *        Событие, где `на` уже стоит, не трогается: замена превратила бы
 *        деление надвое в деление на одного и молча изменила бы суммы.
 *
 *   {"вид":"отмена","день":"2026-08-26","кто":822,"почему":"…"}
 *      — все живые записи этого человека за день отменяются.
 *
 *   {"вид":"бар","день":"2026-08-01","время":"23:00","деньги":"cash",
 *    "сумма":3200,"почему":"…"}
 *      — новая запись в общий котёл кальянного бара.
 *
 * Ответ — по строке на операцию: что сделано и что не вышло. Пачка НЕ
 * откатывается целиком: каждая правка самостоятельна, и остановка на
 * середине должна оставлять сделанное сделанным, а не гадать задним числом.
 */

export const dynamic = "force-dynamic";

const ДЕНЬ = /^\d{4}-\d{2}-\d{2}$/;
const ВИДЫ_ДЕНЕГ = new Set(["cash", "terminal", "qr", "service"]);

/**
 * Кем подписаны правки, пришедшие ключом.
 *
 * Отдельная запись в списке управляющих, а не владелец: подписать машинную
 * пачку живым человеком значит соврать в том самом следе, ради которого
 * весь этот механизм и сделан. Войти под ней нельзя — `active = false`,
 * а `currentManager` отключённых не пускает.
 */
async function служебныйУправляющий(): Promise<Manager> {
  const sql = db();
  const [есть] = await sql<{ id: number; name: string }[]>`
    select id, name from managers where login = 'sverka' limit 1
  `;
  if (есть) return { id: есть.id, name: есть.name, role: "manager", mustChangePassword: false };

  const [новый] = await sql<{ id: number; name: string }[]>`
    insert into managers (name, login, password_hash, role, must_change_password, active)
         values ('Сверка по ключу', 'sverka', 'вход-невозможен', 'manager', false, false)
      returning id, name
  `;
  return { id: новый.id, name: новый.name, role: "manager", mustChangePassword: false };
}

type Операция = Record<string, unknown>;

export async function POST(request: Request) {
  const отказ = отказПоКлючуПравок(request);
  if (отказ) return отказ;

  let тело: { операции?: Операция[] };
  try {
    тело = await request.json();
  } catch {
    return Response.json({ ok: false, причина: "тело не разобралось как JSON" }, { status: 400 });
  }
  const операции = тело.операции;
  if (!Array.isArray(операции) || операции.length === 0) {
    return Response.json({ ok: false, причина: "нет списка «операции»" }, { status: 400 });
  }

  const manager = await служебныйУправляющий();
  const итоги: { операция: number; сделано: number; отказы: string[] }[] = [];

  for (const [номер, оп] of операции.entries()) {
    const день = String(оп.день ?? "");
    const почему = String(оп.почему ?? "").trim();
    const итог = { операция: номер + 1, сделано: 0, отказы: [] as string[] };
    итоги.push(итог);

    if (!ДЕНЬ.test(день)) {
      итог.отказы.push(`непонятный день «${день}»`);
      continue;
    }
    if (почему.length < 3) {
      итог.отказы.push("без пояснения правку делать нельзя");
      continue;
    }

    if (оп.вид === "бар") {
      const вид = String(оп.деньги ?? "");
      const сумма = Number(оп.сумма);
      if (!ВИДЫ_ДЕНЕГ.has(вид)) {
        итог.отказы.push(`неизвестный вид денег «${вид}»`);
        continue;
      }
      if (!Number.isFinite(сумма) || сумма <= 0) {
        итог.отказы.push("сумма должна быть больше нуля");
        continue;
      }
      const ответ = await добавитьЗапись({
        businessDay: день,
        время: String(оп.время ?? "23:00"),
        note: почему,
        manager,
        draft: {
          kind: вид as never,
          gross: сумма,
          hallId: null,
          hallTitle: null,
          tableId: null,
          tableTitle: null,
          payees: [{ id: HOOKAH_POT_ID, contour: "hookah" }],
        },
      });
      if ("error" in ответ) итог.отказы.push(ответ.error);
      else итог.сделано += 1;
      continue;
    }

    const данные = await readDay(день);
    if (!данные) {
      итог.отказы.push("смены за этот день нет");
      continue;
    }
    const живые = данные.events.filter((e) => e.deletedAt === null);

    if (оп.вид === "отмена") {
      const кто = Number(оп.кто);
      for (const событие of живые.filter((e) => e.waiters.some((w) => w.id === кто))) {
        const ответ = await cancelEvent({
          businessDay: день,
          key: событие.key,
          note: почему,
          manager,
        });
        if ("error" in ответ) итог.отказы.push(`${событие.key}: ${ответ.error}`);
        else итог.сделано += 1;
      }
      continue;
    }

    if (оп.вид === "замена") {
      const с = Number(оп.с);
      const на = Number(оп.на);
      if (!Number.isInteger(с) || !Number.isInteger(на) || с === на) {
        итог.отказы.push("нужны разные номера «с» и «на»");
        continue;
      }
      for (const событие of живые.filter((e) => e.waiters.some((w) => w.id === с))) {
        if (событие.waiters.some((w) => w.id === на)) {
          итог.отказы.push(
            `${событие.key}: получатель №${на} в этом событии уже есть — замена изменила бы доли, не трогаю`,
          );
          continue;
        }
        const черновик = draftOf(событие);
        const ответ = await correctEvent({
          businessDay: день,
          key: событие.key,
          note: почему,
          manager,
          draft: {
            ...черновик,
            payees: черновик.payees.map((p) => (p.id === с ? { ...p, id: на } : p)),
          },
        });
        if ("error" in ответ) итог.отказы.push(`${событие.key}: ${ответ.error}`);
        else итог.сделано += 1;
      }
      continue;
    }

    итог.отказы.push(`неизвестный вид операции «${String(оп.вид)}»`);
  }

  return Response.json({
    ok: итоги.every((и) => и.отказы.length === 0),
    подписано: manager.name,
    итоги,
  });
}
