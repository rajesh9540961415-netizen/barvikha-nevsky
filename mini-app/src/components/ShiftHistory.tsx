"use client";

import { useEffect, useMemo, useState } from "react";
import { formatBusinessDay, formatMoney } from "@/lib/businessDay";
import { historyByDay } from "@/lib/storage";
import type { Entry, Kind } from "@/lib/types";

/**
 * История записей за смену — для самопроверки.
 *
 * Здесь видно то, чего нет больше нигде: когда именно внесли, кто внёс
 * и что отменяли. Отменённые записи показываются перечёркнутыми: они
 * не входят ни в суммы, ни в отчёт, но след о них остаётся.
 *
 * Дни листаются стрелками — чтобы посмотреть прошлую смену, не нужно
 * ничего запускать и ни к кому обращаться.
 */

const KIND_LABEL: Record<Kind, string> = {
  cash: "наличные",
  terminal: "терминал",
  service: "сбор",
  qr: "QR",
  staff: "питание",
};

type Loading = "loading" | "ready" | "failed";

type Props = {
  day: string;
  onClose: () => void;
};

/** Сдвиг дня на ±1 без часовых поясов: ключ — просто ГГГГ-ММ-ДД. */
function shiftDay(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d + delta);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** «21:47» из ISO — время ввода, по часам того, кто вносил. */
function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function ShiftHistory({ day, onClose }: Props) {
  const [shown, setShown] = useState(day);
  const [rows, setRows] = useState<Entry[]>([]);
  const [loading, setLoading] = useState<Loading>("loading");
  const [attempt, setAttempt] = useState(0);
  const [waiter, setWaiter] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await historyByDay(shown);
        if (!alive) return;
        setRows(data);
        setLoading("ready");
      } catch {
        if (alive) setLoading("failed");
      }
    })();
    return () => {
      alive = false;
    };
  }, [shown, attempt]);

  // Официанты этого дня — для фильтра. За смену набегает под сотню записей,
  // и без отбора по человеку история читается плохо.
  const waiters = useMemo(() => {
    const names = new Set(rows.map((r) => r.waiterName));
    return [...names].sort((a, b) => a.localeCompare(b, "ru"));
  }, [rows]);

  const visible = useMemo(
    () => (waiter ? rows.filter((r) => r.waiterName === waiter) : rows),
    [rows, waiter],
  );

  /**
   * Строки, собранные обратно в события.
   *
   * Поделённые чаевые лежат в базе отдельными строками — по одной на официанта.
   * Показывать их порознь нельзя: вышла бы ровно та картина, из-за которой
   * полсмены 1 августа выглядело задвоением — два одинаковых ввода по одному
   * столу подряд. Здесь они снова становятся одной строкой истории.
   *
   * При отборе по официанту от группы остаётся одна строка: тогда видна только
   * его доля, и подпись честно говорит, что это доля.
   */
  const events = useMemo(() => {
    const list: Entry[][] = [];
    const byGroup = new Map<string, Entry[]>();
    for (const r of visible) {
      if (!r.splitGroup) {
        list.push([r]);
        continue;
      }
      const found = byGroup.get(r.splitGroup);
      if (found) {
        found.push(r);
        continue;
      }
      const created = [r];
      byGroup.set(r.splitGroup, created);
      list.push(created);
    }
    return list;
  }, [visible]);

  // Считаем события, а не строки: поделённые чаевые — это одна запись
  // за вечер, а не две, и в шапке должно стоять то же число, которое
  // администратор видит на главном экране.
  const alive = events.filter((ev) => !ev[0].deletedAt);
  const cancelled = events.length - alive.length;
  const total = alive.reduce(
    (sum, ev) => sum + ev.reduce((acc, r) => acc + r.amount, 0),
    0,
  );

  function goto(delta: number) {
    setWaiter(null);
    setLoading("loading");
    setShown((d) => shiftDay(d, delta));
  }

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
        <div className="flex-1">
          <div className="text-base">История</div>
          <div className="text-xs text-fg-muted">
            {formatBusinessDay(shown)} · {alive.length}{" "}
            {plural(alive.length, "запись", "записи", "записей")} ·{" "}
            {formatMoney(total)}
            {cancelled > 0 && ` · отменено ${cancelled}`}
          </div>
        </div>
        <button
          onClick={() => goto(-1)}
          aria-label="Предыдущий день"
          className="rounded-lg border border-line px-2.5 py-1.5 text-sm text-fg-muted active:bg-surface"
        >
          ‹ день
        </button>
        <button
          onClick={() => goto(1)}
          aria-label="Следующий день"
          className="rounded-lg border border-line px-2.5 py-1.5 text-sm text-fg-muted active:bg-surface"
        >
          день ›
        </button>
      </header>

      {waiters.length > 1 && (
        <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2.5">
          <Chip on={waiter === null} onClick={() => setWaiter(null)}>
            все
          </Chip>
          {waiters.map((name) => (
            <Chip
              key={name}
              on={waiter === name}
              onClick={() => setWaiter(waiter === name ? null : name)}
            >
              {name}
            </Chip>
          ))}
        </div>
      )}

      {loading === "loading" && (
        <p className="p-8 text-center text-sm text-fg-muted">Загружаю…</p>
      )}

      {loading === "failed" && (
        <div className="flex flex-col items-center gap-4 p-8 text-center">
          <p className="text-sm text-fg-muted">Не удалось загрузить историю.</p>
          <button
            onClick={() => {
              setLoading("loading");
              setAttempt((n) => n + 1);
            }}
            className="rounded-xl bg-sand px-6 py-3 text-base text-ink"
          >
            Повторить
          </button>
        </div>
      )}

      {loading === "ready" && events.length === 0 && (
        <p className="p-8 text-center text-sm text-fg-muted">
          За этот день записей нет.
        </p>
      )}

      {loading === "ready" && events.length > 0 && (
        <ul className="divide-y divide-line pb-8">
          {events.map((ev) => {
            const head = ev[0];
            const sum = ev.reduce((acc, r) => acc + r.amount, 0);
            // Что оставил гость — до комиссии Сбера. Совпадает с суммой везде,
            // кроме терминала.
            const grossSum = ev.reduce((acc, r) => acc + (r.gross ?? r.amount), 0);
            const fee = Math.round((head.commissionRate ?? 0) * 100);
            const split = ev.length > 1;
            const gone = Boolean(head.deletedAt);
            return (
              <li key={head.splitGroup ?? head.id} className="px-4 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className={`text-sm ${gone ? "text-fg-muted line-through" : "text-fg"}`}
                  >
                    {/* У чаевых по QR ни зала, ни стола нет: гость платил
                        по чеку. Пишем откуда пришло, чтобы строка не
                        начиналась с пустоты. */}
                    {head.tableTitle
                      ? `${head.hallTitle} · ${head.tableTitle}`
                      : "по QR"}{" "}
                    · {ev.map((r) => r.waiterName).join(" + ")}
                  </span>
                  <span
                    className={`shrink-0 tabular-nums ${
                      gone ? "text-fg-muted line-through" : "text-fg"
                    }`}
                  >
                    {formatMoney(sum)}
                  </span>
                </div>
                <div className="text-xs text-fg-muted">
                  {clock(head.createdAt)} · {KIND_LABEL[head.kind]} · внёс{" "}
                  {head.operatorName}
                  {/* Одна строка из группы попадает сюда только при отборе
                      по официанту — говорим прямо, что это часть суммы. */}
                  {!split && head.splitGroup ? " · доля из поделённых" : ""}
                </div>
                {/* Комиссию называем отдельной строкой: в сумме записи её уже
                    нет, и без пояснения цифра не сходится с терминалом. */}
                {grossSum !== sum && (
                  <div className="text-xs text-fg-muted">
                    гость оставил {formatMoney(grossSum)} · комиссия {fee} %
                  </div>
                )}
                {split && (
                  <div className="text-xs text-fg-muted">
                    поровну:{" "}
                    {ev
                      .map((r) => `${r.waiterName} — ${formatMoney(r.amount)}`)
                      .join(" · ")}
                  </div>
                )}
                {head.deletedAt && (
                  <div className="text-xs text-alert">
                    отменено в {clock(head.deletedAt)}
                    {head.deletedByName ? ` · ${head.deletedByName}` : ""}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1 text-xs ${
        on
          ? "border-sand bg-sand/10 text-fg"
          : "border-line bg-surface text-fg-muted active:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
