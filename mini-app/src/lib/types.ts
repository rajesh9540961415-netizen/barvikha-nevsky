export type Table = {
  id: number;
  title: string;
  seats: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: string;
};

export type Hall = {
  id: number;
  title: string;
  tables: Table[];
};

export type Scheme = {
  scheme: string;
  halls: Hall[];
};

export type Employee = {
  id: number;
  /** Полное имя из Quick Resto. */
  name: string;
  /** Короткое имя для кнопки: «Анна К.» */
  short: string;
};

/**
 * Что именно записали.
 *
 * cash и terminal — чаевые от гостя, добровольные.
 * service — сервисный сбор: 10 % от чека, начисляется автоматически
 * большим компаниям. Выдаётся официантам в тот же день, как и чаевые,
 * но делится иначе — кассир от него доли не получает.
 */
export type Kind = "cash" | "terminal" | "service";

/** Одна запись о полученных деньгах. */
export type Entry = {
  id: string;
  hallId: number;
  hallTitle: string;
  tableId: number;
  tableTitle: string;
  waiterId: number;
  waiterName: string;
  amount: number;
  kind: Kind;
  /** Кто внёс запись — администратор или кассир на смене. */
  operatorId: number;
  operatorName: string;
  /** Момент ввода, ISO. */
  createdAt: string;
  /** Бизнес-день, к которому относится запись: YYYY-MM-DD. */
  businessDay: string;
};
