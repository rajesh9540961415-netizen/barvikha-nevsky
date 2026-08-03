/**
 * Бизнес-день заведения начинается в 11:00 — так настроено в Quick Resto
 * (Предприятие → Настройки → Время начала бизнес дня).
 *
 * Смена идёт примерно с 16:00 до 06:00, то есть переваливает за полночь.
 * Без этой поправки чаевые, полученные в три часа ночи, попали бы
 * в следующие сутки и разошлись бы с кассой.
 */
export const BUSINESS_DAY_START_HOUR = 11;

/** Ключ бизнес-дня в формате YYYY-MM-DD. */
export function businessDayKey(date: Date = new Date()): string {
  const shifted = new Date(date);
  if (shifted.getHours() < BUSINESS_DAY_START_HOUR) {
    shifted.setDate(shifted.getDate() - 1);
  }
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, "0");
  const day = String(shifted.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

/** «31 июля» — для заголовка смены. */
export function formatBusinessDay(key: string): string {
  const [, month, day] = key.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]}`;
}

/**
 * «1 500 ₽» — неразрывные пробелы, чтобы сумма не рвалась по строкам.
 *
 * Копейки показываем, только когда они есть: гости оставляют круглые суммы,
 * и «1 500,00 ₽» на каждом экране было бы шумом. Но когда чаевые делят между
 * официантами, копейка появляется — и прятать её нельзя, это деньги: доля
 * «1 250,5» должна читаться как 1 250,50, иначе две такие доли на экране
 * не сойдутся с тем, что ввели.
 */
export function formatMoney(amount: number): string {
  const withKopecks = Math.round(amount * 100) % 100 !== 0;
  const text = amount.toLocaleString("ru-RU", {
    minimumFractionDigits: withKopecks ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `${text.replace(/\s/g, " ")} ₽`;
}
