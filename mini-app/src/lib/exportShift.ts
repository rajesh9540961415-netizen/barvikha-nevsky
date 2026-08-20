import type { Shift } from "./crew";
import { getHookahPeople } from "./people";
import { HOOKAH_POT_ID, adminShares, splitShift, splitSide } from "./split";
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
  /**
   * Администратор смены. Оставлено ради совместимости: отчёт читает это поле
   * с 01.08.2026. Когда администраторов двое, здесь стоит ПЕРВЫЙ и его
   * половина — полную сумму смены брать надо из `admins`.
   */
  admin: { name: string | null; amount: number };
  /**
   * Все администраторы смены с их долями. Один — список из одного.
   *
   * Отдельным списком, а не двумя полями: доля делится пополам, и сумма
   * по списку обязана сходиться с отчислением смены при любом их числе.
   */
  admins: { name: string | null; amount: number }[];
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
  rows: {
    name: string;
    cash: number;
    /**
     * Дошло с терминала — доля со стола, которую гость попросил отдать
     * бару или хостес.
     *
     * ⚠️ Поле появилось 20.08.2026 вместе с самой возможностью. Без него
     * такая доля не попадала бы в отчёт вовсе: сборщик читает у боковых
     * блоков ровно те графы, что перечислены здесь, и лишнюю сумму
     * не искал бы никто — она просто не сошлась бы в «Расхождении».
     */
    terminal: number;
    qr: number;
    service: number;
    total: number;
  }[];
  totals: {
    cash: number;
    terminal: number;
    qr: number;
    service: number;
    total: number;
  };
};

export function buildExport(
  day: string,
  entries: Entry[],
  crew: Employee[],
  shift: Shift,
  everyone: Employee[],
): ShiftExport {
  const s = splitShift(entries, crew, day);
  // Сначала справочник, потом имена, сохранённые вместе со сменой.
  // Второе важнее первого по надёжности: справочник меняется, а смена —
  // документ, и в нём записано, кто работал В ТОТ ВЕЧЕР.
  const nameOf = (id: number | null) =>
    (id === null
      ? null
      : everyone.find((p) => p.id === id)?.name ?? shift.names?.[String(id)]) ??
    null;

  // Хостес — из общего списка зала и дописанных руками, кальянщики — из кассы
  // ИП Шалаевой. Расчёт добирает и тех, кого в составе смены уже нет, но
  // записи на них есть: спрятать настоящие деньги нельзя.
  // Администраторов может быть двое: смену делят надвое и работают по
  // очереди. Доля делится пополам — решение владельца 18.08.2026.
  const админы = [shift.admin, shift.admin2].filter(
    (id): id is number => id !== null && id !== undefined,
  );
  const доли = adminShares(s.adminTotal, админы.length || 1);

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
          terminal: r.terminal,
          qr: r.qr,
          service: r.service,
          total: r.total,
        })),
      totals: {
        cash: calc.totalCash,
        terminal: calc.totalTerminal,
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
    admin: { name: nameOf(админы[0] ?? null), amount: доли[0] ?? 0 },
    admins: админы.map((id, i) => ({ name: nameOf(id), amount: доли[i] })),
    cashier: { name: nameOf(shift.cashier), amount: s.cashierTotal },
    hostess: side("hostess", hostessPeople),
    hookah: side("hookah", hookahPeople),
    totals: {
      // ⚠️ Зальные итоги намеренно остались зальными: отчёт читает их
      // с 01.08.2026, и менять их смысл нельзя. Деньги хостес и бара —
      // в своих блоках, там же и их терминал.
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
