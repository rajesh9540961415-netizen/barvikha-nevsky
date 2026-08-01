"use server";

import type { Employee, Entry, Kind, Shift } from "../types";
import { db } from "./sql";

/**
 * Всё общение с базой.
 *
 * «use server» наверху означает: эти функции выполняются на сервере,
 * даже когда их вызывает экран в телефоне. Наружу уезжает только вызов
 * и ответ — пароль от базы телефон не видит.
 *
 * Три таблицы, по одной на каждый файл хранилища:
 *   entries       — записи о чаевых;
 *   shifts        — состав смены и роли, по строке на бизнес-день;
 *   manual_people — стажёры, которых нет в Quick Resto.
 */

type EntryRow = {
  id: string;
  business_day: string;
  hall_id: number;
  hall_title: string;
  table_id: number;
  table_title: string;
  waiter_id: number;
  waiter_name: string;
  amount: string;
  kind: string;
  operator_id: number;
  operator_name: string;
  created_at: Date;
};

function toEntry(r: EntryRow): Entry {
  return {
    id: r.id,
    businessDay: r.business_day,
    hallId: r.hall_id,
    hallTitle: r.hall_title,
    tableId: r.table_id,
    tableTitle: r.table_title,
    waiterId: r.waiter_id,
    waiterName: r.waiter_name,
    // Деньги в базе хранятся как numeric и приезжают строкой — иначе
    // копейки округлялись бы на ровном месте.
    amount: Number(r.amount),
    kind: r.kind as Kind,
    operatorId: r.operator_id,
    operatorName: r.operator_name,
    createdAt: r.created_at.toISOString(),
  };
}

export async function listEntries(businessDay: string): Promise<Entry[]> {
  const sql = db();
  const rows = await sql<EntryRow[]>`
    select * from entries
    where business_day = ${businessDay}
    order by created_at desc
  `;
  return rows.map(toEntry);
}

export async function insertEntry(e: Entry): Promise<void> {
  const sql = db();
  await sql`
    insert into entries (
      id, business_day, hall_id, hall_title, table_id, table_title,
      waiter_id, waiter_name, amount, kind, operator_id, operator_name, created_at
    ) values (
      ${e.id}, ${e.businessDay}, ${e.hallId}, ${e.hallTitle},
      ${e.tableId}, ${e.tableTitle}, ${e.waiterId}, ${e.waiterName},
      ${e.amount}, ${e.kind}, ${e.operatorId}, ${e.operatorName}, ${e.createdAt}
    )
  `;
}

export async function deleteEntry(id: string): Promise<void> {
  const sql = db();
  await sql`delete from entries where id = ${id}`;
}

type ShiftRow = {
  business_day: string;
  crew: number[];
  operator_id: number | null;
  admin_id: number | null;
  cashier_id: number | null;
};

function toShift(r: ShiftRow): Shift {
  return {
    crew: r.crew,
    operator: r.operator_id,
    admin: r.admin_id,
    cashier: r.cashier_id,
  };
}

export async function readShift(businessDay: string): Promise<Shift | null> {
  const sql = db();
  const rows = await sql<ShiftRow[]>`
    select * from shifts where business_day = ${businessDay}
  `;
  return rows[0] ? toShift(rows[0]) : null;
}

export async function writeShift(
  businessDay: string,
  shift: Shift,
): Promise<void> {
  const sql = db();
  await sql`
    insert into shifts (business_day, crew, operator_id, admin_id, cashier_id)
    values (
      ${businessDay}, ${shift.crew}, ${shift.operator},
      ${shift.admin}, ${shift.cashier}
    )
    on conflict (business_day) do update set
      crew = excluded.crew,
      operator_id = excluded.operator_id,
      admin_id = excluded.admin_id,
      cashier_id = excluded.cashier_id,
      updated_at = now()
  `;
}

/**
 * Прошлая смена — чтобы не собирать состав заново каждый вечер.
 * Отдельной строки для неё не нужно: это просто самая свежая смена.
 * Ключ бизнес-дня в формате ГГГГ-ММ-ДД, поэтому обычная сортировка
 * текста совпадает с хронологической.
 */
export async function readLastShift(): Promise<Shift | null> {
  const sql = db();
  const rows = await sql<ShiftRow[]>`
    select * from shifts order by business_day desc limit 1
  `;
  return rows[0] ? toShift(rows[0]) : null;
}

type PersonRow = { id: number; name: string; short: string };

export async function listManual(): Promise<Employee[]> {
  const sql = db();
  const rows = await sql<PersonRow[]>`
    select id, name, short from manual_people order by id desc
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, short: r.short }));
}

/**
 * Добавляет человека вручную и возвращает обновлённый список.
 *
 * Номер выдаётся здесь, а не в браузере: два администратора могли бы
 * одновременно дописать по стажёру и присвоить обоим один и тот же.
 * Всё в одной транзакции, чтобы между «посчитать номер» и «вставить»
 * никто не влез.
 */
export async function addManual(rawName: string): Promise<Employee[]> {
  const name = rawName.trim().replace(/\s+/g, " ");
  if (!name) return listManual();

  const sql = db();
  await sql.begin(async (tx) => {
    const same = await tx`
      select 1 from manual_people where lower(name) = lower(${name}) limit 1
    `;
    if (same.length > 0) return;

    const [next] = await tx<{ id: number }[]>`
      select coalesce(min(id), 0) - 1 as id from manual_people
    `;
    await tx`
      insert into manual_people (id, name, short)
      values (${next.id}, ${name}, ${name})
    `;
  });

  return listManual();
}

export async function deleteManual(id: number): Promise<Employee[]> {
  const sql = db();
  await sql`delete from manual_people where id = ${id}`;
  return listManual();
}
