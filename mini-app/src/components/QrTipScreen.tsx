"use client";

import { useState } from "react";
import { formatMoney } from "@/lib/businessDay";
import { shares } from "@/lib/split";
import type { Employee, QrTip } from "@/lib/types";

/**
 * Распределение поступления по персональному QR.
 *
 * Эти деньги приходят мимо зала: гость платит по QR на чеке, кассир их
 * не видит и внести не может — о поступлении сообщает только Сбер
 * уведомлением в Telegram.
 *
 * Сбер называет не человека, а котёл — «Официант 5». Кто именно обслуживал
 * гостя, не знает никто, поэтому получателей выбирает кассир из состава
 * смены, а сумма делится между ними поровну.
 */

type Props = {
  tip: QrTip;
  /** Официанты, отмеченные на смене. */
  crew: Employee[];
  onCancel: () => void;
  onConfirm: (waiters: Employee[]) => Promise<void>;
};

/** «01:26» — время поступления, чтобы соотнести его с вечером. */
function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function QrTipScreen({ tip, crew, onCancel, onConfirm }: Props) {
  const [ids, setIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const waiters = ids
    .map((id) => crew.find((w) => w.id === id))
    .filter((w): w is Employee => w !== undefined);
  const parts = shares(tip.amount, waiters.length);
  const ready = waiters.length > 0 && !saving;
  const allPicked = crew.length > 0 && ids.length === crew.length;

  function toggle(id: number) {
    setFailed(null);
    setIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }

  async function confirm() {
    if (!ready) return;
    setSaving(true);
    setFailed(null);
    try {
      await onConfirm(waiters);
      // При успехе экран закрывается сверху.
    } catch (error) {
      // Второй кассир мог разнести это поступление секундой раньше —
      // тогда база откажет, и сказать об этом надо прямо.
      setFailed(
        error instanceof Error && error.message
          ? error.message
          : "не получилось — проверьте связь и повторите",
      );
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
        <div className="text-base">Чаевые по QR</div>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-1 py-6">
        <span className="text-4xl tabular-nums text-fg">
          {formatMoney(tip.amount)}
        </span>
        <span className="text-xs text-fg-muted">
          {tip.team} · пришли в {clock(tip.receivedAt)}
        </span>
      </div>

      <div className="px-4 pb-3">
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-xs text-fg-muted">
            {waiters.length === 0
              ? "кому раздать"
              : waiters.length === 1
                ? "получатель"
                : `делим поровну на ${waiters.length}`}
          </span>
          {crew.length > 1 && (
            <button
              onClick={() => {
                setFailed(null);
                setIds(allPicked ? [] : crew.map((w) => w.id));
              }}
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs ${
                allPicked
                  ? "border-sand bg-sand/10 text-fg"
                  : "border-line bg-surface text-fg-muted active:bg-surface-2"
              }`}
            >
              {allPicked ? "× снять всех" : "всем на смене"}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {crew.map((w) => {
            const on = ids.includes(w.id);
            return (
              <button
                key={w.id}
                onClick={() => toggle(w.id)}
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
        {waiters.length > 1 && (
          <div className="mt-2 text-xs text-fg-muted">
            {waiters
              .map((w, i) => `${w.short} — ${formatMoney(parts[i])}`)
              .join(" · ")}
          </div>
        )}
      </div>

      <div className="px-4 pb-6 pt-3">
        <div
          className={`mb-1.5 text-xs ${failed ? "text-alert" : "text-fg-muted"}`}
        >
          {saving
            ? "сохраняю…"
            : failed
              ? failed
              : "войдут в заработок официанта наравне с остальными чаевыми"}
        </div>
        <button
          disabled={!ready}
          onClick={confirm}
          className="w-full rounded-xl bg-sand py-3.5 text-base text-ink disabled:bg-surface disabled:text-fg-muted"
        >
          Разнести
        </button>
      </div>
    </div>
  );
}
