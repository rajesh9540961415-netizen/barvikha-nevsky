"use client";

import { useMemo, useState } from "react";
import TablePicker from "@/components/TablePicker";
import { formatMoney } from "@/lib/businessDay";
import {
  SIDE_KINDS,
  contoursOf,
  draftError,
  draftOf,
  needsTable,
  rowsFromDraft,
  withReplacement,
  type Draft,
  type Payee,
  type ShiftEvent,
} from "@/lib/events";
import { COMMISSION_RATE, netAmount, THRESHOLD, splitShift } from "@/lib/split";
import type { Contour, Employee, Entry, Hall, Kind } from "@/lib/types";

/**
 * Правка записи текущей смены.
 *
 * Открывается нажатием на запись в истории. Правится не строка, а событие:
 * поделённые между официантами чаевые лежат в базе несколькими строками,
 * но гость оставил их один раз — значит и меняются они целиком, с делением
 * заново. Иначе, поправив одну долю с 1250 на 1500, получишь 2750 там,
 * где гость оставил 2500.
 *
 * Экран ничего не пишет сам: он собирает строки и отдаёт их наверх. Кто
 * имеет право править и что при этом уходит в базу — дело главного экрана.
 */

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"];

/** Больше вводить и не нужно: защита от случайного лишнего нуля. */
const MAX_AMOUNT = 200_000;

const KIND_LABEL: Record<Kind, string> = {
  cash: "наличные",
  terminal: "терминал",
  qr: "QR",
  service: "сбор",
  staff: "питание",
};

const KINDS: Kind[] = ["cash", "terminal", "qr", "service", "staff"];

type Props = {
  event: ShiftEvent<Entry>;
  /** Живые записи смены — по ним считается «было / стало». */
  live: Entry[];
  /** Официанты смены: по ним считается порог 1300 ₽ и доли. */
  crew: Employee[];
  /**
   * Кому можно приписать эту запись — и в какой котёл лягут его деньги.
   *
   * У зальной записи это официанты смены, у хостес — хостес этого вечера,
   * у кальянного бара — кальянщики и общий котёл. Отдельно от `crew`
   * намеренно: список получателей и состав зала — разные вещи, и подставив
   * сюда зал, правка чаевых кальянщика молча предложила бы официантов.
   *
   * Котёл идёт рядом с человеком, а не выводится из его роли на сегодня:
   * у записи со стола получатели бывают из разных котлов, и от того, из
   * какого списка человека выбрали, зависит, вычтут ли из его доли 20 %
   * администратору и долю кассира.
   */
  people: { person: Employee; contour: Contour }[];
  /** Кто правит: тот, кто отмечен вносящим записи в этой смене. */
  operator: Employee;
  halls: Hall[];
  day: string;
  onClose: () => void;
  /** Строки, которые встанут вместо старых. Уже поделены и с комиссией. */
  onSave: (rows: Entry[]) => Promise<void>;
  /** Отменить запись без замены. */
  onDrop: () => Promise<void>;
};

export default function EntryEditor({
  event,
  live,
  crew,
  people,
  operator,
  halls,
  day,
  onClose,
  onSave,
  onDrop,
}: Props) {
  const was = useMemo(() => draftOf(event), [event]);

  /**
   * Главный котёл записи. Правка его не меняет — он и определяет, что можно
   * менять: у зальной записи бывают все виды денег, у записи со стороны
   * только её.
   *
   * ⚠️ Терминал попадает в список стороны, только если у записи есть стол.
   * Своего терминала у хостес и бара нет — но гость может заплатить
   * на зальном терминале и попросить поделить, и тогда у барской доли
   * стол есть. Правило то же, что в `draftError`.
   */
  const contour = event.contour;
  const kinds =
    contour === "hall"
      ? KINDS
      : event.tableId !== null
        ? [...SIDE_KINDS, "terminal" as Kind]
        : SIDE_KINDS;

  /**
   * Набранная сумма. Пока не трогали клавиатуру — пусто, и в дело идёт сумма
   * исходной записи.
   *
   * Так копейки не теряются. Клавиатура набирает целые рубли, а у чаевых
   * по QR копейки бывают: Сбер присылает сумму как есть. Если человек правит
   * только официанта, сумма обязана остаться нетронутой до последней копейки.
   */
  const [digits, setDigits] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>(was.kind);
  /**
   * Кому и в какой котёл — по порядку, как лягут доли.
   *
   * Номерами тут не обойтись: один и тот же человек может стоять в смене
   * и официантом, и хостес, а от котла зависят деньги. Держим пару целиком.
   */
  const [payees, setPayees] = useState<Payee[]>(was.payees);
  const [splitting, setSplitting] = useState(was.payees.length > 1);
  const [table, setTable] = useState({
    hallId: was.hallId,
    hallTitle: was.hallTitle,
    tableId: was.tableId,
    tableTitle: was.tableTitle,
  });
  const [picking, setPicking] = useState(false);
  const [details, setDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // Отмена запись не стирает, но с экрана она пропадает — и переспросить
  // об этом надо. Промах по кнопке не должен убирать деньги смены.
  const [dropping, setDropping] = useState(false);

  const gross = digits === null ? event.gross : Number(digits || "0");

  const draft: Draft = useMemo(
    () => ({
      kind,
      gross,
      hallId: table.hallId,
      hallTitle: table.hallTitle,
      tableId: table.tableId,
      tableTitle: table.tableTitle,
      payees,
    }),
    [kind, gross, table, payees],
  );
  const problem = draftError(draft);

  /**
   * Строки, которые лягут в базу вместо старых.
   *
   * Их же считает предпросмотр — в том и смысл, что «было / стало»
   * и сохранение проходят через один расчёт. Показать одно, а записать
   * другое — худшее, что может сделать денежный экран.
   */
  const fresh: Entry[] = useMemo(() => {
    if (problem) return [];
    return rowsFromDraft(draft, {
      businessDay: day,
      // Время исходной записи: деньги гость оставил тогда, и в истории
      // запись должна остаться на своём месте, а не прыгнуть наверх.
      createdAt: event.createdAt,
      operatorId: operator.id,
      operatorName: operator.name,
      corrects: event.key,
      source: "shift",
      // Зачем поправили, в смене не спрашиваем: след и так остаётся —
      // кто, когда, что было, что стало. Решение владельца 14.08.2026.
      note: null,
      nameOf: (id) =>
        people.find((o) => o.person.id === id)?.person.name ??
        // Человека могли убрать из состава уже после того, как записали ему
        // деньги. Имя тогда берём из самой записи: терять получателя нельзя.
        event.waiters.find((w) => w.id === id)?.name ??
        `№${id}`,
    }).map((row) => ({ ...row, operatorId: operator.id }));
  }, [problem, draft, day, event, people, operator]);

  const money = (rows: Entry[]) =>
    rows.filter((e) => e.kind !== "staff").reduce((sum, e) => sum + e.amount, 0);

  /** Смена, какой она станет после правки. */
  const after = useMemo(
    () => (fresh.length === 0 ? live : withReplacement(live, event.key, fresh)),
    [fresh, live, event.key],
  );

  const totalBefore = money(live);
  const totalAfter = money(after);
  const splitBefore = useMemo(
    () => splitShift(live, crew, day),
    [live, crew, day],
  );
  const splitAfter = useMemo(
    () => splitShift(after, crew, day),
    [after, crew, day],
  );

  /**
   * Кто перешёл порог 1300 ₽ — в ту или другую сторону.
   *
   * Это главное, чего не видно по одной строке. Правка на полсотни рублей
   * может перевести человека через порог, и тогда пересчитываются доли
   * администратора, кассира и итог каждого в смене.
   */
  const crossed = useMemo(() => {
    const moved: { name: string; up: boolean }[] = [];
    for (const before of splitBefore.waiters) {
      const now = splitAfter.waiters.find((w) => w.waiterId === before.waiterId);
      if (!now || now.aboveThreshold === before.aboveThreshold) continue;
      const person = crew.find((p) => p.id === before.waiterId);
      moved.push({
        name: person?.short ?? before.waiterName,
        up: now.aboveThreshold,
      });
    }
    return moved;
  }, [splitBefore, splitAfter, crew]);

  const changed = totalBefore !== totalAfter || crossed.length > 0;
  const ready = problem === null && !saving;
  const terminalFee = Math.round(COMMISSION_RATE.terminal * 100);

  function press(key: string) {
    setFailed(false);
    if (key === "⌫") {
      setDigits((d) => (d === null ? "" : d.slice(0, -1)));
      return;
    }
    const current = digits ?? "";
    const next = (current + key).replace(/^0+/, "");
    if (Number(next || "0") <= MAX_AMOUNT) setDigits(next);
  }

  function pickWaiter(id: number, contourOfPerson: Contour) {
    setFailed(false);
    setPayees((current) => {
      if (!splitting) return [{ id, contour: contourOfPerson }];
      return current.some((p) => p.id === id && p.contour === contourOfPerson)
        ? current.filter((p) => !(p.id === id && p.contour === contourOfPerson))
        : [...current, { id, contour: contourOfPerson }];
    });
  }

  async function save() {
    if (!ready || fresh.length === 0) return;
    setSaving(true);
    setFailed(false);
    try {
      await onSave(fresh);
      // При успехе экран закрывается сверху.
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  async function drop() {
    setSaving(true);
    setFailed(false);
    try {
      await onDrop();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  if (picking) {
    return (
      <div className="flex min-h-dvh flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <button
            onClick={() => setPicking(false)}
            aria-label="Назад"
            className="-ml-1 rounded-lg px-2 py-1 text-2xl leading-none text-fg-muted active:bg-surface"
          >
            ‹
          </button>
          <div className="text-base">Выберите стол</div>
        </header>
        <div className="pt-3">
          <TablePicker
            halls={halls}
            activeHallId={table.hallId ?? halls[0].id}
            onHallChange={(hallId) =>
              setTable((t) => ({ ...t, hallId, hallTitle: null }))
            }
            onPick={(hall, picked) => {
              setTable({
                hallId: hall.id,
                hallTitle: hall.title,
                tableId: picked.id,
                tableTitle: picked.title,
              });
              setPicking(false);
              setFailed(false);
            }}
            usedTableIds={new Set<number>()}
          />
        </div>
      </div>
    );
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
          <div className="text-base">Правка записи</div>
          <div className="text-xs text-fg-muted">
            было: {formatMoney(event.gross)} · {KIND_LABEL[event.kind]}
            {event.tableTitle ? ` · ${event.tableTitle}` : ""} ·{" "}
            {event.waiters.map((w) => w.name).join(" + ")}
          </div>
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center py-5">
        <span
          className={`text-4xl tabular-nums ${gross > 0 ? "text-fg" : "text-fg-muted"}`}
        >
          {formatMoney(gross)}
        </span>
      </div>

      <div className="px-4 pb-3">
        <div className="mb-1.5 text-xs text-fg-muted">вид денег</div>
        <div className="flex flex-wrap gap-1.5">
          {kinds.map((k) => (
            <button
              key={k}
              onClick={() => {
                setKind(k);
                setFailed(false);
              }}
              className={`rounded-lg border px-2.5 py-1.5 text-sm ${
                kind === k
                  ? "border-sand bg-sand/10 text-fg"
                  : "border-line bg-surface text-fg-muted active:bg-surface-2"
              }`}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>

        {/* У QR и питания стола нет: гость платил по чеку, а не за столом. */}
        {needsTable(kind, contoursOf(payees)) && (
          <button
            onClick={() => setPicking(true)}
            className="mt-2.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-left text-sm active:bg-surface-2"
          >
            {table.tableId === null ? (
              <span className="text-alert">выберите стол</span>
            ) : (
              <span className="text-fg">
                {table.hallTitle} · {table.tableTitle}
              </span>
            )}
          </button>
        )}

        <div className="mb-1.5 mt-3 flex items-baseline justify-between gap-2">
          <span className="text-xs text-fg-muted">
            {payees.length === 0
              ? contour === "hall"
                ? "выберите официанта"
                : "выберите, кому"
              : payees.length === 1
                ? payees[0].contour === "hall"
                  ? "официант"
                  : payees[0].contour === "hookah"
                    ? "кальянный бар"
                    : "хостес"
                : `делим поровну на ${payees.length}`}
          </span>
          {people.length > 1 && (
            <button
              onClick={() => {
                setFailed(false);
                if (splitting) {
                  setPayees((current) => current.slice(0, 1));
                  setSplitting(false);
                  return;
                }
                setSplitting(true);
              }}
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs ${
                splitting
                  ? "border-sand bg-sand/10 text-fg"
                  : "border-line bg-surface text-fg-muted active:bg-surface-2"
              }`}
            >
              {splitting ? "× по одному" : "＋ разделить"}
            </button>
          )}
        </div>
        {/* Получатели по котлам. Разделены подписями, а не свалены в один
            ряд: от того, из какого списка выбран человек, зависят его деньги
            — зальная доля делится с администратором и кассиром, барская
            и хостес не делятся ни с кем. */}
        {(["hall", "hookah", "hostess"] as const).map((c) => {
          const список = people.filter((o) => o.contour === c);
          if (список.length === 0) return null;
          const подписи = { hall: "зал", hookah: "кальянный бар", hostess: "хостес" };
          return (
            <div key={c}>
              {/* Подпись нужна, только когда котлов больше одного: у обычной
                  зальной записи она была бы шумом. */}
              {new Set(people.map((o) => o.contour)).size > 1 && (
                <div className="mb-1 mt-2 text-[11px] text-fg-muted">
                  {подписи[c]}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {список.map(({ person: w }) => {
                  const on = payees.some(
                    (p) => p.id === w.id && p.contour === c,
                  );
                  return (
                    <button
                      key={`${c}-${w.id}`}
                      onClick={() => pickWaiter(w.id, c)}
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
          );
        })}
        {fresh.length > 1 && (
          <div className="mt-2 text-xs text-fg-muted">
            {fresh
              .map(
                (r) =>
                  `${shortOf(people.map((o) => o.person), r.waiterId)} — ${formatMoney(r.amount)}`,
              )
              .join(" · ")}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 px-4">
        {KEYS.map((k) => (
          <button
            key={k}
            onClick={() => press(k)}
            className="rounded-xl border border-line bg-surface py-3 text-2xl tabular-nums active:bg-surface-2"
          >
            {k}
          </button>
        ))}
      </div>

      <div className="px-4 pb-6 pt-3">
        {/* Что правка делает со всей сменой. Одной строкой: ночью полный
            экран «было / стало» промотают не глядя, а порог 1300 ₽ молчать
            не должен. Подробности — по нажатию. */}
        <button
          onClick={() => setDetails((d) => !d)}
          className="mb-2 w-full rounded-xl border border-line bg-surface px-3 py-2 text-left active:bg-surface-2"
        >
          <div className="text-xs text-fg-muted">
            {changed ? (
              <>
                итог смены: {formatMoney(totalBefore)} →{" "}
                <span className="text-fg">{formatMoney(totalAfter)}</span>
              </>
            ) : (
              <>итог смены не меняется · {formatMoney(totalBefore)}</>
            )}{" "}
            · {details ? "свернуть" : "подробнее"}
          </div>
          {crossed.map((c) => (
            <div key={c.name} className="mt-1 text-xs text-alert">
              {c.name} {c.up ? "переходит" : "перестаёт добирать"} порог{" "}
              {formatMoney(THRESHOLD)} — доли пересчитаются
            </div>
          ))}
        </button>

        {details && (
          <div className="mb-2 rounded-xl border border-line bg-surface p-3">
            <div className="mb-1.5 text-xs text-fg-muted">
              начислено за смену · было → станет
            </div>
            {splitBefore.waiters.map((before) => {
              const now = splitAfter.waiters.find(
                (w) => w.waiterId === before.waiterId,
              );
              const same = !now || now.accrued === before.accrued;
              return (
                <div
                  key={before.waiterId}
                  className="flex items-baseline justify-between gap-3 py-0.5 text-xs"
                >
                  <span className={same ? "text-fg-muted" : "text-fg"}>
                    {shortOf(crew, before.waiterId)}
                  </span>
                  <span className="tabular-nums text-fg-muted">
                    {formatMoney(before.accrued)}
                    {!same && (
                      <span className="text-fg">
                        {" → "}
                        {formatMoney(now.accrued)}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
            <div className="mt-1.5 border-t border-line pt-1.5 text-xs text-fg-muted">
              <Row
                title="администратору"
                before={splitBefore.adminTotal}
                after={splitAfter.adminTotal}
              />
              <Row
                title="кассиру"
                before={splitBefore.cashierTotal}
                after={splitAfter.cashierTotal}
              />
            </div>
          </div>
        )}

        <div
          className={`mb-1.5 text-xs ${
            failed || problem ? "text-alert" : "text-fg-muted"
          }`}
        >
          {saving
            ? "сохраняю…"
            : failed
              ? "не сохранилось — проверьте связь и повторите"
              : problem
                ? problem
                : kind === "terminal" && gross > 0
                  ? `по терминалу дойдёт ${formatMoney(netAmount(gross, "terminal"))}, комиссия ${terminalFee} %`
                  : "правка не стирает запись: старая останется в истории"}
        </div>

        <button
          disabled={!ready}
          onClick={save}
          className="w-full rounded-xl bg-sand py-3.5 text-base text-ink disabled:bg-surface disabled:text-fg-muted"
        >
          Сохранить
        </button>

        {dropping ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              onClick={() => setDropping(false)}
              className="rounded-xl border border-line py-3 text-sm text-fg-muted active:bg-surface-2"
            >
              Не отменять
            </button>
            <button
              disabled={saving}
              onClick={drop}
              className="rounded-xl bg-alert py-3 text-sm text-ink disabled:opacity-60"
            >
              Да, отменить
            </button>
          </div>
        ) : (
          <button
            disabled={saving}
            onClick={() => setDropping(true)}
            className="mt-2 w-full rounded-xl border border-line bg-surface py-3 text-sm text-fg-muted active:bg-surface-2"
          >
            Отменить запись целиком
          </button>
        )}
      </div>
    </div>
  );
}

function Row({
  title,
  before,
  after,
}: {
  title: string;
  before: number;
  after: number;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span>{title}</span>
      <span className="tabular-nums">
        {formatMoney(before)}
        {before !== after && (
          <span className="text-fg">
            {" → "}
            {formatMoney(after)}
          </span>
        )}
      </span>
    </div>
  );
}

/** Короткое имя для строки раскладки: в списке смены их до восьми. */
function shortOf(crew: Employee[], id: number): string {
  return crew.find((p) => p.id === id)?.short ?? `№${id}`;
}
