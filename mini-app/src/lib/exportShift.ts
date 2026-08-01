import type { Shift } from "./crew";
import { splitShift } from "./split";
import type { Employee, Entry } from "./types";

/**
 * Выгрузка смены в файл для отчёта.
 *
 * Приложение отдаёт JSON, скрипт scripts/report_fill.py вписывает его
 * в столбец нужной даты в «Чаевые-дубль-<месяц>.xlsx».
 *
 * Почему файлом, а не сразу в таблицу: приложение живёт в браузере и
 * писать в файл на диске не может. Когда появится общее хранилище,
 * скрипт будет забирать данные оттуда сам.
 */

export type ShiftExport = {
  businessDay: string;
  operator: string | null;
  waiters: {
    name: string;
    cash: number;
    terminal: number;
    service: number;
    net: number;
  }[];
  admin: { name: string | null; amount: number };
  cashier: { name: string | null; amount: number };
  totals: {
    cash: number;
    terminal: number;
    service: number;
    earned: number;
    payout: number;
  };
};

export function buildExport(
  day: string,
  entries: Entry[],
  crew: Employee[],
  shift: Shift,
  everyone: Employee[],
): ShiftExport {
  const s = splitShift(entries, crew);
  const nameOf = (id: number | null) =>
    everyone.find((p) => p.id === id)?.name ?? null;

  return {
    businessDay: day,
    operator: nameOf(shift.operator),
    waiters: s.waiters.map((w) => ({
      // Полное имя, а не короткое: в отчёте строки подписаны полностью.
      name: crew.find((p) => p.id === w.waiterId)?.name ?? w.waiterName,
      cash: w.cash,
      terminal: w.terminal,
      service: w.service,
      net: w.net,
    })),
    admin: { name: nameOf(shift.admin), amount: s.adminTotal },
    cashier: { name: nameOf(shift.cashier), amount: s.cashierTotal },
    totals: {
      cash: s.totalCash,
      terminal: s.totalTerminal,
      service: s.totalService,
      earned: s.totalEarned,
      payout: s.waitersNet + s.adminTotal + s.cashierTotal,
    },
  };
}

/** Скачивает выгрузку файлом. */
export function downloadExport(data: ShiftExport): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `смена-${data.businessDay}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
