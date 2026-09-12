"use client";

import { useEffect, useRef, useState } from "react";
import { dayLabel, money, plural } from "@/lib/format";
import type { Выплата, СтрокаМесяца } from "@/lib/db/boss";

type Юрлицо = { ключ: string; подпись: string };

const МЕСЯЦЫ = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/** «2026-07» → «июль 2026». Null — месяц не назван. */
export function названиеМесяца(м: string | null): string {
  if (!м) return "месяц не назван";
  const [год, номер] = м.split("-");
  return `${МЕСЯЦЫ[Number(номер) - 1]} ${год}`;
}

/** Ключ строки: месяц или «—» у неназванного, «все» у итоговой. */
const ключСтроки = (м: string | null) => м ?? "—";

/**
 * Месяцы вознаграждения и разбор выбранного месяца по платежам.
 *
 * Задача владельца 12.09.2026: «оставалась постоянно на виду вот такая
 * табличка, а названия месяцев были активными ссылками, при нажатии которых
 * внизу открывалась табличка и показывала, из каких платежей сформированы
 * эти суммы».
 *
 * ⚠️ **Список всех выплат сразу с экрана убран, и это осознанно.** Их сто
 * десять, из них сто три без названного месяца: сплошной простынёй они
 * не отвечают ни на один вопрос. Вопрос всегда про конкретную строку —
 * «из чего сложились 7 500 000 за июль» или «какие именно сто три ждут
 * месяца», — и открывается он нажатием на эту строку.
 *
 * 💡 «Итого» — тоже ссылка, и она открывает все выплаты сразу. Прежний вид
 * экрана никуда не делся, он просто перестал быть единственным.
 *
 * ⚠️ Здесь только показ. Клиентскому коду нельзя тянуть `@/lib/db/boss`
 * целиком — вместе с ним приехала бы база; типы берутся `import type`,
 * а список юрлиц приходит свойством.
 */
export default function ВыплатыБосса({
  месяцы,
  выплаты,
  юрлица,
  всего,
  платежей,
  поЮрлицамВсего,
  безМесяца,
}: {
  месяцы: СтрокаМесяца[];
  выплаты: Выплата[];
  юрлица: Юрлицо[];
  всего: number;
  платежей: number;
  поЮрлицамВсего: Record<string, number>;
  безМесяца: number;
}) {
  // Ничего не выбрано — ни одна табличка внизу не открыта. Экран начинается
  // с общей картины, подробности человек спрашивает сам.
  const [выбран, setВыбран] = useState<string | null>(null);

  /**
   * Открытая табличка сама подъезжает в поле зрения.
   *
   * Таблица месяцев занимает экран почти целиком, и разбор открывается
   * ниже сгиба: без этого нажатие выглядит так, будто ничего не произошло.
   * `nearest` — чтобы страница не дёргалась, когда разбор и так виден.
   */
  const разбор = useRef<HTMLElement>(null);
  useEffect(() => {
    if (выбран !== null) {
      разбор.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [выбран]);

  function нажать(ключ: string) {
    // Повторное нажатие складывает обратно: открыть и закрыть — одна кнопка,
    // иначе на экране копится то, что уже посмотрели.
    setВыбран((с) => (с === ключ ? null : ключ));
  }

  const показать =
    выбран === null
      ? []
      : выбран === "все"
        ? выплаты
        : выплаты.filter((в) => ключСтроки(в.заМесяц) === выбран);

  const суммаПоказанных = показать.reduce((s, в) => s + в.сумма, 0);

  const заголовокРазбора =
    выбран === "все"
      ? "Все выплаты, свежие сверху"
      : выбран === "—"
        ? "Выплаты, у которых месяц ещё не назван"
        : `Из чего сложился ${названиеМесяца(выбран)}`;

  return (
    <>
      <h2 className="mt-8 text-lg font-medium">По месяцам, за которые платили</h2>
      <p className="mt-1 text-xs text-fg-muted">
        Нажмите на месяц — ниже откроется, из каких платежей он сложился.
      </p>

      <div className="mt-3 overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="text-xs text-fg-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 text-left font-normal">За месяц</th>
              <th className="px-4 py-2 text-right font-normal">Всего</th>
              {юрлица.map((ю) => (
                <th key={ю.ключ} className="px-4 py-2 text-right font-normal">
                  {ю.подпись}
                </th>
              ))}
              <th className="px-4 py-2 text-right font-normal">Выплат</th>
            </tr>
          </thead>
          <tbody>
            {месяцы.map((м) => {
              const ключ = ключСтроки(м.месяц);
              const открыт = выбран === ключ;
              return (
                <tr
                  key={ключ}
                  className={`border-b border-line last:border-0 ${
                    открыт ? "bg-surface-2" : ""
                  }`}
                >
                  <td className="px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => нажать(ключ)}
                      aria-expanded={открыт}
                      className={`text-left underline decoration-dotted underline-offset-4 hover:decoration-solid ${
                        м.месяц ? "" : "text-fg-muted"
                      }`}
                    >
                      {названиеМесяца(м.месяц)}
                      <span className="ml-2 text-xs text-fg-muted">
                        {открыт ? "▾" : "▸"}
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {money(м.всего)}
                  </td>
                  {юрлица.map((ю) => (
                    <td
                      key={ю.ключ}
                      className="px-4 py-2.5 text-right tabular-nums text-fg-muted"
                    >
                      {/* Прочерк, а не ноль: с этого юрлица в этот месяц
                          не выводили вовсе, и ноль читался бы как расчёт. */}
                      {м.поЮрлицам[ю.ключ] ? money(м.поЮрлицам[ю.ключ]) : "—"}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">
                    {м.выплат}
                  </td>
                </tr>
              );
            })}
            <tr
              className={`border-t-2 border-line ${
                выбран === "все" ? "bg-surface-2" : ""
              }`}
            >
              <td className="px-4 py-2.5 font-medium">
                <button
                  type="button"
                  onClick={() => нажать("все")}
                  aria-expanded={выбран === "все"}
                  className="text-left underline decoration-dotted underline-offset-4 hover:decoration-solid"
                >
                  Итого
                  <span className="ml-2 text-xs font-normal text-fg-muted">
                    {выбран === "все" ? "▾" : "▸"}
                  </span>
                </button>
              </td>
              <td className="px-4 py-2.5 text-right font-medium tabular-nums">
                {money(всего)}
              </td>
              {юрлица.map((ю) => (
                <td
                  key={ю.ключ}
                  className="px-4 py-2.5 text-right font-medium tabular-nums"
                >
                  {money(поЮрлицамВсего[ю.ключ] ?? 0)}
                </td>
              ))}
              <td className="px-4 py-2.5 text-right font-medium tabular-nums">
                {платежей}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {безМесяца > 0 && (
        <p className="mt-3 text-xs leading-relaxed text-fg-muted">
          Строка «месяц не назван» — это выплаты, про которые ещё не сказано,
          за какой месяц они. Они не размазаны по месяцам нарочно: пока месяц
          не назван, отнести их куда-либо значит выдать догадку за факт.
        </p>
      )}

      {выбран !== null && (
        <section ref={разбор} className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-lg font-medium">{заголовокРазбора}</h2>
            <button
              type="button"
              onClick={() => setВыбран(null)}
              className="text-xs text-fg-muted underline decoration-dotted underline-offset-4"
            >
              свернуть
            </button>
          </div>
          <p className="mt-1 text-xs text-fg-muted">
            {показать.length}{" "}
            {plural(показать.length, "выплата", "выплаты", "выплат")} на{" "}
            {money(суммаПоказанных)}
            {/* ⚠️ Платёж, поделённый между месяцами, стоит двумя строками,
                и без этой оговорки они читаются как две разные выплаты. */}
            {показать.some((в) => в.делёный) && (
              <>
                {" "}· делёный платёж стоит отдельной строкой — под суммой
                подписано, из какой выплаты она взята
              </>
            )}
          </p>

          <div className="mt-3 overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="text-xs text-fg-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 text-left font-normal">Дата</th>
                  <th className="px-4 py-2 text-left font-normal">Документ</th>
                  <th className="px-4 py-2 text-left font-normal">С кого</th>
                  <th className="px-4 py-2 text-right font-normal">Сумма</th>
                  {/* Столбец «За месяц» нужен только когда на экране
                      все выплаты разом: внутри одного месяца он повторял бы
                      заголовок в каждой строке. */}
                  {выбран === "все" && (
                    <th className="px-4 py-2 text-left font-normal">За месяц</th>
                  )}
                  <th className="px-4 py-2 text-left font-normal">Комментарий</th>
                </tr>
              </thead>
              <tbody>
                {показать.map((в) => (
                  <tr
                    key={`${в.день}-${в.документ}-${в.заМесяц ?? "—"}-${в.сумма}`}
                    className="border-b border-line last:border-0"
                  >
                    <td className="whitespace-nowrap px-4 py-2.5 align-top text-fg-muted">
                      {dayLabel(в.день)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 align-top tabular-nums text-fg-muted">
                      {в.документ || "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 align-top">
                      {юрлица.find((ю) => ю.ключ === в.юрлицо)?.подпись ?? в.юрлицо}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right align-top tabular-nums">
                      {money(в.сумма)}
                      {в.делёный && (
                        <span className="block text-xs text-fg-muted">
                          из {money(в.весьПлатёж)}
                        </span>
                      )}
                    </td>
                    {выбран === "все" && (
                      <td className="whitespace-nowrap px-4 py-2.5 align-top">
                        {в.заМесяц ? (
                          названиеМесяца(в.заМесяц)
                        ) : (
                          <span className="text-fg-muted">— не назван</span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-2.5 align-top text-fg-muted">
                      {в.комментарий ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
