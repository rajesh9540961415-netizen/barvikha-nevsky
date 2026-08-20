"use client";

import { useEffect, useMemo, useState } from "react";
import { formatBusinessDay, formatMoney } from "@/lib/businessDay";
import { buildEvents } from "@/lib/events";
import { HOOKAH_POT_ID } from "@/lib/split";
import { historyByDay } from "@/lib/storage";
import type { Entry, Kind } from "@/lib/types";

/**
 * История записей за смену — для самопроверки и для правки.
 *
 * Здесь видно то, чего нет больше нигде: когда именно внесли, кто внёс
 * и что отменяли. Отменённые записи показываются перечёркнутыми: они
 * не входят ни в суммы, ни в отчёт, но след о них остаётся.
 *
 * Нажатие на запись открывает правку — но только на записи **текущей**
 * смены. Прошлые дни отсюда листаются и читаются, а правит их бэк-офис:
 * смена отвечает за свою ночь, управляющий состав — за любой период.
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
  /**
   * Записи, которые ещё ждут отправки в базу.
   *
   * Их подмешиваем к прочитанному и помечаем: история — экран самопроверки,
   * и «прошла моя запись или нет» смотрят именно здесь. Без сети это
   * единственное место, где видно, что записалось.
   */
  pending: Entry[];
  /**
   * Что известно из базы за сегодня — на случай, если прочитать не удалось.
   * За прошлые дни этого запаса нет: без связи их взять неоткуда.
   */
  cached: Entry[];
  /**
   * Записи, отменённые на этом телефоне, но ещё не отмеченные в базе.
   * Показываем их зачёркнутыми — иначе отменённая запись выглядела бы живой,
   * и её отменили бы второй раз.
   */
  cancelledHere: ReadonlySet<string>;
  onClose: () => void;
  /**
   * Открыть запись на правку. Ключ события — метка группы у поделённых
   * чаевых, номер записи у обычной.
   *
   * Зовётся только для живых записей текущей смены: прошлые дни
   * и отменённое отсюда не правятся.
   */
  onEdit: (key: string) => void;
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

export default function ShiftHistory({
  day,
  pending,
  cached,
  cancelledHere,
  onClose,
  onEdit,
}: Props) {
  const [shown, setShown] = useState(day);
  const [fromDb, setFromDb] = useState<Entry[]>([]);
  const [loading, setLoading] = useState<Loading>("loading");
  const [attempt, setAttempt] = useState(0);
  const [waiter, setWaiter] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await historyByDay(shown);
        if (!alive) return;
        setFromDb(data);
        setLoading("ready");
      } catch {
        if (alive) setLoading("failed");
      }
    })();
    return () => {
      alive = false;
    };
  }, [shown, attempt]);

  /** Номера записей, которых в базе ещё нет — их помечаем в списке. */
  const waitingIds = useMemo(
    () => new Set(pending.map((e) => e.id)),
    [pending],
  );

  /**
   * Что показываем: прочитанное из базы плюс ждущее отправки.
   *
   * Если прочитать не удалось, за сегодня берём то, что известно главному
   * экрану. Прошлые дни в таком случае показать нечем — там честный отказ.
   */
  const rows = useMemo(() => {
    const base = loading === "failed" ? (shown === day ? cached : []) : fromDb;
    if (shown !== day || pending.length === 0) return base;
    const byId = new Map(base.map((r) => [r.id, r]));
    for (const e of pending) if (!byId.has(e.id)) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }, [loading, shown, day, cached, fromDb, pending]);

  /** Показывать список, даже если чтение не удалось, но что-то есть. */
  const offlineList = loading === "failed" && rows.length > 0;

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
  const events = useMemo(() => buildEvents(visible), [visible]);

  /** Отменено — в базе или пока только на этом телефоне. */
  const isGone = (ev: (typeof events)[number]) =>
    Boolean(ev.deletedAt) || cancelledHere.has(ev.rows[0].id);

  // Считаем события, а не строки: поделённые чаевые — это одна запись
  // за вечер, а не две, и в шапке должно стоять то же число, которое
  // администратор видит на главном экране.
  const alive = events.filter((ev) => !isGone(ev));
  const gone = events.filter((ev) => isGone(ev));
  // «Отменено» и «поправлено» — разные вещи, и в шапке их складывать нельзя:
  // отменённые деньги из смены ушли, поправленные остались в новом виде.
  const replaced = gone.filter((ev) => ev.replacedBy !== null).length;
  const cancelled = gone.length - replaced;
  const total = alive.reduce((sum, ev) => sum + ev.amount, 0);
  /** Записи текущей смены правятся, прошлые — нет. */
  const editable = shown === day;

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
            {replaced > 0 && ` · поправлено ${replaced}`}
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

      {/* Про правку говорим подписью, а не оставляем догадываться. Именно
          на этом споткнулись при проверке 14.08.2026: нажимали на запись,
          ничего не происходило, и понять почему было неоткуда. */}
      {events.length > 0 && (
        <p className="border-b border-line px-4 py-2 text-xs text-fg-muted">
          {editable
            ? "Нажмите на запись, чтобы поправить или отменить её."
            : "Прошлая смена: записи только видны. Поправить их можно в бэк-офисе."}
        </p>
      )}

      {loading === "loading" && (
        <p className="p-8 text-center text-sm text-fg-muted">Загружаю…</p>
      )}

      {offlineList && (
        <p className="border-b border-line px-4 py-2 text-xs text-alert">
          Связи нет — показано то, что известно этому телефону. Отменённые
          записи и записи со второго телефона могут не отображаться.
        </p>
      )}

      {loading === "failed" && !offlineList && (
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

      {(loading === "ready" || offlineList) && events.length > 0 && (
        <ul className="divide-y divide-line pb-8">
          {events.map((ev) => {
            const head = ev.rows[0];
            const sum = ev.amount;
            // Что оставил гость — до комиссии Сбера. Совпадает с суммой везде,
            // кроме терминала.
            const grossSum = ev.gross;
            const fee = Math.round((head.commissionRate ?? 0) * 100);
            const split = ev.rows.length > 1;
            const gone = isGone(ev);
            // Нажимается только живая запись текущей смены. Отменённую править
            // нечего: её уже нет в деньгах смены, а след должен остаться как есть.
            const canEdit = editable && !gone;
            const body = (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className={`text-sm ${gone ? "text-fg-muted line-through" : "text-fg"}`}
                  >
                    {/* Ни зала, ни стола не бывает у трёх случаев, и они
                        разные: чаевые по QR (гость платил по чеку), хостес
                        и кальянный бар. Написать всем «по QR» значит
                        назвать деньги чужим именем в единственном месте,
                        где смена себя проверяет.

                        Стол спрашиваем ПЕРВЫМ: у чаевых, которые гость
                        оставил за столом и попросил поделить с баром, стол
                        есть — и он говорит, откуда деньги, точнее названия
                        котла. */}
                    {head.tableTitle
                      ? `${head.hallTitle} · ${head.tableTitle}`
                      : ev.contour === "hookah"
                        ? "кальянный бар"
                        : ev.contour === "hostess"
                          ? "хостес"
                          : "по QR"}{" "}
                    ·{" "}
                    {ev.waiters
                      .map(
                        (w) =>
                          // У получателя со стороны подписываем котёл прямо
                          // в строке: «Аня + Дима» ничего не говорит о том,
                          // что половина ушла в бар, а деньги там считаются
                          // по другим правилам.
                          w.name +
                          // Общий котёл бара не подписываем: его имя
                          // «Весь бар» и так всё говорит, а «Весь бар (бар)»
                          // выглядит опечаткой.
                          (w.id === HOOKAH_POT_ID
                            ? ""
                            : w.contour === "hookah"
                              ? " (бар)"
                              : w.contour === "hostess"
                                ? " (хостес)"
                                : ""),
                      )
                      .join(" + ")}
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
                {/* Запись сделана, но до базы ещё не доехала. Здесь это
                    видно поимённо — на главном экране только счётчик. */}
                {waitingIds.has(head.id) && !gone && (
                  <div className="text-xs text-alert">ждёт отправки</div>
                )}
                {cancelledHere.has(head.id) && !head.deletedAt && (
                  <div className="text-xs text-alert">отмена ждёт отправки</div>
                )}
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
                    {ev.rows
                      .map((r) => `${r.waiterName} — ${formatMoney(r.amount)}`)
                      .join(" · ")}
                  </div>
                )}
                {/* «Поправлено» и «отменено» в базе выглядят одинаково —
                    отменённой строкой. Разница в том, встало ли на её место
                    что-то новое, и на экране это разные вещи. */}
                {head.deletedAt && (
                  <div className="text-xs text-alert">
                    {ev.replacedBy ? "поправлено" : "отменено"} в{" "}
                    {clock(head.deletedAt)}
                    {head.deletedByName ? ` · ${head.deletedByName}` : ""}
                  </div>
                )}
                {/* Запись-замена. Что было до правки, видно рядом
                    перечёркнутой строкой — она никуда не делась. */}
                {ev.corrects && !gone && (
                  <div className="text-xs text-fg-muted">поправлено</div>
                )}
              </>
            );
            return (
              <li key={ev.key}>
                {canEdit ? (
                  <button
                    onClick={() => onEdit(ev.key)}
                    className="w-full px-4 py-2.5 text-left active:bg-surface"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="px-4 py-2.5">{body}</div>
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
