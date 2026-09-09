"use client";

import { useActionState } from "react";
import { сохранитьСтавку } from "@/lib/db/hookah";
import { money } from "@/lib/format";

/**
 * Правка ставок мотивации прямо на экране.
 *
 * ⚠️ **Ставка — деньги людей, поэтому каждая правка подписывается.** Кто менял,
 * записывает `сохранитьСтавку` в базу: через месяц вопрос «почему стало
 * по-другому» задают обязательно, и отвечать на него должна база, а не память.
 *
 * ⚠️ Одна форма на категорию, а не одна на все. Так видно, какая именно
 * ставка сохранилась, и ошибка в одной строке не роняет остальные.
 */
function Строка({ категория, ставка }: { категория: string; ставка: number }) {
  const [итог, отправить, идёт] = useActionState(сохранитьСтавку, {});

  return (
    <form action={отправить} className="flex flex-wrap items-center gap-3 p-3">
      <input type="hidden" name="категория" value={категория} />
      <span className="min-w-[13rem] text-sm">{категория}</span>
      <input
        name="ставка"
        type="number"
        min="0"
        step="10"
        defaultValue={ставка}
        aria-label={`Ставка за «${категория}», рублей за штуку`}
        className="w-28 rounded-md border border-line bg-surface px-2 py-1 text-right text-sm tabular-nums"
      />
      <span className="text-xs text-fg-muted">₽ за штуку</span>
      <button
        type="submit"
        disabled={идёт}
        className="rounded-md border border-line px-3 py-1 text-sm transition-colors hover:bg-line/40 disabled:opacity-50"
      >
        {идёт ? "Сохраняю…" : "Сохранить"}
      </button>
      {итог?.ok && <span className="text-xs text-sand">сохранено</span>}
      {итог?.error && <span className="text-xs text-alert">{итог.error}</span>}
    </form>
  );
}

export default function Ставки({
  категории,
  ставки,
}: {
  категории: string[];
  ставки: Record<string, number>;
}) {
  return (
    <div className="mt-3 divide-y divide-line/60 rounded-lg border border-line">
      {категории.map((к) => (
        <Строка key={к} категория={к} ставка={ставки[к] ?? 0} />
      ))}
      <p className="p-3 text-xs text-fg-muted">
        Сейчас в сумме {money(
          категории.reduce((с, к) => с + (ставки[к] ?? 0), 0),
        )} за по одному кальяну каждого типа.
      </p>
    </div>
  );
}
