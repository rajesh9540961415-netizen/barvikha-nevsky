"use client";

import { useState } from "react";
import type { Contour, Employee } from "@/lib/types";

/**
 * Котлы «Кальянный бар» и «Хостес»: кнопки и списки получателей.
 *
 * Общий кусок двух экранов — суммы за столом и разнесения поступления
 * по QR. Гость может попросить поделить и то, и другое, и вопрос у обоих
 * экранов один: кому со стороны.
 *
 * ⚠️ Вынесено отдельно не ради красоты. Здесь не разметка, а правила:
 * «Весь бар» есть всегда, хостес может не быть вовсе, а пустой список
 * ведёт в состав смены, а не молчит. Живя двумя копиями, такие правила
 * расходятся молча — в этом проекте так уже случалось со списками людей
 * и со словарями имён.
 *
 * 💡 Кнопки стоят отдельно от зала нарочно. Деньги бара и хостес живут
 * в своих котлах и ни с кем не делятся: перепутать их с залом значит
 * отдать деньги другим людям, а по цифрам это потом не отличить.
 */
type Props = {
  /** Хостес этого вечера. Пусто — значит её не отметили в составе. */
  hostess: Employee[];
  /** Кальянщики смены и общий котёл бара. Котёл есть всегда. */
  hookah: Employee[];
  /** Кто уже выбран со стороны — по порядку нажатий. */
  side: { id: number; contour: Contour }[];
  /** Какой котёл раскрыт сейчас. */
  open: Contour | null;
  onOpen: (contour: Contour | null) => void;
  onPick: (id: number, contour: Contour) => void;
  /** Открыть состав смены — когда выбирать не из кого. */
  onCrew: () => void;
};

const TITLE: Record<string, string> = {
  hookah: "Кальянный бар",
  hostess: "Хостес",
};

export default function SidePots({
  hostess,
  hookah,
  side,
  open,
  onOpen,
  onPick,
  onCrew,
}: Props) {
  /** Котёл, за которым никого нет: показываем строку, а не уводим с экрана. */
  const [пусто, setПусто] = useState<Contour | null>(null);

  /**
   * Раскрывает котёл.
   *
   * ⚠️ Когда выбирать не из кого, экран НЕ ЗАКРЫВАЕТСЯ. Раньше нажатие
   * на пустой котёл уводило в состав смены — замысел был «привести туда,
   * где чинится», а на деле 22.08.2026 владелец нажала «Хостес», оказалась
   * на другом экране без единого слова объяснения и потеряла набранные
   * 800 ₽ вместе с выбранными получателями.
   *
   * 💡 Общее правило, которое из этого следует: экран, где НАБИРАЮТ деньги,
   * не должен закрываться сам. Всё, что можно сказать словом, говорится
   * строкой на месте; уходить или нет — решает человек, и уже осознанно.
   */
  function toggle(contour: Contour) {
    const людей = contour === "hookah" ? hookah : hostess;
    if (людей.length === 0) {
      setПусто((текущий) => (текущий === contour ? null : contour));
      return;
    }
    setПусто(null);
    onOpen(open === contour ? null : contour);
  }

  return (
    <>
      <div className="mt-2 flex gap-2">
        {(["hookah", "hostess"] as const).map((c) => {
          const chosen = side.filter((p) => p.contour === c).length;
          return (
            <button
              key={c}
              onClick={() => toggle(c)}
              className={`flex-1 rounded-lg border px-2.5 py-2 text-xs ${
                chosen > 0
                  ? "border-sand bg-sand/10 text-fg"
                  : "border-line bg-surface text-fg-muted active:bg-surface-2"
              }`}
            >
              {TITLE[c]}
              {chosen > 0 && <span className="ml-1.5 tabular-nums">{chosen}</span>}
            </button>
          );
        })}
      </div>

      {/* Пустой котёл объясняется строкой на месте. Кнопка перехода рядом —
          но нажимает её человек, а не приложение за него. */}
      {пусто !== null && (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2">
          <span className="text-xs text-fg-muted">
            на смене нет {пусто === "hostess" ? "хостес" : "кальянщиков"} —
            отметьте в составе смены
          </span>
          <button
            onClick={onCrew}
            className="shrink-0 rounded-lg border border-sand px-2.5 py-1 text-xs text-fg active:bg-surface-2"
          >
            Состав смены
          </button>
        </div>
      )}

      {/* Список котла: раскрыт, пока из него выбирают, и остаётся раскрытым,
          если кто-то уже выбран — спрятанный выбор хуже отсутствия выбора. */}
      {(["hookah", "hostess"] as const).map((c) => {
        const people = c === "hookah" ? hookah : hostess;
        const opened = open === c || side.some((p) => p.contour === c);
        if (!opened || people.length === 0) return null;
        return (
          <div key={c} className="mt-2 flex flex-wrap gap-2">
            {people.map((p) => {
              const on = side.some((x) => x.id === p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => onPick(p.id, c)}
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    on
                      ? "border-sand bg-sand/10 text-fg"
                      : "border-line bg-surface text-fg-muted active:bg-surface-2"
                  }`}
                >
                  {p.short}
                </button>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
