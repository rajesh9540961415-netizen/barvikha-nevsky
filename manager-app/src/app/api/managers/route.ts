import { randomBytes, timingSafeEqual } from "node:crypto";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db/sql";

/**
 * Заведение человека в бэк-офис: POST /api/managers
 *
 * ⚠️ Зачем понадобился — 13.08.2026.
 *
 * Людей в бэк-офис заводят командой `npm run manager:add` с компьютера
 * владельца. На боевой базе это не работает: с её Мака до базы не достучаться,
 * VPN incy подменяет адрес на служебный `240.0.2.111`, а выключить VPN нельзя.
 * Внешний доступ к базе мы вдобавок собираемся закрыть.
 *
 * Значит завести первого человека может только тот, у кого доступ к базе уже
 * есть, — сам бэк-офис. Отсюда этот адрес.
 *
 * Он повторяет устройство `/api/export/<день>` у приложения смены: **не задан
 * ключ — адрес не работает вовсе.** Заводить людей, которые правят деньги,
 * без защиты нельзя даже разово.
 *
 * ⚠️ **После того как люди заведены, переменную `BOOTSTRAP_KEY` из панели
 * надо убрать.** Тогда адрес выключится сам. Держать его открытым дольше,
 * чем нужно, незачем: это единственная дверь, ведущая мимо входа по паролю.
 *
 * Пароль здесь придумывается случайный и показывается ОДИН раз — в базе
 * лежит не пароль, а его отпечаток, восстановить нельзя. Тот же порядок,
 * что и в `scripts/add-manager.mjs`, и та же функция `hashPassword`,
 * чтобы правила хеширования не разошлись копиями.
 */

export const dynamic = "force-dynamic";

/** Сравнение за постоянное время: обычное `===` выдаёт длину совпадения. */
function ключиСовпали(данный: string, нужный: string): boolean {
  const a = Buffer.from(данный);
  const b = Buffer.from(нужный);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const нужный = process.env.BOOTSTRAP_KEY;

  if (!нужный) {
    return Response.json(
      {
        ok: false,
        причина:
          "не задана переменная BOOTSTRAP_KEY — заведение людей выключено. " +
          "Это нормальное состояние: переменную задают на время и потом убирают",
      },
      { status: 503 },
    );
  }

  // Короткий ключ подбирается, а дверь эта ведёт мимо входа по паролю.
  if (нужный.length < 24) {
    return Response.json(
      { ok: false, причина: "BOOTSTRAP_KEY короче 24 символов — так нельзя" },
      { status: 503 },
    );
  }

  const данный = request.headers.get("X-Bootstrap-Key");
  if (!данный || !ключиСовпали(данный, нужный)) {
    return Response.json({ ok: false, причина: "неверный ключ" }, { status: 401 });
  }

  let тело: unknown;
  try {
    тело = await request.json();
  } catch {
    return Response.json({ ok: false, причина: "тело не разобрать как JSON" }, { status: 400 });
  }

  const { name, login, role = "manager" } = (тело ?? {}) as Record<string, unknown>;

  if (typeof name !== "string" || name.trim() === "") {
    return Response.json({ ok: false, причина: "не указано имя" }, { status: 400 });
  }
  // Логин приводим к строчным: иначе «Vika» и «vika» стали бы разными людьми,
  // а человек, вводя своё имя с большой буквы, не смог бы войти.
  const чистыйЛогин = typeof login === "string" ? login.trim().toLowerCase() : "";
  if (!/^[a-z0-9_-]{2,32}$/.test(чистыйЛогин)) {
    return Response.json(
      {
        ok: false,
        причина: "логин — латиница, цифры, дефис и подчёркивание, от 2 до 32 знаков",
      },
      { status: 400 },
    );
  }
  if (role !== "owner" && role !== "manager") {
    return Response.json(
      { ok: false, причина: `роль бывает owner или manager, а не «${String(role)}»` },
      { status: 400 },
    );
  }

  // Пароль придумываем здесь и показываем один раз. Принимать его снаружи
  // нельзя: он проехал бы через журналы и историю команд, как это уже
  // случилось сегодня с паролем от базы.
  const пароль = randomBytes(9).toString("base64url");

  try {
    const sql = db();
    const появился = await sql`
      insert into managers (name, login, password_hash, role)
           values (${name.trim()}, ${чистыйЛогин}, ${hashPassword(пароль)}, ${role})
      on conflict (login) do nothing
        returning login
    `;

    if (появился.length === 0) {
      return Response.json(
        { ok: false, причина: `человек с логином «${чистыйЛогин}» уже заведён` },
        { status: 409 },
      );
    }

    return Response.json({ ok: true, login: чистыйЛогин, role, пароль });
  } catch (e) {
    const err = e as { message?: string };
    return Response.json(
      { ok: false, причина: `база не ответила: ${err.message ?? "неизвестно"}` },
      { status: 500 },
    );
  }
}
