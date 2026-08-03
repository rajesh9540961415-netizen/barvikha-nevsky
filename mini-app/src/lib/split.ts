import type { Employee, Entry, Kind } from "./types";

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

/**
 * Комиссия, которую удерживает Сбер с чаевых на терминале.
 *
 * Гость оставляет одну сумму, а до официанта доходит меньше: комиссия идёт
 * **с получателя** — так помечена каждая строка в выгрузке личного кабинета
 * Сбер Чаевых. Поэтому администратор вводит полную сумму с терминала, а
 * дальше в расчётах участвует то, что дошло.
 *
 * Наличные и сервисный сбор идут мимо Сбера, там ноль. Про персональный QR
 * пока не решено — он появится отдельной задачей.
 */
export const COMMISSION_RATE: Record<Kind, number> = {
  cash: 0,
  terminal: 0.08,
  service: 0,
  // У QR комиссию удерживают до уведомления: в Telegram приходит уже чистая
  // сумма. К тому же ставки там нет — гость сам решает, платить комиссию
  // самому или оставить её на официанта.
  qr: 0,
  // Стафф — не доход, а вычет. Комиссии тут быть не может.
  staff: 0,
};

/** Сколько дойдёт до официанта из того, что оставил гость. */
export function netAmount(gross: number, kind: Kind): number {
  const rate = COMMISSION_RATE[kind];
  return rate ? money(gross * (1 - rate)) : gross;
}

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
  /** Разнесённые по людям поступления с персонального QR. */
  qr: number;
  service: number;
  /** Чаевые без сервисного сбора: наличные, терминал и QR. */
  tips: number;
  /** Весь заработок за смену: чаевые плюс сервисный сбор. */
  total: number;
  /**
   * Сколько человек проел за смену — вычитается из выплаты.
   *
   * Вычитается всегда, независимо от того, сколько он заработал
   * (подтверждено владельцем 03.08.2026). На порог 1300 ₽ не влияет:
   * порог про то, сколько человек наработал, а обед — его личная трата.
   */
  staff: number;
  /** Сколько оставили гости — до комиссии Сбера. */
  gross: number;
  /** Сколько из этого удержал Сбер. */
  commission: number;
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
  totalQr: number;
  /**
   * Все чаевые смены без сервисного сбора.
   *
   * Считается здесь, а не складывается по видам на экране: когда появился
   * QR, сумма на экране осталась старой и молча показывала ноль при тысяче
   * в раскладке. Видов денег будет больше — складывать их руками нельзя.
   */
  totalTips: number;
  totalService: number;
  /** Сколько всего удержано за питание сотрудников. */
  totalStaff: number;
  totalEarned: number;
  /** Сколько оставили гости за смену — до комиссии. */
  totalGross: number;
  /** Сколько из этого удержал Сбер. */
  totalCommission: number;
  adminTotal: number;
  cashierTotal: number;
  waitersNet: number;
};

/** Деньги округляем до копеек: 750 ÷ 7 иначе даёт бесконечную дробь. */
function money(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Делит одни чаевые между несколькими официантами поровну.
 *
 * Большой стол обслуживают вдвоём, и гость оставляет чаевые за стол целиком.
 * Администратор вводит сумму гостя как есть, а делит её приложение — считать
 * половину в уме посреди зала он не должен.
 *
 * Доли в сумме дают ровно исходную сумму, копейка в копейку: 2 501 ₽ на двоих
 * — это 1 250,51 и 1 250,50, а 100 ₽ на троих — 33,34, 33,33 и 33,33. Остаток
 * достаётся первому. Иначе итог смены разошёлся бы с тем, что гость оставил,
 * а строка «Расхождение» в отчёте для того и заведена, чтобы такого не было.
 */
export function shares(amount: number, count: number): number[] {
  if (count <= 1) return [amount];
  // Считаем в копейках целыми числами: 0.1 + 0.2 в дробных даёт
  // 0.30000000000000004, и на сотне записей такие хвосты сложились бы
  // в заметную ошибку.
  const kopecks = Math.round(amount * 100);
  const base = Math.floor(kopecks / count);
  const extra = kopecks - base * count;
  return Array.from(
    { length: count },
    (_, i) => (base + (i < extra ? 1 : 0)) / 100,
  );
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
    const qr = by("qr");
    const service = by("service");
    const tips = cash + terminal + qr;
    const total = tips + service;
    // Порог считается до вычета за питание: он про заработок, а не про то,
    // сколько человек оставил себе после обеда.
    const aboveThreshold = total >= THRESHOLD;
    const staff = by("staff");

    // Что оставили гости — до комиссии. Питание сюда не входит: это вычет,
    // а не деньги гостя, и попав в эту сумму оно выглядело бы комиссией.
    // У записей, сделанных до появления комиссии, поля нет — тогда дошло
    // ровно столько, сколько оставили.
    const gross = money(
      mine
        .filter((e) => e.kind !== "staff")
        .reduce((sum, e) => sum + (e.gross ?? e.amount), 0),
    );

    const toAdmin = aboveThreshold ? money(total * ADMIN_RATE) : 0;
    // Сервисный сбор кассира не касается: без чаевых доли нет.
    const toCashier = aboveThreshold && tips > 0 ? cashierShare : 0;

    return {
      waiterId: person.id,
      waiterName: person.short,
      cash,
      terminal,
      qr,
      service,
      tips,
      total,
      staff,
      gross,
      commission: money(gross - total),
      aboveThreshold,
      toAdmin,
      toCashier,
      // Питание вычитается последним, из того, что осталось. Может увести
      // в минус — тогда так и показываем: обнулять значит скрыть долг.
      net: money(total - toAdmin - toCashier - staff),
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
    totalQr: sum((w) => w.qr),
    totalTips: sum((w) => w.tips),
    totalService: sum((w) => w.service),
    totalStaff: sum((w) => w.staff),
    totalEarned: sum((w) => w.total),
    totalGross: sum((w) => w.gross),
    totalCommission: sum((w) => w.commission),
    adminTotal: sum((w) => w.toAdmin),
    cashierTotal: sum((w) => w.toCashier),
    waitersNet: sum((w) => w.net),
  };
}
