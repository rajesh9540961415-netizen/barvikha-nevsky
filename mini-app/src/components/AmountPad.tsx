"use client";

import { useState } from "react";
import { formatMoney } from "@/lib/businessDay";
import type { Employee, Hall, Kind, Table } from "@/lib/types";

type Props = {
  hall: Hall;
  table: Table;
  /** Официанты, отмеченные на смене. */
  crew: Employee[];
  /** Кого предложить: обычно тот, кто уже обслуживал этот стол сегодня. */
  suggestedWaiterId: number | null;
  onCancel: () => void;
  onConfirm: (amount: number, waiter: Employee, kind: Kind) => void;
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"];

/** Больше вводить и не нужно: защита от случайного лишнего нуля. */
const MAX_AMOUNT = 200_000;

export default function AmountPad({
  hall,
  table,
  crew,
  suggestedWaiterId,
  onCancel,
  onConfirm,
}: Props) {
  const [digits, setDigits] = useState("");
  const [waiterId, setWaiterId] = useState<number | null>(
    suggestedWaiterId ?? (crew.length === 1 ? crew[0].id : null),
  );

  const amount = Number(digits || "0");
  const waiter = crew.find((w) => w.id === waiterId) ?? null;
  const ready = amount > 0 && waiter !== null;

  function press(key: string) {
    if (key === "⌫") {
      setDigits((d) => d.slice(0, -1));
      return;
    }
    const next = (digits + key).replace(/^0+/, "");
    if (Number(next || "0") <= MAX_AMOUNT) setDigits(next);
  }

  function confirm(kind: Kind) {
    if (!ready || !waiter) return;
    onConfirm(amount, waiter, kind);
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <button
          onClick={onCancel}
          aria-label="Назад"
          className="-ml-1 rounded-lg px-2 py-1 text-2xl leading-none text-fg-muted active:bg-surface"
        >
          ‹
        </button>
        <div className="text-base">
          {hall.title} · {table.title}
        </div>
      </header>

      {/* Растягивается, чтобы клавиатура и кнопки остались внизу — под большой палец. */}
      <div className="flex flex-1 items-center justify-center py-6">
        <span
          className={`text-4xl tabular-nums ${amount > 0 ? "text-fg" : "text-fg-muted"}`}
        >
          {formatMoney(amount)}
        </span>
      </div>

      <div className="px-4 pb-3">
        <div className="mb-1.5 text-xs text-fg-muted">
          {waiter ? "официант" : "выберите официанта"}
        </div>
        <div className="flex flex-wrap gap-2">
          {crew.map((w) => {
            const on = w.id === waiterId;
            return (
              <button
                key={w.id}
                onClick={() => setWaiterId(w.id)}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  on
                    ? "border-sand bg-sand/10 text-fg"
                    : "border-line bg-surface text-fg-muted active:bg-surface-2"
                }`}
              >
                {w.short}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 px-4">
        {KEYS.map((k) => (
          <button
            key={k}
            onClick={() => press(k)}
            className="rounded-xl border border-line bg-surface py-3.5 text-2xl tabular-nums active:bg-surface-2"
          >
            {k}
          </button>
        ))}
      </div>

      <div className="px-4 pb-6 pt-3">
        <div className="mb-1.5 text-xs text-fg-muted">чаевые</div>
        <div className="grid grid-cols-2 gap-2">
          <button
            disabled={!ready}
            onClick={() => confirm("cash")}
            className="rounded-xl bg-sand py-3.5 text-base text-ink disabled:bg-surface disabled:text-fg-muted"
          >
            Наличные
          </button>
          <button
            disabled={!ready}
            onClick={() => confirm("terminal")}
            className="rounded-xl border border-sand py-3.5 text-base text-sand disabled:border-line disabled:text-fg-muted"
          >
            Терминал
          </button>
        </div>
        <button
          disabled={!ready}
          onClick={() => confirm("service")}
          className="mt-2 w-full rounded-xl border border-line bg-surface py-3.5 text-base text-fg disabled:text-fg-muted"
        >
          Сервисный сбор
        </button>
      </div>
    </div>
  );
}
