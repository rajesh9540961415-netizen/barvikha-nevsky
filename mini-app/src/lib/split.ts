import type { Employee, Entry } from "./types";

/**
 * Деление денег зала за смену.
 *
 * Правила со слов владельца, подробности и примеры — в
 * .business/economics/tips.md.
 *
 * Официант получает два вида денег:
 *   — чаевые от гостя: наличные и через терминал;
 *   — сервисный сбор: 10 % от чека, автоматически большим компаниям.
 * Оба выдаются в тот же день и оба считаются его заработком за смену.
 *
 * Из заработка он делится:
 *   1. Меньше 1300 ₽ за смену — не отдаёт ничего. Порог защищает тех,
 *      кто вышел в слабую смену.
 *   2. От 1300 ₽:
 *      — администратору 20 % от ВСЕГО заработка, не от превышения;
 *      — кассиру доля от общей суммы, поделённой на число официантов смены.
 *
 * Сумма для кассира зависит от дня: в пятницу и субботу смены самые
 * сильные, поэтому кассиру отдают 1000 ₽ вместо обычных 750 ₽.
 * Порог 1300 ₽ при этом не меняется.
 *
 * Кассиру доля идёт только с чаевых: сервисный сбор его не касается.
 * Поэтому официант, у которого чаевых нет вовсе, кассиру не платит.
 *
 * Тонкость по кассиру: делим сумму на всех, кто работал, но платят
 * только перешагнувшие порог. Кассир обычно получает меньше полной
 * суммы — это потолок, а не гарантия.
 */

export const THRESHOLD = 1300;
export const ADMIN_RATE = 0.2;
export const CASHIER_POOL_REGULAR = 750;
export const CASHIER_POOL_BUSY = 1000;

/**
 * Сколько уходит кассиру за смену: 1000 ₽ в пятницу и субботу, иначе 750 ₽.
 *
 * День берём по бизнес-дню, а он пишется на дату НАЧАЛА смены. Пятничная
 * смена работает до утра субботы, но считается пятничной — и по ней кассиру
 * идёт 1000 ₽. Именно поэтому здесь ключ бизнес-дня, а не текущая дата.
 */
export function cashierPool(businessDay: string): number {
  const [year, month, day] = businessDay.split("-").map(Number);
  // Собираем дату по частям: разбор строки целиком дал бы UTC-полночь,
  // и день недели мог бы съехать на сутки.
  const weekday = new Date(year, month - 1, day).getDay();
  const FRIDAY = 5;
  const SATURDAY = 6;
  return weekday === FRIDAY || weekday === SATURDAY
    ? CASHIER_POOL_BUSY
    : CASHIER_POOL_REGULAR;
}

export type WaiterSplit = {
  waiterId: number;
  waiterName: string;
  cash: number;
  terminal: number;
  service: number;
  /** Чаевые без сервисного сбора. */
  tips: number;
  /** Весь заработок за смену: чаевые плюс сервисный сбор. */
  total: number;
  aboveThreshold: boolean;
  toAdmin: number;
  toCashier: number;
  net: number;
};

export type ShiftSplit = {
  crewSize: number;
  /** Сколько всего уходит кассиру за эту смену: 750 ₽ или 1000 ₽. */
  cashierPool: number;
  /** Сумма кассира ÷ число официантов смены. */
  cashierShare: number;
  waiters: WaiterSplit[];
  totalCash: number;
  totalTerminal: number;
  totalService: number;
  totalEarned: number;
  adminTotal: number;
  cashierTotal: number;
  waitersNet: number;
};

/** Деньги округляем до копеек: 750 ÷ 7 иначе даёт бесконечную дробь. */
function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function splitShift(
  entries: Entry[],
  crew: Employee[],
  businessDay: string,
): ShiftSplit {
  const crewSize = crew.length;
  const pool = cashierPool(businessDay);
  const cashierShare = crewSize > 0 ? money(pool / crewSize) : 0;

  // В смене учитываем всех отмеченных, даже если человек не получил ничего:
  // он всё равно считается в знаменателе доли кассира.
  const waiters: WaiterSplit[] = crew.map((person) => {
    const mine = entries.filter((e) => e.waiterId === person.id);
    const by = (kind: Entry["kind"]) =>
      mine.filter((e) => e.kind === kind).reduce((sum, e) => sum + e.amount, 0);

    const cash = by("cash");
    const terminal = by("terminal");
    const service = by("service");
    const tips = cash + terminal;
    const total = tips + service;
    const aboveThreshold = total >= THRESHOLD;

    const toAdmin = aboveThreshold ? money(total * ADMIN_RATE) : 0;
    // Сервисный сбор кассира не касается: без чаевых доли нет.
    const toCashier = aboveThreshold && tips > 0 ? cashierShare : 0;

    return {
      waiterId: person.id,
      waiterName: person.short,
      cash,
      terminal,
      service,
      tips,
      total,
      aboveThreshold,
      toAdmin,
      toCashier,
      net: money(total - toAdmin - toCashier),
    };
  });

  waiters.sort((a, b) => b.total - a.total);

  const sum = (pick: (w: WaiterSplit) => number) =>
    money(waiters.reduce((acc, w) => acc + pick(w), 0));

  return {
    crewSize,
    cashierPool: pool,
    cashierShare,
    waiters,
    totalCash: sum((w) => w.cash),
    totalTerminal: sum((w) => w.terminal),
    totalService: sum((w) => w.service),
    totalEarned: sum((w) => w.total),
    adminTotal: sum((w) => w.toAdmin),
    cashierTotal: sum((w) => w.toCashier),
    waitersNet: sum((w) => w.net),
  };
}
