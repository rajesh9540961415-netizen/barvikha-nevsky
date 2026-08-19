/**
 * Как показываем числа и даты.
 *
 * Своё, а не копия из приложения смены: там телефон в тёмном зале и деньги
 * крупными цифрами, здесь таблицы на большом экране. Одинаково выглядеть
 * они не должны.
 */

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

const WEEKDAYS = [
  "воскресенье", "понедельник", "вторник", "среда",
  "четверг", "пятница", "суббота",
];

/**
 * «1 500 ₽» — неразрывные пробелы, чтобы сумма не рвалась по строкам.
 *
 * Копейки показываем, только когда они есть. Но когда чаевые делят между
 * официантами, копейка появляется — и прятать её нельзя, это деньги.
 */
export function money(value: number): string {
  const withKopecks = Math.round(value * 100) % 100 !== 0;
  const text = value.toLocaleString("ru-RU", {
    minimumFractionDigits: withKopecks ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `${text.replace(/\s/g, " ")} ₽`;
}

/** То же, но ноль показывается прочерком: в таблице нули только шумят. */
export function moneyOrDash(value: number): string {
  return value ? money(value) : "—";
}

/** «+120 ₽» или «−1 300 ₽». Для колонки «разница». */
export function delta(value: number): string {
  if (!value) return "—";
  return `${value > 0 ? "+" : "−"}${money(Math.abs(value))}`;
}

/** «6 августа» */
export function dayLabel(key: string): string {
  const [, month, date] = key.split("-");
  return `${Number(date)} ${MONTHS[Number(month) - 1]}`;
}

/** «пятница» — важно: в пятницу и субботу кассиру уходит 1000 ₽, а не 750 ₽. */
export function weekday(key: string): string {
  const [year, month, date] = key.split("-").map(Number);
  // Собираем дату по частям: разбор строки целиком дал бы UTC-полночь,
  // и день недели мог бы съехать на сутки.
  return WEEKDAYS[new Date(year, month - 1, date).getDay()];
}

/** «21:40» — время внутри смены. */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** «6 августа, 21:40» — для следа правки: там важен и день, и час. */
export function moment(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${clock(iso)}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Подпись, отличающая двойника: «Алексей Горбунов · вписан руками».
 *
 * Зачем. В окнах выбора лежат вперемешку люди из кассы Quick Resto
 * и вписанные руками, а один и тот же человек нередко есть и там, и там:
 * сначала его дописали в зале, потом завели в кассе. На экране получаются
 * две одинаковые строки, и какую из них брать — не видно ничем.
 *
 * ⚠️ Это не мелкое неудобство. 19.08.2026 на двойнике потерялись 12 900,96 ₽:
 * записи легли на один номер, а человека из справочника убрали — и деньги
 * перестали складываться. Выбранный наугад двойник ведёт ровно туда же.
 *
 * 💡 Подпись только у двойников, и это важнее, чем кажется. Приписка у всех
 * подряд превращается в шум, который перестают читать через день, — и тогда
 * она не сработает как раз в том единственном месте, ради которого её
 * заводили. Один человек — просто имя, как было.
 */
export function twinHint(person: { id: number; name: string }, everyone: { id: number; name: string }[]): string {
  const тёзки = everyone.filter((p) => p.name === person.name);
  if (тёзки.length < 2) return "";
  // Отрицательный номер — признак вписанного руками: их выдаёт база
  // от −1 и вниз, чтобы никогда не столкнуться с номерами Quick Resto.
  return person.id < 0 ? " · вписан руками" : " · из кассы";
}
