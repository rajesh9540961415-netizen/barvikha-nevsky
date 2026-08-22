"use client";

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
  /**
   * Раскрывает котёл.
   *
   * Когда выбирать не из кого — не тупик, а повод сказать об этом там же,
   * где человек понадобился: хостес просто не отметили в составе смены.
   * У бара так не бывает — «Весь бар» есть всегда.
   */
  function toggle(contour: Contour) {
    if (contour === "hostess" && hostess.length === 0) {
      onCrew();
      return;
    }
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
