import type { Contour, Employee, Entry, Kind } from "./types";

/**
 * Деление денег зала за смену.
 *
 * Правила со слов владельца, подробности и примеры — в
 * .business/economics/tips.md.
 *
 * ⚠️ У этого файла есть копия в manager-app/src/lib/. Бэк-офис показывает
 * «было / стало» по всей смене перед сохранением правки, и считать это он
 * обязан ровно так же, как приложение смены, — иначе предпросмотр покажет
 * одно, а смена посчитается по-другому.
 *
 * Общей папки быть не может: Amvera собирает mini-app и manager-app как два
 * отдельных корня, и всё за их пределами до сервера не доедет.
 *
 * Правим здесь, потом в бэк-офисе:  npm run copies
 * Разошлись — бэк-офис не запустится и скажет, какой файл разъехался.
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
 * Наличные и сервисный сбор идут мимо Сбера, там ноль. По QR — см. примечание
 * у самой строки: комиссия есть, но удержана до нас.
 */
export const COMMISSION_RATE: Record<Kind, number> = {
  cash: 0,
  terminal: 0.08,
  service: 0,
  // ⚠️ У QR комиссия ТОЖЕ есть — Сбер берёт её и здесь. Ноль стоит не потому,
  // что комиссии нет, а потому, что её уже удержали до нас: терминал
  // предлагает гостю взять её на себя либо оставить на получателя, Сбер
  // считает сам, и в Telegram приходит уже чистая сумма — та, что дошла
  // до котла. Поэтому вычитать нечего, записываем как есть.
  //
  // Этот ноль держится на КАНАЛЕ получения данных, а не на виде оплаты.
  // Поменяется источник по QR — выгрузка из личного кабинета, отчёт, что
  // угодно ещё — оттуда может прийти сумма ДО комиссии, и ноль станет тихой
  // ошибкой: людям начислят больше, чем на самом деле дошло. Меняя канал,
  // первым делом выяснить, чистая приходит сумма или грязная.
  // Поправка владельца 11.08.2026.
  qr: 0,
  // Стафф — не доход, а вычет. Комиссии тут быть не может.
  staff: 0,
};

/** Сколько дойдёт до официанта из того, что оставил гость. */
export function netAmount(gross: number, kind: Kind): number {
  const rate = COMMISSION_RATE[kind];
  return rate ? money(gross * (1 - rate)) : gross;
}

/**
 * Контур записи. У записей до 18.08.2026 поля нет — все они зальные.
 *
 * Спрашивать `e.contour === "hall"` напрямую нельзя: у старых записей там
 * `undefined`, и вся история зала выпала бы из расчёта одним движением.
 */
export function contourOf(entry: Entry): Contour {
  return entry.contour ?? "hall";
}

/**
 * Общий котёл кальянного бара — «на бар целиком».
 *
 * Бывает, что администратор не знает, кто из кальянщиков обслуживал стол.
 * Тогда деньги записываются на бар, а делят их между собой сами. Это
 * не человек, поэтому и номер у него не человеческий: ровно миллион,
 * начало диапазона кальянщиков (у живых номер кассы плюс миллион, так что
 * занять этот номер никто не может — номеров 0 в Quick Resto не бывает).
 */
export const HOOKAH_POT_ID = 1_000_000;
export const HOOKAH_POT_NAME = "Весь бар";

/** Кальянщик или общий котёл бара: номера от миллиона. */
export function isHookah(id: number): boolean {
  return id >= HOOKAH_POT_ID;
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
  /**
   * Сколько гости оставили на терминале ДО комиссии Сбера.
   *
   * Кассиры сверяют смену с лентой терминала, а там пробита полная сумма:
   * без неё цифры не сходятся и приходится делить в уме на 0,92. Просьба
   * кассиров 08.08.2026.
   *
   * Отдельно от общего `gross`: тот считает все виды денег вместе, и по нему
   * терминал не отделить от наличных.
   */
  terminalGross: number;
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
  /**
   * Начислено за смену: заработок минус доли администратору и кассиру.
   * Питание НЕ вычитается.
   *
   * Это то, что уходит в отчёт: отчёт фиксирует выплаты в пользу сотрудника,
   * а обед — его встречная покупка у заведения (решение владельца 08.08.2026).
   * Считать «на руки» отчёт не может ещё и потому, что тогда сумма блоков
   * «на руки» не сходится с тем, что оставили гости, и строка «Расхождение»
   * краснеет ровно на размер питания каждую смену, где кто-то поел.
   */
  accrued: number;
  /** Начислено минус питание — столько человек получает на руки в конце смены. */
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
  /** Сколько всего оставили на терминале до комиссии — для сверки с лентой. */
  totalTerminalGross: number;
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
  /** Начислено официантам за смену — без вычета питания. То, что идёт в отчёт. */
  waitersAccrued: number;
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

  // Зальные деньги и только они. Хостес и кальянный бар считаются отдельно
  // (splitSide ниже) и в этот расчёт попадать не должны: они не делятся
  // ни с кем и порога не знают. Фильтр по контуру, а не по людям, потому
  // что один и тот же человек может стоять в смене и официантом, и хостес.
  const hall = entries.filter((e) => contourOf(e) === "hall");

  // В смене учитываем всех отмеченных, даже если человек не получил ничего:
  // он всё равно считается в знаменателе доли кассира.
  const waiters: WaiterSplit[] = crew.map((person) => {
    const mine = hall.filter((e) => e.waiterId === person.id);
    const by = (kind: Entry["kind"]) =>
      mine.filter((e) => e.kind === kind).reduce((sum, e) => sum + e.amount, 0);

    const cash = by("cash");
    const terminal = by("terminal");
    // Полная сумма с терминала — до того, как Сбер удержал свои 8 %.
    // У записей, сделанных до появления комиссии, поля нет: тогда до официанта
    // дошло ровно то, что оставил гость.
    const terminalGross = money(
      mine
        .filter((e) => e.kind === "terminal")
        .reduce((sum, e) => sum + (e.gross ?? e.amount), 0),
    );
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
      terminalGross,
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
      accrued: money(total - toAdmin - toCashier),
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
    totalTerminalGross: sum((w) => w.terminalGross),
    totalQr: sum((w) => w.qr),
    totalTips: sum((w) => w.tips),
    totalService: sum((w) => w.service),
    totalStaff: sum((w) => w.staff),
    totalEarned: sum((w) => w.total),
    totalGross: sum((w) => w.gross),
    totalCommission: sum((w) => w.commission),
    adminTotal: sum((w) => w.toAdmin),
    cashierTotal: sum((w) => w.toCashier),
    waitersAccrued: sum((w) => w.accrued),
    waitersNet: sum((w) => w.net),
  };
}

/**
 * Один получатель в контуре, который ни с кем не делится: хостес или
 * кальянщик (или общий котёл бара).
 *
 * Полей меньше, чем у официанта, и это не упрощение ради краткости: здесь
 * нет порога, нет доли администратора и доли кассира — их не существует
 * по решению владельца 18.08.2026. Заводить пустые поля «для симметрии»
 * значит однажды в них что-нибудь посчитать.
 */
export type PayeeSplit = {
  payeeId: number;
  payeeName: string;
  cash: number;
  qr: number;
  service: number;
  /** Чаевые без сервисного сбора — наличные и QR. */
  tips: number;
  /**
   * Всё, что человек получил за смену. Начислено ему столько же:
   * отчислений здесь нет ни у кого.
   */
  total: number;
  /**
   * Сколько проел за смену — вычет, а не доход.
   *
   * У хостес питание вычитается так же, как у официантов: решение владельца
   * 18.08.2026, вопрос закрыт. У кальянного бара его быть не может — другое
   * юрлицо, заведение не кормит их за счёт чаевых, и на экране питания
   * кальянщиков нет вовсе.
   */
  staff: number;
  /** Начислено минус питание — столько человек получает на руки. */
  net: number;
};

export type SideSplit = {
  rows: PayeeSplit[];
  totalCash: number;
  totalQr: number;
  totalService: number;
  totalTips: number;
  /**
   * Весь контур за смену: столько начислено людям.
   *
   * Отчислений здесь нет — ни администратору, ни кассиру. Питание в эту
   * сумму тоже не входит: это встречная покупка сотрудника у заведения,
   * и в отчёт она не идёт (решение владельца 08.08.2026). Сколько выйдет
   * на руки после обедов — в `totalNet`.
   */
  total: number;
  /** Удержано за питание по всему контуру. У кальянного бара всегда ноль. */
  totalStaff: number;
  /** Начислено минус питание. */
  totalNet: number;
};

/**
 * Считает контур хостес или кальянного бара.
 *
 * Здесь нет деления как такового: сколько гость оставил, столько человек
 * и получил. Функция нужна не ради арифметики, а ради того, чтобы суммы
 * собирались в одном месте — там же, где зальные, и по тем же правилам
 * округления.
 *
 * В список попадают все, кто стоит в смене в этой роли, даже с нулём —
 * как у официантов. И сверх того — все, на кого есть записи, но кого
 * в смене уже нет: администратор мог убрать человека из состава после
 * того, как записал ему чаевые. Спрятать такие деньги нельзя, они
 * настоящие; поэтому строка появится, а имя возьмётся из самой записи.
 */
export function splitSide(
  entries: Entry[],
  contour: Contour,
  people: Employee[],
): SideSplit {
  const mine = entries.filter((e) => contourOf(e) === contour);

  const known = new Map<number, string>(
    people.map((p) => [p.id, p.short] as const),
  );
  for (const e of mine) {
    if (!known.has(e.waiterId)) known.set(e.waiterId, e.waiterName);
  }

  const rows: PayeeSplit[] = [...known].map(([payeeId, payeeName]) => {
    const his = mine.filter((e) => e.waiterId === payeeId);
    const by = (kind: Kind) =>
      money(
        his.filter((e) => e.kind === kind).reduce((sum, e) => sum + e.amount, 0),
      );

    const cash = by("cash");
    const qr = by("qr");
    const service = by("service");
    const tips = money(cash + qr);
    // Питание вычитается из того, что человек получил. Может увести в минус —
    // тогда так и показываем: обнулять значит скрыть долг, как и у официантов.
    const staff = by("staff");
    const total = money(tips + service);

    return {
      payeeId,
      payeeName,
      cash,
      qr,
      service,
      tips,
      total,
      staff,
      net: money(total - staff),
    };
  });

  rows.sort((a, b) => b.total - a.total);

  const sum = (pick: (r: PayeeSplit) => number) =>
    money(rows.reduce((acc, r) => acc + pick(r), 0));

  return {
    rows,
    totalCash: sum((r) => r.cash),
    totalQr: sum((r) => r.qr),
    totalService: sum((r) => r.service),
    totalTips: sum((r) => r.tips),
    total: sum((r) => r.total),
    totalStaff: sum((r) => r.staff),
    totalNet: sum((r) => r.net),
  };
}
