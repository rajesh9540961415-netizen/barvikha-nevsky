"use client";

import { useState } from "react";
import { formatMoney } from "@/lib/businessDay";
import type { Employee } from "@/lib/types";

/**
 * Питание сотрудников — вычет из выплаты.
 *
 * Сотрудники едят в течение смены, и расходы пробиваются в Quick Resto
 * отдельным чеком на столе STAFF; имя того, кто ел, пишется в комментарии
 * к чеку. Через API этого не достать — чеки закрыты, письмо в поддержку
 * висит с 01.08.2026. Поэтому суммы вносит администратор.
 *
 * Он и сегодня считает эти вычеты в конце смены — просто нигде их
 * не сохраняет. Здесь та же работа, но цифры остаются: попадают в итоги,
 * в отчёт, и никто не забудет вычесть.
 *
 * С 18.08.2026 сюда попадают и хостес: у них питание вычитается так же,
 * как у официантов (решение владельца).
 *
 * 🔴 **С 16.09.2026 здесь и кальянщики.** Прежнее правило — «они у ИП
 * Шалаевой, заведение не кормит их за счёт чаевых» — владелец отменила:
 * «у нас кушают и хостес, и кальянный бар». Вычет у них считается из того,
 * что человек заработал за вечер: доля общего котла плюс доля мотивации.
 *
 * ⚠️ **Вычет личный и у них.** Владелец 16.09.2026: «питание у каждого
 * индивидуально, они набирают на свою конкретную сумму». Уменьшать на обед
 * общий котёл нельзя — за чужой обед платили бы все, кто вышел в смену.
 */

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"];

/** Столько за смену не проесть: защита от лишнего нуля. */
const MAX_AMOUNT = 50_000;

type Props = {
  /** Кто мог поесть: официанты смены, хостес и кальянный бар. */
  crew: Employee[];
  /** Сколько человек уже проел за смену — чтобы не внести обед дважды. */
  eaten: (id: number) => number;
  /** Сколько ему причитается на руки сейчас, до этого вычета. */
  payout: (id: number) => number;
  onCancel: () => void;
  onConfirm: (amount: number, waiter: Employee) => Promise<void>;
};

export default function StaffScreen({
  crew,
  eaten,
  payout,
  onCancel,
  onConfirm,
}: Props) {
  const [digits, setDigits] = useState("");
  const [waiterId, setWaiterId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const amount = Number(digits || "0");
  const waiter = crew.find((w) => w.id === waiterId) ?? null;
  const ready = amount > 0 && waiter !== null && !saving;

  /** Что у человека уже записано — чтобы не вносить обед дважды. */
  const already = eaten;

  function press(key: string) {
    setFailed(false);
    if (key === "⌫") {
      setDigits((d) => d.slice(0, -1));
      return;
    }
    const next = (digits + key).replace(/^0+/, "");
    if (Number(next || "0") <= MAX_AMOUNT) setDigits(next);
  }

  async function confirm() {
    if (!ready || !waiter) return;
    setSaving(true);
    setFailed(false);
    try {
      await onConfirm(amount, waiter);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
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
        <div className="text-base">Питание сотрудников</div>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-1 py-6">
        <span
          className={`text-4xl tabular-nums ${amount > 0 ? "text-fg" : "text-fg-muted"}`}
        >
          {amount > 0 ? `− ${formatMoney(amount)}` : formatMoney(0)}
        </span>
        {/* Сразу видно, что останется человеку: вычет может увести в минус,
            и узнать об этом лучше до записи, а не в конце смены. */}
        {waiter && amount > 0 && (
          <span className="text-xs text-fg-muted">
            {waiter.short}: на руки {formatMoney(payout(waiter.id) - amount)}
          </span>
        )}
      </div>

      <div className="px-4 pb-3">
        <div className="mb-1.5 text-xs text-fg-muted">
          {waiter ? "кто ел" : "выберите сотрудника"}
        </div>
        <div className="flex flex-wrap gap-2">
          {crew.map((w) => {
            const on = w.id === waiterId;
            const had = already(w.id);
            return (
              <button
                key={w.id}
                onClick={() => {
                  setFailed(false);
                  setWaiterId(w.id);
                }}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  on
                    ? "border-sand bg-sand/10 text-fg"
                    : "border-line bg-surface text-fg-muted active:bg-surface-2"
                }`}
              >
                {w.short}
                {had > 0 && (
                  <span className="ml-1.5 text-xs text-fg-muted">
                    −{formatMoney(had)}
                  </span>
                )}
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
        <div
          className={`mb-1.5 text-xs ${failed ? "text-alert" : "text-fg-muted"}`}
        >
          {saving
            ? "сохраняю…"
            : failed
              ? "не сохранилось — проверьте связь и повторите"
              : "вычитается из выплаты, на порог 1 300 ₽ не влияет"}
        </div>
        <button
          disabled={!ready}
          onClick={confirm}
          className="w-full rounded-xl bg-sand py-3.5 text-base text-ink disabled:bg-surface disabled:text-fg-muted"
        >
          Записать вычет
        </button>
      </div>
    </div>
  );
}
