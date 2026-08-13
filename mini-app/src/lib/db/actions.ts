"use server";

import type { Employee, Entry, Kind, QrTip, Shift } from "../types";
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
  deleted_at: Date | null;
  deleted_by_name: string | null;
  hall_id: number | null;
  hall_title: string | null;
  table_id: number | null;
  table_title: string | null;
  waiter_id: number;
  waiter_name: string;
  amount: string;
  kind: string;
  operator_id: number;
  operator_name: string;
  created_at: Date;
  split_group: string | null;
  gross: string | null;
  commission_rate: string;
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
    // У записей, сделанных до появления комиссии, поля нет: тогда до официанта
    // доходило ровно то, что оставил гость.
    gross: r.gross === null ? Number(r.amount) : Number(r.gross),
    commissionRate: Number(r.commission_rate),
    kind: r.kind as Kind,
    operatorId: r.operator_id,
    operatorName: r.operator_name,
    createdAt: r.created_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
    deletedByName: r.deleted_by_name,
    splitGroup: r.split_group,
  };
}

/** Живые записи за смену: отменённые не в счёт. */
export async function listEntries(businessDay: string): Promise<Entry[]> {
  const sql = db();
  const rows = await sql<EntryRow[]>`
    select * from entries
    where business_day = ${businessDay} and deleted_at is null
    order by created_at desc
  `;
  return rows.map(toEntry);
}

/**
 * История за смену: всё, включая отменённое.
 *
 * Отдельно от listEntries намеренно: обычные экраны и отчёт про отменённые
 * знать не должны, иначе они попадут в суммы. История — единственное место,
 * где их видно.
 */
export async function listHistory(businessDay: string): Promise<Entry[]> {
  const sql = db();
  const rows = await sql<EntryRow[]>`
    select * from entries
    where business_day = ${businessDay}
    order by created_at desc
  `;
  return rows.map(toEntry);
}

/**
 * Кладёт запись в базу.
 *
 * Строк может быть несколько: одни чаевые, поделённые между официантами,
 * ложатся по строке на каждого. Всё одной транзакцией — если сохранится
 * половина группы, чаевые окажутся поделены на одного, и итог смены
 * разойдётся с тем, что оставил гость.
 *
 * «Если такой записи ещё нет» — защита от повтора. Номер записи придумывает
 * браузер до отправки, поэтому одну и ту же запись можно послать сколько
 * угодно раз: в базе останется одна. Без этого офлайн-очередь была бы опасна
 * ровно там, где она нужнее всего — отправили, ответ не дошёл, отправили
 * снова, и деньги задвоились.
 */
export async function insertEntries(entries: Entry[]): Promise<void> {
  if (entries.length === 0) return;
  const sql = db();
  await sql.begin(async (tx) => {
    for (const e of entries) {
      await tx`
        insert into entries (
          id, business_day, hall_id, hall_title, table_id, table_title,
          waiter_id, waiter_name, amount, kind, operator_id, operator_name,
          created_at, split_group, gross, commission_rate
        ) values (
          ${e.id}, ${e.businessDay}, ${e.hallId}, ${e.hallTitle},
          ${e.tableId}, ${e.tableTitle}, ${e.waiterId}, ${e.waiterName},
          ${e.amount}, ${e.kind}, ${e.operatorId}, ${e.operatorName},
          ${e.createdAt}, ${e.splitGroup ?? null}, ${e.gross},
          ${e.commissionRate}
        )
        on conflict (id) do nothing
      `;
    }
  });
}

/**
 * Отменяет запись, не стирая её.
 *
 * Если запись — часть поделённых чаевых, отменяется вся группа. Половина
 * чаевых без пары не значит ничего: она осталась бы висеть на одном официанте
 * и завысила бы его заработок ровно на ту долю, которую убрали у второго.
 *
 * Повторная отмена уже отменённой ничего не меняет — условие
 * «deleted_at is null» защищает от затирания времени первой отмены.
 */
export async function cancelEntry(
  id: string,
  operatorId: number,
  operatorName: string,
): Promise<void> {
  const sql = db();
  await sql`
    update entries
       set deleted_at = now(),
           deleted_by_id = ${operatorId},
           deleted_by_name = ${operatorName}
     where deleted_at is null
       and (
         id = ${id}
         -- У обычной записи метки нет, и подзапрос вернёт пусто: сравнение
         -- с пустотой не сработает, отменится ровно одна строка по id.
         or split_group = (
              select split_group from entries
               where id = ${id} and split_group is not null
            )
       )
  `;
}

type QrTipRow = {
  message_id: string;
  received_at: Date;
  business_day: string;
  amount: string;
  team: string;
};

/**
 * Все поступления по QR, которые ещё не разнесли по людям.
 *
 * Пока поступление здесь, деньги ничьи: в заработок официантов они не входят,
 * в итоги смены не попадают. Разносит их кассир.
 *
 * ⚠️ Раньше отбирались только поступления текущего бизнес-дня. Кассир, забывший
 * нажать до конца смены, терял их из виду навсегда: в 11 утра день сменялся,
 * полоса исчезала, а в бэк-офисе про эту таблицу вообще ничего нет. Деньги
 * оставались в базе живыми и невидимыми одновременно.
 *
 * Поэтому отдаём всё неразнесённое, независимо от дня. Старые поступления
 * всплывают на следующей смене и висят, пока их не разнесут, — а разносятся
 * они на свой день, а не на сегодняшний (см. distributeQrTip в TipsScreen).
 *
 * Порядок — от старых к новым: забытое вчера важнее пришедшего минуту назад.
 */
export async function listPendingQrTips(): Promise<QrTip[]> {
  const sql = db();
  const rows = await sql<QrTipRow[]>`
    select message_id, received_at, business_day, amount, team
      from qr_tips
     where distributed_at is null
     order by received_at
  `;
  return rows.map((r) => ({
    // bigint приезжает строкой: в JavaScript обычное число не вместило бы
    // все возможные идентификаторы Telegram без потери точности.
    messageId: Number(r.message_id),
    receivedAt: r.received_at.toISOString(),
    businessDay: r.business_day,
    amount: Number(r.amount),
    team: r.team,
  }));
}

/**
 * Что база уже знает о поступлениях по QR: номер последнего прочитанного
 * сообщения и время последнего.
 *
 * Ровно то же, что читатель Telegram брал у базы сам, пока мог до неё
 * дотянуться. С 13.08.2026 он живёт в Варшаве — иначе его режет РКН, — а там
 * внутреннее имя московской базы не разрешается вовсе. Поэтому он спрашивает
 * это у приложения по https, а в базу пишет уже приложение.
 */
export async function qrTipsState(): Promise<{
  sinceId: number | null;
  newestAt: string | null;
}> {
  const sql = db();
  const [строка] = await sql<{ max_id: string | null; max_at: Date | null }[]>`
    select max(message_id) as max_id, max(received_at) as max_at from qr_tips
  `;
  return {
    // bigint приезжает строкой: обычное число в JavaScript не вместило бы
    // все возможные идентификаторы Telegram без потери точности.
    sinceId: строка?.max_id == null ? null : Number(строка.max_id),
    newestAt: строка?.max_at == null ? null : строка.max_at.toISOString(),
  };
}

/** Одно поступление, как его присылает читатель Telegram. */
export type ВходящееQr = {
  messageId: number;
  receivedAt: string;
  businessDay: string;
  amount: number;
  team: string;
};

/**
 * Кладёт прочитанное читателем в `qr_tips`. Возвращает, сколько появилось.
 *
 * Повторы отсекает сама база: `message_id` — первичный ключ. Поэтому читатель
 * может присылать одно и то же сколько угодно раз, не разбираясь, что уже
 * записано, — это и делает пересылку безопасной при обрывах связи.
 */
export async function saveQrTips(поступления: ВходящееQr[]): Promise<number> {
  if (поступления.length === 0) return 0;
  const sql = db();
  let добавлено = 0;
  await sql.begin(async (tx) => {
    for (const п of поступления) {
      const появилось = await tx`
        insert into qr_tips
               (message_id, received_at, business_day, amount, team)
        values (${п.messageId}, ${п.receivedAt}, ${п.businessDay},
                ${п.amount}, ${п.team})
        on conflict (message_id) do nothing
        returning message_id
      `;
      if (появилось.length > 0) добавлено += 1;
    }
  });
  return добавлено;
}

/**
 * Разносит поступление по QR на официантов.
 *
 * Всё одной транзакцией: записи официантам и отметка «разнесено» должны
 * появиться вместе. Иначе поступление либо разнесётся дважды, либо деньги
 * лягут людям, а в списке ожидающих останется висеть.
 *
 * Условие «distributed_at is null» — защита от двух кассиров, нажавших
 * одновременно: второй ничего не обновит и получит отказ.
 */
export async function distributeQrTip(
  messageId: number,
  entries: Entry[],
  operatorName: string,
): Promise<void> {
  if (entries.length === 0) return;
  const sql = db();
  await sql.begin(async (tx) => {
    const marked = await tx`
      update qr_tips
         set distributed_at = now(), distributed_by = ${operatorName}
       where message_id = ${messageId} and distributed_at is null
       returning message_id
    `;
    if (marked.length === 0) {
      throw new Error("Это поступление уже разнесли");
    }
    for (const e of entries) {
      await tx`
        insert into entries (
          id, business_day, hall_id, hall_title, table_id, table_title,
          waiter_id, waiter_name, amount, kind, operator_id, operator_name,
          created_at, split_group, gross, commission_rate
        ) values (
          ${e.id}, ${e.businessDay}, ${e.hallId}, ${e.hallTitle},
          ${e.tableId}, ${e.tableTitle}, ${e.waiterId}, ${e.waiterName},
          ${e.amount}, ${e.kind}, ${e.operatorId}, ${e.operatorName},
          ${e.createdAt}, ${e.splitGroup ?? null}, ${e.gross},
          ${e.commissionRate}
        )
        on conflict (id) do nothing
      `;
    }
  });
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

export type ExportMark = { at: string; by: string };

/**
 * Когда смену выгрузили для отчёта и кто.
 *
 * Отдельным запросом, а не полем в Shift: состав смены читают на каждом
 * экране и по многу раз, а это нужно в одном месте — на экране итогов.
 */
export async function readExportMark(
  businessDay: string,
): Promise<ExportMark | null> {
  const sql = db();
  const rows = await sql<{ exported_at: Date | null; exported_by: string | null }[]>`
    select exported_at, exported_by from shifts where business_day = ${businessDay}
  `;
  const row = rows[0];
  if (!row?.exported_at) return null;
  return { at: row.exported_at.toISOString(), by: row.exported_by ?? "" };
}

/**
 * Отмечает смену выгруженной. Возвращает время, записанное базой.
 *
 * Время берём у базы, а не у телефона: часы на телефонах расходятся, а это
 * отметка о денежном документе. Перезаписываем при повторной выгрузке —
 * важно, когда смену выгрузили в последний раз, а не когда впервые.
 */
export async function markExported(
  businessDay: string,
  by: string,
): Promise<ExportMark> {
  const sql = db();
  const rows = await sql<{ exported_at: Date }[]>`
    update shifts
       set exported_at = now(), exported_by = ${by}
     where business_day = ${businessDay}
     returning exported_at
  `;
  // Строки смены может не быть, если состав ни разу не сохраняли. Тогда
  // отмечать нечего — но и выгрузка в этом случае пустая.
  const at = rows[0]?.exported_at ?? new Date();
  return { at: at.toISOString(), by };
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
