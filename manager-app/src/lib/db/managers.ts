"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyPassword, makeSession, readSession, SESSION_COOKIE } from "../auth";
import { db } from "./sql";

export type Manager = {
  id: number;
  name: string;
  role: "owner" | "manager";
};

type Row = { id: number; name: string; role: string; password_hash: string; active: boolean };

/**
 * Записываем и удачные входы, и неудачные.
 *
 * Неудачные — не из подозрительности: по ним видно подбор пароля, а ещё
 * человеческое «не могу зайти», о котором иначе узнаёшь только по звонку.
 * У неудачной попытки номера человека нет, но введённый логин сохраняется.
 */
async function note(login: string, managerId: number | null, ok: boolean) {
  const sql = db();
  await sql`
    insert into manager_logins (login, manager_id, ok)
    values (${login}, ${managerId}, ${ok})
  `;
}

/**
 * Вход. Возвращает текст ошибки или null, если пустили.
 *
 * Ошибка нарочно одна на все случаи — «неверный логин или пароль». Раздельные
 * сообщения подсказали бы подбирающему, что логин угадан, и половина работы
 * была бы сделана за него.
 */
export async function signIn(login: string, password: string): Promise<string | null> {
  const clean = login.trim().toLowerCase();
  if (!clean || !password) return "Введите логин и пароль";

  const sql = db();
  const rows = await sql<Row[]>`
    select id, name, role, password_hash, active
      from managers
     where login = ${clean}
     limit 1
  `;

  const row = rows[0];
  if (!row || !row.active || !verifyPassword(password, row.password_hash)) {
    await note(clean, row?.id ?? null, false);
    return "Неверный логин или пароль";
  }

  await note(clean, row.id, true);

  const session = makeSession(row.id);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: "lax",
    // На своей машине бэк-офис открывается по http, в бою — только по https.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: session.maxAge,
  });
  return null;
}

/** Обработчик формы входа. Пустил — уводит на сводку, нет — возвращает текст. */
export async function loginAction(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const error = await signIn(
    String(form.get("login") ?? ""),
    String(form.get("password") ?? ""),
  );
  if (error) return error;
  redirect("/");
}

export async function signOut() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/** Кто сейчас вошёл. null — значит никто, показываем вход. */
export async function currentManager(): Promise<Manager | null> {
  const jar = await cookies();
  const id = readSession(jar.get(SESSION_COOKIE)?.value);
  if (id === null) return null;

  const sql = db();
  const rows = await sql<Row[]>`
    select id, name, role, password_hash, active from managers where id = ${id} limit 1
  `;
  const row = rows[0];
  // Отключённого человека не пускаем, даже если печенье ещё живо: отзыв
  // доступа должен действовать сразу, а не через двенадцать часов.
  if (!row || !row.active) return null;
  return { id: row.id, name: row.name, role: row.role as Manager["role"] };
}
