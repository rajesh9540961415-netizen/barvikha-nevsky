"use client";

import { useEffect, useState } from "react";
import { formatBusinessDay, formatMoney } from "@/lib/businessDay";
import { посчитать } from "@/lib/hookahMotivation";
import type { МотивацияСмены } from "@/lib/hookahMotivation";
import { getHookahCrew } from "@/lib/people";
import { hookahMotivation } from "@/lib/storage";

/**
 * Мотивация кальянного бара за смену.
 *
 * Кальянщики продают разные типы кальянов, и за каждый тип положена доплата
 * рублями за штуку. Это не чаевые: доплату платит заведение, в отчёт по
 * чаевым она не идёт, и делится она не так — котлом на всю смену поровну
 * между теми, кто вышел (формат владельца 08.09.2026).
 *
 * 🔴 **Вид экрана назвала владелец 08.09.2026, и он нарочно простой:**
 * «упрости, оставь только заголовки, общее количество проданных позиций,
 * стоимость одной позиции и общую сумму». Ровно четыре столбца и итог.
 * Раскладка по конкретным кальянам внутри типа и по дням есть в бэк-офисе,
 * на странице `/motivaciya`, — здесь её быть не должно.
 *
 * 🔴 **Выручки на этом экране нет и не будет** (владелец 06.09.2026). Она
 * даже не приезжает на телефон: `readHookahMotivation` не спрашивает у базы
 * столбец с деньгами.
 *
 * ⚠️ **Экран ничего не считает сам, кроме сложения.** Что чем считается
 * и за что положена доплата, решено один раз на Маке, в `hookah_push.py`:
 * доплата за «ЧМ» полагается лишь в комплекте с электронной чашей, а комплект
 * виден по составу чека. 08.09.2026 три ошибки счёта выросли из того, что
 * одно правило жило в двух местах, — здесь третьего места нет.
 */

type Props = {
  /** Смена, открытая в приложении. */
  day: string;
  onClose: () => void;
};

type Состояние =
  | { вид: "грузим" }
  | { вид: "не вышло" }
  | { вид: "готово"; данные: МотивацияСмены };

export default function MotivationScreen({ day, onClose }: Props) {
  const [состояние, setСостояние] = useState<Состояние>({ вид: "грузим" });
  const [попытка, setПопытка] = useState(0);

  useEffect(() => {
    let живо = true;
    setСостояние({ вид: "грузим" });
    hookahMotivation(day)
      .then((данные) => {
        if (живо) setСостояние({ вид: "готово", данные });
      })
      .catch(() => {
        if (живо) setСостояние({ вид: "не вышло" });
      });
    return () => {
      живо = false;
    };
  }, [day, попытка]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <button
          onClick={onClose}
          aria-label="Назад"
          className="-ml-1 rounded-lg px-2 py-1 text-2xl leading-none text-fg-muted active:bg-surface"
        >
          ‹
        </button>
        <div className="text-base">Мотивация бара</div>
      </header>

      {состояние.вид === "грузим" && (
        <p className="px-4 py-8 text-sm text-fg-muted">Считаю…</p>
      )}

      {состояние.вид === "не вышло" && (
        <div className="px-4 py-8">
          <p className="text-sm text-fg-muted">
            Не удалось загрузить — проверьте связь.
          </p>
          <button
            onClick={() => setПопытка((n) => n + 1)}
            className="mt-4 rounded-xl bg-sand px-6 py-3 text-base text-ink"
          >
            Повторить
          </button>
        </div>
      )}

      {состояние.вид === "готово" && (
        <Таблица данные={состояние.данные} сегодня={day} />
      )}
    </div>
  );
}

function Таблица({
  данные,
  сегодня,
}: {
  данные: МотивацияСмены;
  сегодня: string;
}) {
  if (данные.день === null) {
    return (
      <p className="px-4 py-8 text-sm text-fg-muted">
        Продаж пока нет. Их привозит команда с компьютера владельца.
      </p>
    );
  }

  const { поКатегориям, всего, штукВсего } = посчитать(
    данные.продажи,
    данные.ставки,
  );
  // Типы, которых в эту смену не продали, не показываем: пустая строка
  // с нулём ничего не сообщает, а экран просили упростить.
  const строки = поКатегориям.filter((к) => к.штук > 0);

  return (
    <>
      <p className="px-4 pb-1 pt-3 text-sm text-fg">
        смена · {formatBusinessDay(данные.день)}
      </p>
      {/* Продажи приезжают утренней командой, поэтому за идущую смену цифр
          ещё нет. Молчать об этом нельзя: экран показывал бы вчерашнее,
          а прочитали бы его как сегодняшнее. */}
      {данные.день !== сегодня && (
        <p className="px-4 pb-2 text-xs text-fg-muted">
          за сегодняшнюю смену кальяны ещё не посчитаны — цифры появляются
          на следующее утро
        </p>
      )}

      {строки.length === 0 ? (
        <p className="px-4 py-8 text-sm text-fg-muted">
          В эту смену кальянов с доплатой не было.
        </p>
      ) : (
        <div className="px-4 pt-2">
          <table className="w-full border-collapse text-right text-sm">
            <thead className="text-fg-muted">
              <tr className="border-b border-line">
                <th className="py-2 pr-2 text-left font-normal">тип кальяна</th>
                <th className="px-1 py-2 font-normal">продано</th>
                <th className="px-1 py-2 font-normal">за штуку</th>
                <th className="py-2 pl-1 font-normal">к доплате</th>
              </tr>
            </thead>
            <tbody>
              {строки.map((к) => (
                <tr key={к.категория} className="border-b border-line/60">
                  <td className="py-2.5 pr-2 text-left">{к.категория}</td>
                  <td className="px-1 py-2.5 tabular-nums">
                    {к.штук.toLocaleString("ru-RU")}
                  </td>
                  <td className="px-1 py-2.5 tabular-nums text-fg-muted">
                    {formatMoney(к.ставка)}
                  </td>
                  <td className="py-2.5 pl-1 tabular-nums">
                    {formatMoney(к.мотивация)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line">
                <td className="py-3 pr-2 text-left">Итого</td>
                <td className="px-1 py-3 tabular-nums">
                  {штукВсего.toLocaleString("ru-RU")}
                </td>
                <td />
                <td className="py-3 pl-1 tabular-nums">{formatMoney(всего)}</td>
              </tr>
            </tfoot>
          </table>

          <НаЧеловека всего={всего} данные={данные} />
        </div>
      )}
    </>
  );
}

/**
 * Сколько выходит каждому.
 *
 * Мотивация бара — котёл на смену, и владелец делит его ПОРОВНУ между теми,
 * кто в неё работал (формат листа УК, 08.09.2026): 13 600 ÷ 6 = 2 266.
 *
 * 🔴 **Округляем ВНИЗ до рубля — решение владельца 08.09.2026, «как в листе».**
 * Копеек в доле не бывает: 13 600 ÷ 6 это 2 266, а не 2 266,67. Правило здесь
 * не такое, как у долей зала в `split.ts`, где копейку показывают до последней:
 * там доля это и есть выплата, а тут экран обязан совпасть с тем, что владелец
 * потом впишет в лист УК. Разойдись они на рубль — вопрос «почему у меня
 * меньше» задали бы в тот же вечер.
 *
 * ⚠️ **Остаток от округления называем вслух.** Он маленький, до нескольких
 * рублей, но шестью долями по 2 266 котёл в 13 600 не набирается, и человек
 * с калькулятором это увидит. Экран отвечает на это раньше, чем спросят.
 * Кому остаток достаётся — вопрос владельцу, он ещё открыт.
 *
 * 💡 Имена показываем нарочно, мелкой строкой. Число, на которое делят,
 * проверить больше нечем: неотмеченный кальянщик уменьшает долю остальных
 * молча, и увидеть это можно только глазами, узнав в списке всех, кто вышел.
 */
function НаЧеловека({
  всего,
  данные,
}: {
  всего: number;
  данные: МотивацияСмены;
}) {
  if (данные.бар.length === 0) {
    return (
      <p className="pt-4 text-sm text-fg-muted">
        Состав бара в ту смену не отмечен — делить не на кого. Кальянщиков
        отмечают в составе смены, там же, где официантов.
      </p>
    );
  }

  const справочник = getHookahCrew();
  const имена = данные.бар.map(
    (id) =>
      справочник.find((p) => p.id === id)?.short ??
      данные.имена[String(id)] ??
      `№${id}`,
  );

  const доля = Math.floor(всего / данные.бар.length);
  const остаток = всего - доля * данные.бар.length;

  return (
    <div className="pt-4">
      <p className="text-base">
        Поровну на {данные.бар.length}{" "}
        {plural(данные.бар.length, "человека", "человека", "человек")} — по{" "}
        <span className="tabular-nums">{formatMoney(доля)}</span>
      </p>
      <p className="pt-1 text-xs text-fg-muted">{имена.join(", ")}</p>
      {остаток > 0 && (
        <p className="pt-1 text-xs text-fg-muted">
          округлено вниз до рубля, остаток {formatMoney(остаток)}
        </p>
      )}
    </div>
  );
}

/** «на 1 человека», «на 2 человек» — в строке про долю. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
