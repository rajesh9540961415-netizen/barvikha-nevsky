"use server";

import { revalidatePath } from "next/cache";
import { СТАВКИ_ПО_УМОЛЧАНИЮ, type ПродажаПозиции, type ПродажаДня }
  from "../hookahMotivation";
import { currentManager } from "./managers";
import { db } from "./sql";

// Начало названия строк, взятых из отчёта администратора, а не из чеков.
// Не вывозится: файл «use server», в нём можно вывозить только функции.
const ПО_ОТЧЁТУ = "Отчёт администратора: ";

/**
 * Продажи кальянного бара и ставки мотивации.
 *
 * ⚠️ Продажи сюда ПРИВОЗЯТ, а не считают на месте: состав заказа Quick Resto
 * через API не отдаёт (`front.orders` — 50 полей без позиций), и позиции
 * берутся из фискальных чеков на компьютере владельца. Отправляет их
 * `scripts/hookah_push.py` через `/api/hookah-sales`.
 */

export type День = { day: string; штук: number; мотивация: number };

/** Продажи за месяц: строка на позицию и день. */
export async function продажиМесяца(
  месяц: string,
): Promise<ПродажаДня[]> {
  const sql = db();
  return sql<ПродажаДня[]>`
    select business_day as day, position, category,
           qty::float8 as qty, amount::float8 as amount
      from hookah_sales
     where business_day like ${месяц + "%"}
     order by business_day, position
  `;
}

/** Какие месяцы вообще есть — для переключателя. */
export async function месяцыСПродажами(): Promise<string[]> {
  const sql = db();
  const строки = await sql<{ месяц: string }[]>`
    select distinct substring(business_day, 1, 7) as месяц
      from hookah_sales order by 1 desc
  `;
  return строки.map((с) => с.месяц);
}

/**
 * Ставки. Чего нет в базе — берётся из общего файла как значение по умолчанию,
 * чтобы страница считала с первого открытия, ещё до первой правки.
 */
export async function ставки(): Promise<Record<string, number>> {
  const sql = db();
  const строки = await sql<{ category: string; rate: number }[]>`
    select category, rate::float8 as rate from hookah_rates
  `;
  const итог: Record<string, number> = { ...СТАВКИ_ПО_УМОЛЧАНИЮ };
  for (const с of строки) итог[с.category] = с.rate;
  return итог;
}

/**
 * Сохранить ставку.
 *
 * ⚠️ Кто менял — записываем. Ставка это деньги людей: через месяц вопрос
 * «почему стало по-другому» задают обязательно, и отвечать на него должна
 * база, а не память.
 */
export async function сохранитьСтавку(
  _прошлое: unknown,
  форма: FormData,
): Promise<{ ok?: true; error?: string }> {
  const manager = await currentManager();
  if (!manager) return { error: "Вход истёк — войдите заново" };

  const категория = String(форма.get("категория") ?? "").trim();
  const сырое = String(форма.get("ставка") ?? "").replace(",", ".").trim();
  if (!категория) return { error: "Не указана категория" };
  const ставка = Number(сырое);
  if (!Number.isFinite(ставка) || ставка < 0) {
    return { error: "Ставка — число не меньше нуля" };
  }
  if (ставка > 100000) return { error: "Больше 100 000 ₽ за штуку — это опечатка" };

  const sql = db();
  await sql`
    insert into hookah_rates (category, rate, updated_by)
         values (${категория}, ${ставка}, ${manager.name})
    on conflict (category) do update
       set rate = excluded.rate, updated_at = now(), updated_by = excluded.updated_by
  `;
  revalidatePath("/motivaciya");
  return { ok: true };
}

/**
 * Приём продаж от скрипта на Маке. Заменяет день целиком.
 *
 * 🔴 **Дни «по отчёту администратора» Мак не переписывает** — решение владельца
 * 21.10.2026. За 8–19.10.2026 продаж из чеков нет (приложение лежало), и
 * мотивацию тех дней владелец велела считать по отчёту администратора из чата:
 * его штуки по типам приходят сюда строками с названием, начинающимся на
 * `ПО_ОТЧЁТУ`. Скрипт на Маке заливает месяц целиком и молча заменил бы их
 * подсчётом по чекам — то есть поменял бы уже согласованные деньги. Такой
 * день заменяют только строки того же рода; чужие для него пропускаются
 * и называются в ответе.
 */
export async function принятьПродажи(
  строки: ПродажаДня[],
): Promise<{ дней: number; строк: number; пропущено: string[] }> {
  const sql = db();
  const пропущено: string[] = [];
  let записано = 0;
  const дни = [...new Set(строки.map((с) => с.day))];
  await sql.begin(async (tx) => {
    const поОтчёту = new Set(
      (
        await tx<{ business_day: string }[]>`
          select distinct business_day from hookah_sales
           where business_day = any(${дни}) and position like ${ПО_ОТЧЁТУ + "%"}
        `
      ).map((р) => р.business_day),
    );
    for (const день of дни) {
      const дня = строки.filter((с) => с.day === день);
      if (поОтчёту.has(день) && !дня.every((с) => с.position.startsWith(ПО_ОТЧЁТУ))) {
        пропущено.push(день);
        continue;
      }
      // ⚠️ День заменяется целиком, а не дописывается: пересчёт возвратов может
      // УМЕНЬШИТЬ количество, и дописывание оставило бы старое число рядом.
      await tx`delete from hookah_sales where business_day = ${день}`;
      for (const с of дня) {
        await tx`
          insert into hookah_sales (business_day, position, category, qty, amount)
               values (${с.day}, ${с.position}, ${с.category}, ${с.qty}, ${с.amount})
          on conflict (business_day, position) do update
             set category = excluded.category, qty = excluded.qty,
                 amount = excluded.amount, updated_at = now()
        `;
        записано += 1;
      }
    }
  });
  revalidatePath("/motivaciya");
  return { дней: дни.length - пропущено.length, строк: записано, пропущено };
}

// ⚠️ Типы отсюда НЕ вывозим. Файл помечен «use server», и в таком каждый
// вывоз обязан быть асинхронной функцией: сборка падает с «ПродажаПозиции
// is not defined» уже на сборе страниц, а не на проверке типов.
// Берите их прямо из ../hookahMotivation.
