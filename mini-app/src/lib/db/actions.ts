"use server";

import { СТАВКИ_ПО_УМОЛЧАНИЮ } from "../hookahMotivation";
import type { МотивацияСмены, СтрокаСчёта } from "../hookahMotivation";
import { кассаДоступна, продажиИзКассы } from "../hookahLive";
import { HOOKAH_POT_ID } from "../split";
import type { Contour, Employee, Entry, Kind, QrTip, Shift } from "../types";
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
  corrects: string | null;
  deleted_note: string | null;
  contour: string | null;
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
    // У записей до 18.08.2026 контура в базе нет — все они зальные.
    contour: (r.contour ?? "hall") as Contour,
    operatorId: r.operator_id,
    operatorName: r.operator_name,
    createdAt: r.created_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
    deletedByName: r.deleted_by_name,
    deletedNote: r.deleted_note,
    splitGroup: r.split_group,
    // Что заменила эта запись. История по этому полю отличает «поправлено»
    // от «отменено»: в базе оба случая выглядят одинаково — отменённой строкой.
    corrects: r.corrects,
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
          created_at, split_group, gross, commission_rate, contour
        ) values (
          ${e.id}, ${e.businessDay}, ${e.hallId}, ${e.hallTitle},
          ${e.tableId}, ${e.tableTitle}, ${e.waiterId}, ${e.waiterName},
          ${e.amount}, ${e.kind}, ${e.operatorId}, ${e.operatorName},
          ${e.createdAt}, ${e.splitGroup ?? null}, ${e.gross},
          ${e.commissionRate}, ${e.contour ?? "hall"}
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Правка записи смены: старое событие заменяется новым.
 *
 * Одной транзакцией: старые строки помечаются отменёнными, новые встают
 * на их место со ссылкой `corrects`. Если разорвать, смена на секунду
 * окажется либо без этих денег вовсе, либо с ними дважды — а в эту секунду
 * кто-нибудь откроет итоги.
 *
 * Запись не переписывается на месте намеренно: это денежный документ,
 * и через год должно быть видно не только «сколько», но и «что было
 * до того, как поправили, кто поправил и когда».
 *
 * Возвращает, применилась ли правка. `false` — событие успели отменить
 * или поправить раньше (например, управляющий из бэк-офиса), и наши строки
 * НЕ вставлены: иначе в смене оказались бы две копии одних денег.
 *
 * ⚠️ Ошибку здесь не бросаем. Очередь отправки идёт строго по порядку
 * и на ошибке встаёт целиком — ошибка, которая не пройдёт никогда, заперла бы
 * очередь, и вместе с правкой перестали бы уходить все следующие чаевые.
 * Поэтому отказ — это обычный ответ, а не сбой отправки.
 */
export async function correctEntries(input: {
  businessDay: string;
  /** Что заменяем: метка группы у поделённых, номер записи у обычной. */
  key: string;
  fresh: Entry[];
  operatorId: number;
  operatorName: string;
}): Promise<{ applied: boolean }> {
  if (!UUID.test(input.key) || input.fresh.length === 0) {
    return { applied: false };
  }
  const sql = db();

  return sql.begin(async (tx) => {
    const gone = await tx<{ id: string }[]>`
      update entries
         set deleted_at = now(),
             deleted_by_id = ${input.operatorId},
             deleted_by_name = ${input.operatorName}
       where business_day = ${input.businessDay}
         and deleted_at is null
         and coalesce(split_group, id) = ${input.key}::uuid
      returning id
    `;

    if (gone.length === 0) {
      // Отменять было нечего. Либо это повтор отправки — тогда наши строки
      // уже лежат в базе и делать нечего, — либо событие поправил кто-то
      // другой, и тогда вставлять наши строки нельзя ни в коем случае.
      const [mine] = await tx<{ id: string }[]>`
        select id from entries where id = ${input.fresh[0].id}
      `;
      return { applied: Boolean(mine) };
    }

    for (const e of input.fresh) {
      await tx`
        insert into entries (
          id, business_day, hall_id, hall_title, table_id, table_title,
          waiter_id, waiter_name, amount, kind, operator_id, operator_name,
          created_at, split_group, gross, commission_rate, corrects, source,
          contour
        ) values (
          ${e.id}, ${e.businessDay}, ${e.hallId}, ${e.hallTitle},
          ${e.tableId}, ${e.tableTitle}, ${e.waiterId}, ${e.waiterName},
          ${e.amount}, ${e.kind}, ${e.operatorId}, ${e.operatorName},
          ${e.createdAt}, ${e.splitGroup ?? null}, ${e.gross},
          ${e.commissionRate}, ${input.key}::uuid, 'shift', ${e.contour ?? "hall"}
        )
        on conflict (id) do nothing
      `;
    }
    return { applied: true };
  });
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
 *
 * ⚠️ **Номер берём только среди свежих записей, за последнюю неделю.**
 *
 * 14.08.2026 выяснилось, почему это важно. Группу «Сберчаевые Нев»
 * преобразовали в супергруппу, и Telegram начал нумерацию сообщений заново:
 * у поступления от 13 августа номер 10, а у пробы от 4 августа — 775. Читатель
 * просил «дай всё, что новее 775» и честно не находил ничего: новых сообщений
 * с такими номерами не бывает и не будет ещё месяцев пять.
 *
 * Ограничение неделей чинит это само и без ручного вмешательства: старый номер
 * перестаёт быть ориентиром, читатель разово перечитывает историю по датам
 * (`QR_SINCE_DAY`), а как только запишет свежее — снова пойдёт по номерам,
 * уже по новым. Повторов не будет: номер сообщения остаётся первичным ключом.
 *
 * Правило шире одного случая: **номер, выданный чужой системой, годится как
 * ориентир только пока эта система не начала нумерацию заново.** Дата — годится
 * всегда.
 */
export async function qrTipsState(): Promise<{
  sinceId: number | null;
  newestAt: string | null;
  сколько: number;
  самыйМаленькийНомер: number | null;
  неразнесённые: {
    всего: number;
    сколько: number;
    /** По бизнес-дням: «2026-08-11» → 1300. */
    поДням: Record<string, number>;
  };
}> {
  const sql = db();
  const [строка] = await sql<
    {
      max_id: string | null;
      min_id: string | null;
      max_at: Date | null;
      сколько: string;
    }[]
  >`
    select (select max(message_id) from qr_tips
             where received_at > now() - interval '7 days') as max_id,
           (select min(message_id) from qr_tips)            as min_id,
           (select max(received_at) from qr_tips)           as max_at,
           (select count(*) from qr_tips)                   as "сколько"
  `;
  // Неразнесённые — отдельным запросом и отдельным полем.
  //
  // ⚠️ Зачем это здесь. Пока кассир не разнёс поступление, деньги не лежат
  // ни у кого в записях, и в отчёте их не видно ВОВСЕ. Ноль по QR выглядит
  // одинаково в двух случаях: «сегодня по QR не платили» и «десять дней
  // не доезжает». Второй случай в августе 2026 стоил 32 тыс. ₽ и десяти
  // суток — и заметили его глазами, а не отчётом.
  //
  // Поле добавлено к прежнему ответу, а не отдано новым адресом: варшавский
  // робот спрашивает это же место и читает из ответа только `sinceId`
  // и `newestAt` через `.get()`. Лишние поля он не замечает.
  const ожидают = await sql<{ business_day: string; сумма: string; сколько: string }[]>`
    select business_day, sum(amount) as "сумма", count(*) as "сколько"
      from qr_tips
     where distributed_at is null
     group by business_day
     order by business_day
  `;
  const поДням: Record<string, number> = {};
  let всего = 0;
  let штук = 0;
  for (const о of ожидают) {
    const сумма = Number(о.сумма);
    поДням[о.business_day] = сумма;
    всего += сумма;
    штук += Number(о.сколько);
  }

  return {
    // bigint приезжает строкой: обычное число в JavaScript не вместило бы
    // все возможные идентификаторы Telegram без потери точности.
    sinceId: строка?.max_id == null ? null : Number(строка.max_id),
    newestAt: строка?.max_at == null ? null : строка.max_at.toISOString(),
    сколько: Number(строка?.сколько ?? 0),
    самыйМаленькийНомер: строка?.min_id == null ? null : Number(строка.min_id),
    неразнесённые: { всего: Math.round(всего * 100) / 100, сколько: штук, поДням },
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
          created_at, split_group, gross, commission_rate, contour
        ) values (
          ${e.id}, ${e.businessDay}, ${e.hallId}, ${e.hallTitle},
          ${e.tableId}, ${e.tableTitle}, ${e.waiterId}, ${e.waiterName},
          ${e.amount}, ${e.kind}, ${e.operatorId}, ${e.operatorName},
          ${e.createdAt}, ${e.splitGroup ?? null}, ${e.gross},
          ${e.commissionRate}, ${e.contour ?? "hall"}
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
  admin2_id: number | null;
  cashier_id: number | null;
  hostess: number[] | null;
  hookah: number[] | null;
  names: Record<string, string> | null;
};

function toShift(r: ShiftRow): Shift {
  return {
    crew: r.crew,
    operator: r.operator_id,
    admin: r.admin_id,
    admin2: r.admin2_id ?? null,
    cashier: r.cashier_id,
    // У смен до 18.08.2026 этих столбцов не было: пусто значит «никого».
    hostess: r.hostess ?? [],
    hookah: r.hookah ?? [],
    names: r.names ?? {},
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

  // ⚠️ Повторов в составе быть не должно: раскладка перебирает состав,
  // и номер, попавший туда дважды, приносит человеку двойные деньги, а долю
  // кассира делит на лишнего. 20.08.2026 так и вышло на 11 августа.
  //
  // Чистим ЗДЕСЬ, на входе в базу, а не только в расчёте. Расчёт починили
  // в тот же день, и он повтор переживает; но пока повтор лежит в данных,
  // его переживает КАЖДЫЙ, кто их читает, — и завтрашний читатель о нём
  // не знает. Кривое лечится там, где записывается.
  const без_повторов = {
    ...shift,
    crew: [...new Set(shift.crew)],
    hostess: [...new Set(shift.hostess ?? [])],
    hookah: [...new Set(shift.hookah ?? [])],
  };

  await sql`
    insert into shifts (
      business_day, crew, operator_id, admin_id, admin2_id, cashier_id,
      hostess, hookah, names
    )
    values (
      ${businessDay}, ${без_повторов.crew}, ${без_повторов.operator},
      ${без_повторов.admin}, ${без_повторов.admin2 ?? null}, ${без_повторов.cashier},
      ${без_повторов.hostess}, ${без_повторов.hookah},
      ${sql.json(без_повторов.names ?? {})}
    )
    on conflict (business_day) do update set
      crew = excluded.crew,
      operator_id = excluded.operator_id,
      admin_id = excluded.admin_id,
      admin2_id = excluded.admin2_id,
      cashier_id = excluded.cashier_id,
      hostess = excluded.hostess,
      hookah = excluded.hookah,
      names = excluded.names,
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

type PersonRow = {
  id: number;
  name: string;
  short: string;
  hidden_at: Date | null;
  merged_into: number | null;
  in_hookah: boolean;
};

/**
 * Все вписанные руками — и те, кого убрали из списка, тоже.
 *
 * ⚠️ Именно все, а не только видимые, и это не небрежность. По этому списку
 * ищут имя по номеру: и выгрузка смены, и экран чаевых. Пропади убранный
 * человек отсюда — его прошлые записи снова остались бы без имени, то есть
 * мы бы починили одну дыру и открыли ту же самую рядом.
 *
 * Кого показывать в списке выбора, решает экран: он отбирает по `hidden`.
 * Решение «не показывать» принимается там, где показывают, а не там,
 * где читают из базы.
 *
 * ⚠️ Заодно считаем `вБаре` — отмечали ли человека хоть раз в составе
 * кальянного бара. Считаем по самим сменам, а не по отдельной пометке:
 * факт «работал в баре» уже записан в составе прошлых вечеров, и второй
 * источник правды тут не нужен. Смен в базе десятки, проверка дешёвая.
 */
export async function listManual(): Promise<Employee[]> {
  const sql = db();
  const rows = await sql<PersonRow[]>`
    select p.id, p.name, p.short, p.hidden_at, p.merged_into,
           exists (
             select 1 from shifts s where p.id = any(s.hookah)
           ) as in_hookah
      from manual_people p order by p.id desc
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    short: r.short,
    hidden: r.hidden_at !== null,
    mergedInto: r.merged_into ?? undefined,
    вБаре: r.in_hookah,
  }));
}

/**
 * Добавляет человека вручную и возвращает обновлённый список.
 *
 * Номер выдаётся здесь, а не в браузере: два администратора могли бы
 * одновременно дописать по стажёру и присвоить обоим один и тот же.
 * Всё в одной транзакции, чтобы между «посчитать номер» и «вставить»
 * никто не влез.
 *
 * ⚠️ Имя уже есть в списке — человека НЕ заводим второй раз, а возвращаем
 * того же. Если он был убран, пометка снимается.
 *
 * 💡 Почему это важнее, чем кажется. Стажёр ушёл в сентябре и вернулся
 * в ноябре — обычное дело. В зале никто не пойдёт в бэк-офис искать его
 * среди убранных: там просто наберут имя заново. Заведи мы на это второго
 * человека — у одного работника стало бы два номера и две истории, то есть
 * ровно тот двойник, ради избавления от которого всё и затевалось.
 *
 * Возвращаем ещё и `вернулся`: экрану надо сказать администратору, что
 * человек нашёлся старый, а не завёлся новый. Молчание здесь читалось бы
 * как «кнопка не сработала» — до 19.08.2026 так и было.
 */
export async function addManual(
  rawName: string,
): Promise<{ люди: Employee[]; вернулся: string | null }> {
  const name = rawName.trim().replace(/\s+/g, " ");
  if (!name) return { люди: await listManual(), вернулся: null };

  const sql = db();
  let вернулся: string | null = null;

  await sql.begin(async (tx) => {
    const [same] = await tx<{ id: number; name: string; hidden_at: Date | null }[]>`
      select id, name, hidden_at from manual_people
       where lower(name) = lower(${name}) limit 1
    `;
    if (same) {
      if (same.hidden_at !== null) {
        await tx`update manual_people set hidden_at = null where id = ${same.id}`;
        вернулся = `${same.name} уже был в списке — вернули его, а не завели заново.`;
      } else {
        вернулся = `${same.name} и так в списке.`;
      }
      return;
    }

    const [next] = await tx<{ id: number }[]>`
      select coalesce(min(id), 0) - 1 as id from manual_people
    `;
    await tx`
      insert into manual_people (id, name, short)
      values (${next.id}, ${name}, ${name})
    `;
  });

  return { люди: await listManual(), вернулся };
}

/** Возвращает убранного человека в список выбора. */
export async function unhideManual(id: number): Promise<Employee[]> {
  const sql = db();
  await sql`update manual_people set hidden_at = null where id = ${id}`;
  return listManual();
}

/**
 * Чем кончилась попытка убрать человека: список после неё и что сказать вслух.
 *
 * Ответ — обычное значение, а не брошенная ошибка. Серверное действие,
 * упавшее с ошибкой, доезжает до телефона без текста: Next.js заменяет
 * его общей фразой, чтобы наружу не утекли внутренности. Человеку в зале
 * нужны слова, а не «что-то пошло не так».
 */
export type Удаление = { люди: Employee[]; сказать: string | null };

/**
 * Убирает вписанного руками человека из списка выбора.
 *
 * ⚠️ Строку из базы стирает только в одном случае — когда за человеком
 * нет ничего: ни записей о деньгах, ни единой смены. Это случай опечатки:
 * имя набрали неверно и стирают тут же. Во всех остальных случаях строка
 * ОСТАЁТСЯ, а человек получает пометку «убран» и пропадает только с экрана
 * сбора смены.
 *
 * Почему так. Записи о чаевых хранят номер человека, а не ссылку на него.
 * Сотри строку — записи останутся с номером, по которому больше некого
 * найти, и деньги молча выпадут из расчёта. 19.08.2026 так потерялись
 * 12 900,96 ₽ у Елизаветы Пархоменко, и заметили это только сверкой
 * с бумажными листами, на шестой день.
 *
 * 💡 Убрать и удалить — разные вещи, и первое время это будет путать.
 * Удаление рвёт связь с деньгами. Убирание — только с экраном: прошлые
 * смены, отчёты и страница «Люди» видят человека как раньше. Ровно так же
 * устроена касса Quick Resto: уволенный помечается `blocked` и пропадает
 * из списка, а его прошлые деньги — нет.
 *
 * Оба обычных случая ведут сюда: стажёра оформили в кассе (дальше его
 * отмечают под номером оттуда) или стажёр ушёл, не оформившись. Разница
 * только в том, есть ли кому его заменить.
 */
export async function deleteManual(id: number): Promise<Удаление> {
  const sql = db();

  // Человека может уже не быть: два администратора нажали одно и то же.
  // Тогда просто отдаём список, без слов — говорить не о чем.
  const найден = await sql<{ name: string }[]>`
    select name from manual_people where id = ${id}
  `;
  if (найден.length === 0) return { люди: await listManual(), сказать: null };
  const имя = найден[0].name;

  const [{ записей }] = await sql<{ записей: number }[]>`
    select count(*)::int as записей
      from entries
     where waiter_id = ${id} and deleted_at is null
  `;

  // Состав смотрим отдельно от записей: человека могли отметить в смене,
  // а денег он в тот вечер не получил вовсе. Пропусти мы этот случай —
  // доля кассира разделилась бы на меньшее число людей, то есть остальные
  // получили бы больше положенного. Тихо и в чужую пользу.
  const [{ смен }] = await sql<{ смен: number }[]>`
    select count(*)::int as смен
      from shifts
     where ${id} = any(crew)
        or ${id} = any(hostess)
        or ${id} = any(hookah)
        or operator_id = ${id}
        or admin_id = ${id}
        or admin2_id = ${id}
        or cashier_id = ${id}
  `;

  if (записей === 0 && смен === 0) {
    // За человеком нет ничего — это опечатка, а не работник. Стираем.
    await sql`delete from manual_people where id = ${id}`;
    return { люди: await listManual(), сказать: null };
  }

  await sql`update manual_people set hidden_at = now() where id = ${id}`;

  const хвост =
    записей > 0
      ? `${записей} ${plural(записей, "запись", "записи", "записей")} о деньгах`
      : `${смен} ${plural(смен, "смена", "смены", "смен")}`;
  return {
    люди: await listManual(),
    сказать:
      `${имя} убран из списка. ${хвост} — на месте: ` +
      "прошлые смены и отчёты считаются как раньше. " +
      "Понадобится снова — просто впишите это же имя.",
  };
}

/**
 * Мотивация кальянного бара за смену: штуки по типам и ставки.
 *
 * 🔴 **Сначала спрашиваем КАССУ, и только потом базу.** Владелец 08.09.2026:
 * экран нужен, «чтобы администратор в оперативном режиме видел объём продаж
 * и к концу смены мог дать цифру по мотивации». В базе лежит посчитанное
 * утром, то есть вчерашняя смена, — этой цели она не решает.
 *
 * Запасной путь остаётся и включается сам: касса не ответила, доступов
 * в переменных нет, Amvera наружу не пустила — экран покажет посчитанное
 * утром и скажет, что живой связи нет. Пустым он не остаётся никогда.
 *
 * ⚠️ **Здесь ничего не считается — только собирается.** Что чем считается,
 * решают правила в `hookah-motivation.json`: их читает и разбор ответа кассы
 * (`hookahLive.ts`), и счётчик на Маке. 08.09.2026 три ошибки счёта выросли
 * из того, что одно правило жило в двух местах разными словами.
 *
 * 🔴 **Денег в ответе нет.** Столбец `amount` в таблице есть, и его тут
 * намеренно не спрашивают: выручку сотрудникам показывать нельзя (владелец
 * 06.09.2026), а самый надёжный способ её не показать — не привозить
 * на телефон вовсе. Из ответа кассы суммы не берутся по той же причине.
 */
export async function readHookahMotivation(
  businessDay: string,
): Promise<МотивацияСмены> {
  const sql = db();

  const строкиСтавок = await sql<{ category: string; rate: number }[]>`
    select category, rate::float8 as rate from hookah_rates
  `;
  // Чего нет в базе — берётся из общего файла правил. Так экран считает
  // и до первой правки ставок в бэк-офисе.
  const ставки: Record<string, number> = { ...СТАВКИ_ПО_УМОЛЧАНИЮ };
  for (const с of строкиСтавок) ставки[с.category] = с.rate;

  if (кассаДоступна()) {
    try {
      const продажи = await продажиИзКассы(businessDay);
      const смена = await readShift(businessDay);
      return { день: businessDay, продажи, ставки, ...состав(смена), живое: true };
    } catch {
      // Молчим и идём запасным путём: без связи с кассой экран должен
      // работать, а не падать. Что цифры не живые, он скажет сам.
    }
  }

  const [последний] = await sql<{ day: string }[]>`
    select business_day as day
      from hookah_sales
     where business_day <= ${businessDay}
     order by business_day desc
     limit 1
  `;

  if (!последний) {
    return {
      день: null, продажи: [], ставки, бар: [], имена: {}, живое: false,
    };
  }

  // Состав ТОЙ смены, а не сегодняшней: доплату делят между теми, кто
  // работал в тот вечер. Запасным путём экран показывает вчерашний.
  const смена = await readShift(последний.day);
  const продажи = await sql<СтрокаСчёта[]>`
    select position, category, qty::float8 as qty
      from hookah_sales
     where business_day = ${последний.day}
     order by position
  `;

  return {
    день: последний.day,
    продажи: [...продажи],
    ставки,
    ...состав(смена),
    живое: false,
  };
}

/**
 * Кто был в баре в ту смену и как их звали.
 *
 * ⚠️ Общий котёл в составе — не человек, и в делителе ему не место: попади
 * он туда, доля каждого молча уменьшилась бы. В выборе состава его нет,
 * но данные приходят и из прошлого, а прошлое чинить поздно.
 */
function состав(смена: Shift | null): { бар: number[]; имена: Record<string, string> } {
  return {
    бар: (смена?.hookah ?? []).filter((id) => id !== HOOKAH_POT_ID),
    имена: смена?.names ?? {},
  };
}

// Та же функция и с тем же телом, что в offline.ts и на пяти экранах:
// в этом проекте её держат местной копией в каждом файле, а не общим модулем.
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
