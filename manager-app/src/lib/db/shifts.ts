"use server";

import { db } from "./sql";

/**
 * Сводка по сменам — первая страница бэк-офиса.
 *
 * Считаем в базе, а не в приложении: смен за год будет три с половиной сотни,
 * а записей в них — десятки тысяч. Тянуть их все на сервер, чтобы сложить,
 * значит однажды получить страницу, которая думает минуту.
 */

export type ShiftRow = {
  businessDay: string;
  records: number;
  cash: number;
  terminal: number;
  qr: number;
  service: number;
  tips: number;
  guestsGave: number;
  /** Трогали ли смену из бэк-офиса задним числом. */
  corrected: boolean;
};

type Raw = {
  business_day: string;
  records: string;
  cash: string;
  terminal: string;
  qr: string;
  service: string;
  gross: string;
  corrected: boolean;
};

export async function listShifts(limit = 30): Promise<ShiftRow[]> {
  const sql = db();
  const rows = await sql<Raw[]>`
    select
      business_day,
      count(*)                                              as records,
      coalesce(sum(amount) filter (where kind = 'cash'),     0) as cash,
      coalesce(sum(amount) filter (where kind = 'terminal'), 0) as terminal,
      coalesce(sum(amount) filter (where kind = 'qr'),       0) as qr,
      coalesce(sum(amount) filter (where kind = 'service'),  0) as service,
      coalesce(sum(gross)  filter (where kind <> 'staff'),   0) as gross,
      bool_or(source = 'office')                            as corrected
    from entries
    -- Отменённые не в счёт: они остаются в базе ради следа, но денег
    -- за ними нет. Сложить их значило бы показать смену больше, чем была.
    where deleted_at is null
    group by business_day
    order by business_day desc
    limit ${limit}
  `;

  return rows.map((r) => {
    const cash = Number(r.cash);
    const terminal = Number(r.terminal);
    const qr = Number(r.qr);
    return {
      businessDay: r.business_day,
      records: Number(r.records),
      cash,
      terminal,
      qr,
      service: Number(r.service),
      // Чаевые — это три вида денег. Сервисный сбор считается отдельно:
      // он входит в заработок официанта, но чаевыми не является.
      tips: cash + terminal + qr,
      guestsGave: Number(r.gross),
      corrected: Boolean(r.corrected),
    };
  });
}
