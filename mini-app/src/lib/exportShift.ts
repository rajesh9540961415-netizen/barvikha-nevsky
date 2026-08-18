import type { Shift } from "./crew";
import { getHookahPeople } from "./people";
import { HOOKAH_POT_ID, splitShift, splitSide } from "./split";
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
    /**
     * Разнесённые поступления с персонального QR.
     *
     * В отчёте отдельного блока под них пока нет — решение по формату
     * за владельцем. Но в выгрузке они есть, чтобы данные не потерялись:
     * дописать блок в скрипт проще, чем восстанавливать цифры задним числом.
     */
    qr: number;
    service: number;
    /**
     * Начислено: заработок минус доли администратору и кассиру.
     *
     * Питание отсюда НЕ вычитается и в выгрузку не попадает вовсе: отчёт
     * фиксирует выплаты в пользу сотрудника, а обед — его встречная покупка
     * у заведения. Решение владельца 08.08.2026.
     */
    accrued: number;
  }[];
  admin: { name: string | null; amount: number };
  cashier: { name: string | null; amount: number };
  /**
   * Хостес и кальянный бар — два котла, которые ни с кем не делятся.
   *
   * Отдельными разделами, а не строками среди официантов: в отчёте под них
   * свои блоки (хостес 8 строк, кальянный бар 10), а главное — у них нет
   * ни порога, ни отчислений. Попади они в `waiters`, любая проверка
   * «начислено = заработок минус доли» начала бы врать.
   *
   * Поля зальных итогов ниже намеренно оставлены как были: отчёт читает их
   * с 01.08.2026, и менять их смысл ради двух новых блоков нельзя.
   */
  hostess: SideExport;
  hookah: SideExport;
  totals: {
    cash: number;
    terminal: number;
    qr: number;
    service: number;
    earned: number;
    payout: number;
  };
};

export type SideExport = {
  rows: { name: string; cash: number; qr: number; service: number; total: number }[];
  totals: { cash: number; qr: number; service: number; total: number };
};

export function buildExport(
  day: string,
  entries: Entry[],
  crew: Employee[],
  shift: Shift,
  everyone: Employee[],
): ShiftExport {
  const s = splitShift(entries, crew, day);
  const nameOf = (id: number | null) =>
    everyone.find((p) => p.id === id)?.name ?? null;

  // Хостес — из общего списка зала и дописанных руками, кальянщики — из кассы
  // ИП Шалаевой. Расчёт добирает и тех, кого в составе смены уже нет, но
  // записи на них есть: спрятать настоящие деньги нельзя.
  const hostessPeople = everyone.filter((p) => shift.hostess.includes(p.id));
  const hookahPeople = getHookahPeople().filter(
    // Общий котёл бара в составе смены не отмечается, но получателем быть
    // может — поэтому он в списке всегда.
    (p) => shift.hookah.includes(p.id) || p.id === HOOKAH_POT_ID,
  );
  const side = (contour: "hostess" | "hookah", people: Employee[]): SideExport => {
    const calc = splitSide(entries, contour, people);
    return {
      rows: calc.rows
        // Пустые строки в отчёт не нужны: там блок фиксированной длины,
        // и человек без чаевых занял бы место того, у кого они были.
        .filter((r) => r.total > 0)
        .map((r) => ({
          // Полное имя, как и у официантов: в отчёте строки подписаны целиком.
          name: people.find((p) => p.id === r.payeeId)?.name ?? r.payeeName,
          cash: r.cash,
          qr: r.qr,
          service: r.service,
          total: r.total,
        })),
      totals: {
        cash: calc.totalCash,
        qr: calc.totalQr,
        service: calc.totalService,
        total: calc.total,
      },
    };
  };

  return {
    businessDay: day,
    operator: nameOf(shift.operator),
    waiters: s.waiters.map((w) => ({
      // Полное имя, а не короткое: в отчёте строки подписаны полностью.
      name: crew.find((p) => p.id === w.waiterId)?.name ?? w.waiterName,
      cash: w.cash,
      terminal: w.terminal,
      qr: w.qr,
      service: w.service,
      accrued: w.accrued,
    })),
    admin: { name: nameOf(shift.admin), amount: s.adminTotal },
    cashier: { name: nameOf(shift.cashier), amount: s.cashierTotal },
    hostess: side("hostess", hostessPeople),
    hookah: side("hookah", hookahPeople),
    totals: {
      cash: s.totalCash,
      terminal: s.totalTerminal,
      qr: s.totalQr,
      service: s.totalService,
      earned: s.totalEarned,
      // Сходится с earned без всяких поправок: раз питание не вычитается,
      // деньги гостей целиком расходятся по трём получателям.
      //
      // Раньше здесь к сумме отдельно прибавляли удержанное за питание —
      // иначе выгрузка не сходилась. Но это чинило только строку в выгрузке:
      // формула «Расхождение» в самом отчёте считает по своим ячейкам
      // и всё равно краснела ровно на размер питания.
      payout: s.waitersAccrued + s.adminTotal + s.cashierTotal,
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
