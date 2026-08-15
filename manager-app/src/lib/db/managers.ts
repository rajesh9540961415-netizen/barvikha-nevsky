"use server";

import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  hashPassword,
  verifyPassword,
  makeSession,
  readSession,
  SESSION_COOKIE,
} from "../auth";
import { db } from "./sql";

export type Manager = {
  id: number;
  name: string;
  role: "owner" | "manager";
  /** Пароль выдан, своим ещё не заменён — до замены дальше входа не пускаем. */
  mustChangePassword: boolean;
};

/** Человек в списке доступа. Пароля здесь нет и быть не может. */
export type AccessPerson = {
  id: number;
  name: string;
  login: string;
  role: "owner" | "manager";
  active: boolean;
  mustChangePassword: boolean;
  lastSeen: string | null;
};

/**
 * Ответ экранам. Пароль приходит только что созданный и показывается один раз:
 * в базе лежит необратимый отпечаток, второй раз его взять неоткуда.
 */
export type Итог =
  | { ok: true; текст: string; пароль?: string; логин?: string }
  | { ok: false; текст: string }
  | null;

type Row = {
  id: number;
  name: string;
  role: string;
  password_hash: string;
  active: boolean;
  must_change_password: boolean;
};

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
    select id, name, role, password_hash, active, must_change_password
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
    select id, name, role, password_hash, active, must_change_password
      from managers where id = ${id} limit 1
  `;
  const row = rows[0];
  // Отключённого человека не пускаем, даже если печенье ещё живо: отзыв
  // доступа должен действовать сразу, а не через двенадцать часов.
  if (!row || !row.active) return null;
  return {
    id: row.id,
    name: row.name,
    role: row.role as Manager["role"],
    mustChangePassword: row.must_change_password,
  };
}

/* ─── Фаза 7: пароли и доступ ─────────────────────────────────────────────
 *
 * Поставлена 14.08.2026, когда владелец потеряла пароль в день заведения
 * и обнаружила, что ходов назад нет ни одного: экрана смены не было, экран
 * «сотрудники» умел только показывать, а `manager:password` с её компьютера
 * до боевой базы не достаёт. Выкрутились разовой дверью `BOOTSTRAP_KEY`,
 * но её пришлось закрыть — она вела мимо входа по паролю.
 *
 * Три решения владельца того же дня, и они здесь исполняются буквально:
 *
 *   1. Новый пароль человеку выдаёт ТОЛЬКО владелец. Иначе управляющий
 *      выдаёт пароль владельцу, заходит под ним — и правки денег
 *      подписываются чужим именем.
 *   2. Выданный пароль надо сменить при первом входе.
 *   3. Заводит и отключает людей ТОЛЬКО владелец: право завести человека —
 *      это право впустить его к деньгам.
 *
 * Разбор — plans/2026-08-03-upravlencheskiy-blok.md, раздел «Вход» и фаза 7.
 */

/** Короче этого пароль подбирается, длиннее — люди начинают писать на бумажке. */
const MIN_PASSWORD = 10;

/**
 * Пароль придумываем здесь и показываем один раз.
 *
 * Принимать его снаружи нельзя: он проехал бы через журналы и историю команд,
 * как это уже случилось 13.08.2026 с паролем от базы.
 */
function придуматьПароль(): string {
  return randomBytes(9).toString("base64url");
}

/**
 * Кто вошёл, с проверками. Не вошёл — на вход; не сменил выданный пароль —
 * на смену пароля.
 *
 * Проверка живёт одной функцией, а не копией на каждой странице: страница,
 * про которую забыли, стала бы дырой молча — а заметили бы её тогда, когда
 * через неё уже прошли.
 */
export async function requireManager(): Promise<Manager> {
  const manager = await currentManager();
  if (!manager) redirect("/login");
  if (manager.mustChangePassword) redirect("/password");
  return manager;
}

/** То же, но пускает только владельца. */
export async function требоватьВладельца(): Promise<Manager> {
  const manager = await requireManager();
  if (manager.role !== "owner") redirect("/");
  return manager;
}

/** Список тех, кто может заходить в бэк-офис. Видит только владелец. */
export async function listAccess(): Promise<AccessPerson[]> {
  await требоватьВладельца();
  const sql = db();
  const rows = await sql<
    {
      id: number;
      name: string;
      login: string;
      role: string;
      active: boolean;
      must_change_password: boolean;
      last_seen: Date | null;
    }[]
  >`
    select m.id, m.name, m.login, m.role, m.active, m.must_change_password,
           (select max(at) from manager_logins l
             where l.manager_id = m.id and l.ok) as last_seen
      from managers m
     order by m.active desc, m.role, m.name
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    login: r.login,
    role: r.role as Manager["role"],
    active: r.active,
    mustChangePassword: r.must_change_password,
    lastSeen: r.last_seen ? r.last_seen.toISOString() : null,
  }));
}

/**
 * Сменить свой пароль. Доступно каждому, кто вошёл, — и только себе.
 *
 * Старый пароль спрашиваем не для формальности: печенье живёт двенадцать
 * часов, и чужой открытый ноутбук — это готовый доступ. Знание старого
 * пароля отличает хозяина учётки от того, кто просто сел за стол.
 */
export async function changeOwnPassword(_previous: Итог, form: FormData): Promise<Итог> {
  const manager = await currentManager();
  if (!manager) redirect("/login");

  const старый = String(form.get("current") ?? "");
  const новый = String(form.get("next") ?? "");
  const повтор = String(form.get("repeat") ?? "");

  if (!старый || !новый) return { ok: false, текст: "Заполните оба поля" };
  if (новый !== повтор) return { ok: false, текст: "Новый пароль и повтор не совпали" };
  if (новый.length < MIN_PASSWORD) {
    return { ok: false, текст: `Новый пароль короче ${MIN_PASSWORD} знаков` };
  }
  if (новый === старый) {
    return { ok: false, текст: "Новый пароль совпадает со старым" };
  }

  const sql = db();
  const rows = await sql<Row[]>`
    select id, name, role, password_hash, active, must_change_password
      from managers where id = ${manager.id} limit 1
  `;
  const row = rows[0];
  if (!row || !row.active) redirect("/login");
  if (!verifyPassword(старый, row.password_hash)) {
    return { ok: false, текст: "Старый пароль неверен" };
  }

  await sql`
    update managers
       set password_hash = ${hashPassword(новый)}, must_change_password = false
     where id = ${manager.id}
  `;
  return { ok: true, текст: "Пароль сменён. Запомните его — восстановить нельзя." };
}

/**
 * Выдать человеку новый пароль взамен потерянного. Только владелец.
 *
 * Старый пароль при этом перестаёт работать, а новый показывается один раз.
 * Человека сразу помечаем «надо сменить»: выданный пароль — временный
 * по смыслу, даже если им пользуются месяцами.
 */
export async function resetPassword(_previous: Итог, form: FormData): Promise<Итог> {
  const владелец = await требоватьВладельца();
  const id = Number(form.get("id"));
  if (!Number.isInteger(id)) return { ok: false, текст: "Не указан человек" };

  const пароль = придуматьПароль();
  const sql = db();
  const rows = await sql<{ login: string }[]>`
    update managers
       set password_hash = ${hashPassword(пароль)}, must_change_password = true
     where id = ${id} and active
       returning login
  `;
  if (rows.length === 0) {
    return { ok: false, текст: "Человек не найден или отключён" };
  }

  // Себе тоже можно — но тогда придётся входить заново, и об этом надо
  // сказать, а не дать человеку обнаружить это самому через час.
  const себе = id === владелец.id;
  return {
    ok: true,
    логин: rows[0].login,
    пароль,
    текст: себе
      ? "Пароль сменён себе. Запишите его: при следующем входе понадобится он."
      : `Новый пароль для «${rows[0].login}». Передайте его лично и запишите — второй раз он не покажется.`,
  };
}

/** Завести человека. Только владелец. Пароль показывается один раз. */
export async function addPerson(_previous: Итог, form: FormData): Promise<Итог> {
  await требоватьВладельца();

  const имя = String(form.get("name") ?? "").trim();
  // Логин приводим к строчным: иначе «Vika» и «vika» стали бы разными людьми,
  // а человек, вводя своё имя с большой буквы, не смог бы войти.
  const логин = String(form.get("login") ?? "").trim().toLowerCase();
  const роль = String(form.get("role") ?? "manager");

  if (!имя) return { ok: false, текст: "Не указано имя" };
  if (!/^[a-z0-9_-]{2,32}$/.test(логин)) {
    return {
      ok: false,
      текст: "Логин — латиница, цифры, дефис и подчёркивание, от 2 до 32 знаков",
    };
  }
  if (роль !== "owner" && роль !== "manager") {
    return { ok: false, текст: "Роль бывает «владелец» или «управляющий»" };
  }

  const пароль = придуматьПароль();
  const sql = db();
  const появился = await sql<{ login: string }[]>`
    insert into managers (name, login, password_hash, role, must_change_password)
         values (${имя}, ${логин}, ${hashPassword(пароль)}, ${роль}, true)
    on conflict (login) do nothing
      returning login
  `;
  if (появился.length === 0) {
    return { ok: false, текст: `Человек с логином «${логин}» уже заведён` };
  }

  return {
    ok: true,
    логин,
    пароль,
    текст: `Заведён «${логин}». Передайте пароль лично и запишите — второй раз он не покажется.`,
  };
}

/**
 * Отключить или вернуть человека. Только владелец.
 *
 * Отключаем, а не удаляем: вместе с удалённым ушла бы история его правок,
 * а это денежный след. Правило записано ещё 04.08.2026.
 *
 * ⚠️ Два запрета, оба против запирания самого себя:
 * себя отключить нельзя, и последнего живого владельца — тоже.
 */
export async function toggleActive(_previous: Итог, form: FormData): Promise<Итог> {
  const владелец = await требоватьВладельца();
  const id = Number(form.get("id"));
  const включить = String(form.get("active")) === "1";
  if (!Number.isInteger(id)) return { ok: false, текст: "Не указан человек" };

  if (!включить && id === владелец.id) {
    return { ok: false, текст: "Себя отключить нельзя — войти станет некем" };
  }

  const sql = db();

  if (!включить) {
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*) from managers where role = 'owner' and active and id <> ${id}
    `;
    if (Number(count) === 0) {
      return { ok: false, текст: "Это последний владелец — отключать его нельзя" };
    }
  }

  const rows = await sql<{ login: string }[]>`
    update managers set active = ${включить} where id = ${id} returning login
  `;
  if (rows.length === 0) return { ok: false, текст: "Человек не найден" };

  return {
    ok: true,
    текст: включить
      ? `«${rows[0].login}» снова может заходить`
      : `«${rows[0].login}» отключён. История его правок осталась на месте.`,
  };
}
