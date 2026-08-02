"use client";

import { formatBusinessDay, formatMoney } from "@/lib/businessDay";
import type { Shift } from "@/lib/crew";
import { buildExport, downloadExport } from "@/lib/exportShift";
import { THRESHOLD, splitShift } from "@/lib/split";
import type { Employee, Entry } from "@/lib/types";

type Props = {
  day: string;
  entries: Entry[];
  crew: Employee[];
  shift: Shift;
  everyone: Employee[];
  onClose: () => void;
  onHistory: () => void;
};

export default function ShiftSummary({
  day,
  entries,
  crew,
  shift,
  everyone,
  onClose,
  onHistory,
}: Props) {
  const s = splitShift(entries, crew, day);
  const paying = s.waiters.filter((w) => w.aboveThreshold).length;

  return (
    <div className="flex min-h-dvh flex-col pb-8">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <button
          onClick={onClose}
          aria-label="Назад"
          className="-ml-1 rounded-lg px-2 py-1 text-2xl leading-none text-fg-muted active:bg-surface"
        >
          ‹
        </button>
        <div>
          <div className="text-base">Итоги смены</div>
          <div className="text-xs text-fg-muted">
            {formatBusinessDay(day)} · {s.crewSize}{" "}
            {plural(s.crewSize, "официант", "официанта", "официантов")}
          </div>
        </div>
      </header>

      <div className="px-4 pt-4">
        <div className="rounded-xl bg-surface p-4">
          <div className="text-xs text-fg-muted">заработано за смену</div>
          <div className="text-3xl tabular-nums">
            {formatMoney(s.totalEarned)}
          </div>

          <div className="mt-3 flex justify-between border-t border-line pt-2.5 text-sm">
            <span className="text-fg-muted">чаевые</span>
            <span className="tabular-nums">
              {formatMoney(s.totalCash + s.totalTerminal)}
            </span>
          </div>
          <div className="text-xs text-fg-muted">
            наличные {formatMoney(s.totalCash)} · терминал{" "}
            {formatMoney(s.totalTerminal)}
          </div>
          <div className="mt-2 flex justify-between text-sm">
            <span className="text-fg-muted">сервисный сбор</span>
            <span className="tabular-nums">{formatMoney(s.totalService)}</span>
          </div>
        </div>
      </div>

      <div className="px-4 pt-3">
        <Row label="Администратору" value={s.adminTotal} />
        <Row
          label="Кассиру"
          value={s.cashierTotal}
          note={
            s.crewSize > 0
              ? // Сумма кассира зависит от дня недели, поэтому показываем
                // её целиком: видно, из чего сложилась доля.
                `${formatMoney(s.cashierPool)} ÷ ${s.crewSize} = по ${formatMoney(s.cashierShare)} · платят ${paying}`
              : undefined
          }
        />
        <Row label="Официантам на руки" value={s.waitersNet} strong />
      </div>

      <div className="px-4 pt-4">
        <button
          onClick={onHistory}
          className="mb-2 w-full rounded-xl border border-line bg-surface py-3.5 text-base text-fg active:bg-surface-2"
        >
          История записей ›
        </button>
        <button
          disabled={entries.length === 0}
          onClick={() =>
            downloadExport(buildExport(day, entries, crew, shift, everyone))
          }
          className="w-full rounded-xl border border-sand py-3.5 text-base text-sand disabled:border-line disabled:text-fg-muted"
        >
          Выгрузить смену для отчёта
        </button>
      </div>

      <div className="px-4 pb-1.5 pt-5 text-xs text-fg-muted">по официантам</div>
      <div className="flex flex-col gap-2 px-4">
        {s.waiters.map((w) => (
          <div key={w.waiterId} className="rounded-xl bg-surface p-3.5">
            <div className="flex items-baseline justify-between">
              <span className="text-base">{w.waiterName}</span>
              <span className="tabular-nums">{formatMoney(w.total)}</span>
            </div>
            <div className="mt-1.5 flex justify-between text-sm">
              <span className="text-fg-muted">чаевые</span>
              <span className="tabular-nums text-fg-muted">
                {formatMoney(w.tips)}
              </span>
            </div>
            <div className="text-xs text-fg-muted">
              наличные {formatMoney(w.cash)} · терминал {formatMoney(w.terminal)}
            </div>
            <div className="mt-1 flex justify-between text-sm">
              <span className="text-fg-muted">сервисный сбор</span>
              <span className="tabular-nums text-fg-muted">
                {formatMoney(w.service)}
              </span>
            </div>

            {w.aboveThreshold ? (
              <div className="mt-2.5 border-t border-line pt-2.5 text-sm">
                <Line label="администратору" value={-w.toAdmin} />
                {w.toCashier > 0 ? (
                  <Line label="кассиру" value={-w.toCashier} />
                ) : (
                  <div className="flex justify-between text-fg-muted">
                    <span>кассиру</span>
                    <span>только сбор — не делится</span>
                  </div>
                )}
                <div className="mt-1.5 flex justify-between">
                  <span className="text-fg-muted">на руки</span>
                  <span className="tabular-nums text-sand">
                    {formatMoney(w.net)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="mt-2.5 border-t border-line pt-2.5 text-xs text-fg-muted">
                меньше {formatMoney(THRESHOLD)} — не делится
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  note,
  strong,
}: {
  label: string;
  value: number;
  note?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-line py-2.5 last:border-0">
      <div>
        <div className={strong ? "text-base" : "text-sm"}>{label}</div>
        {note && <div className="text-xs text-fg-muted">{note}</div>}
      </div>
      <span className={`tabular-nums ${strong ? "text-lg" : ""}`}>
        {formatMoney(value)}
      </span>
    </div>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <span className="text-fg-muted">{label}</span>
      <span className="tabular-nums text-fg-muted">{formatMoney(value)}</span>
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
