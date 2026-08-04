import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Вход в бэк-офис — по людям, а не общим паролем.
 *
 * Решение владельца 04.08.2026: заходить будут трое, потом до пяти-шести.
 * Дело не в безопасности как таковой, а в том, что управляющий состав правит
 * деньги: под общим паролем правка подписывалась бы должностью, а не именем,
 * и спросить «почему так» было бы не у кого.
 *
 * Пароли не хранятся. Хранится результат необратимого преобразования: даже
 * получив базу целиком, пароль из неё не достать. Считаем через scrypt —
 * он встроен в Node, отдельной библиотеки не нужно.
 */

const KEY_LENGTH = 64;
// Стоимость подбора. 2^15 — примерно сотня миллисекунд на проверку: человеку
// незаметно, а перебору по словарю делает больно.
const COST = 32768;
// При такой стойкости scrypt просит около 33 МБ, а Node по умолчанию даёт 32
// и отказывается считать. Предел приходится поднимать явно.
const MAX_MEM = 64 * 1024 * 1024;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, KEY_LENGTH, {
    N: COST,
    maxmem: MAX_MEM,
  }).toString("hex");
  return `scrypt$${COST}$${salt}$${hash}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const cost = Number(parts[1]);
  if (!Number.isFinite(cost) || cost <= 0) return false;

  const expected = Buffer.from(parts[3], "hex");
  let got: Buffer;
  try {
    got = scryptSync(plain, parts[2], expected.length, {
      N: cost,
      maxmem: MAX_MEM,
    });
  } catch {
    return false;
  }
  // Сравниваем за постоянное время: обычное сравнение возвращает ответ тем
  // быстрее, чем раньше разошлись байты, и по этой разнице пароль подбирается.
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/* ─── Сессия ─────────────────────────────────────────────────────────────
 *
 * Кто вошёл — храним подписанным печеньем, а не таблицей сессий. Внутри
 * только номер человека и срок годности; подделать нельзя, не зная ключа.
 *
 * Почему без таблицы: одна таблица — одно место, где всё ломается при сбое
 * базы. Здесь же сервер проверяет подпись сам, ничего не читая.
 */

export const SESSION_COOKIE = "office";
const SESSION_HOURS = 12;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) {
    throw new Error(
      "Не задан SESSION_SECRET — длинная случайная строка, которой " +
        "подписывается вход. Задаётся в переменных приложения в панели " +
        "Amvera, на этом компьютере — в manager-app/.env.local",
    );
  }
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function makeSession(managerId: number): { value: string; maxAge: number } {
  const expires = Date.now() + SESSION_HOURS * 3600_000;
  const payload = `${managerId}.${expires}`;
  return { value: `${payload}.${sign(payload)}`, maxAge: SESSION_HOURS * 3600 };
}

/** Номер вошедшего человека или null, если печенье поддельное либо протухло. */
export function readSession(value: string | undefined): number | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;

  const [id, expires, signature] = parts;
  const good = sign(`${id}.${expires}`);
  if (
    signature.length !== good.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(good))
  ) {
    return null;
  }
  if (Number(expires) < Date.now()) return null;

  const managerId = Number(id);
  return Number.isInteger(managerId) ? managerId : null;
}
