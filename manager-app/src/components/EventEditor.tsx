"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import scheme from "@/data/tables.json";
import { correctEvent } from "@/lib/db/corrections";
import { clock, money } from "@/lib/format";
import {
  KIND_TITLE,
  draftError,
  draftOf,
  needsTable,
  rowsFromDraft,
  splitOffice,
  withReplacement,
  type Draft,
  type OfficeEntry,
  type ShiftEvent,
} from "@/lib/office";
import { netAmount } from "@/lib/split";
import type { Employee, Kind, Scheme } from "@/lib/types";
import Compare from "./Compare";

/**
 * Правка одной записи смены.
 *
 * Правится событие, а не строка: поделённые между официантами чаевые лежат
 * в базе несколькими строками, но гость оставил их один раз. Меняешь сумму
 * или список официантов — приложение делит заново, и доли всегда сходятся
 * с тем, что оставил гость.
 *
 * Сохранение показывается только после предпросмотра «было / стало»
 * по всей смене: правка одной записи меняет всю смену, и увидеть это надо
 * до, а не после.
 */

const HALLS = (scheme as Scheme).halls;
const KINDS: Kind[] = ["cash", "terminal", "qr", "service", "staff"];

type Props = {
  day: string;
  event: ShiftEvent;
  live: OfficeEntry[];
  crew: Employee[];
  people: Employee[];
  onClose: () => void;
};

export default function EventEditor({ day, event, live, crew, people, onClose }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => draftOf(event));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const before = useMemo(() => splitOffice(live, crew, day), [live, crew, day]);

  const fresh = useMemo(
    () =>
      rowsFromDraft(draft, {
        businessDay: day,
        createdAt: event.createdAt,
        operatorId: null,
        operatorName: event.operatorName,
        managerId: 0,
        corrects: event.key,
        note: null,
        nameOf: (id) => nameOf(id, people, event),
      }),
    [draft, day, event, people],
  );

  const after = useMemo(
    () => splitOffice(withReplacement(live, event.key, fresh), crew, day),
    [live, event.key, fresh, crew, day],
  );

  const crewIds = new Set(crew.map((p) => p.id));
  // Официант не в составе смены — деньги за ним просто не попадут в раскладку:
  // она перебирает состав, а не записи. Молча потерять их нельзя.
  const outside = draft.waiterIds.filter((id) => !crewIds.has(id));
  const problem =
    draftError(draft) ??
    (outside.length > 0
      ? `В составе смены нет: ${nameOf(outside[0], people, event)}. Сначала поправьте состав — иначе эти деньги не попадут в раскладку`
      : null);

  const hall = HALLS.find((h) => h.id === draft.hallId) ?? null;
  const net = netAmount(draft.gross || 0, draft.kind);

  function setKind(kind: Kind) {
    setDraft((d) => ({
      ...d,
      kind,
      // У QR и питания стола нет: гость платит по чеку, а не за столом.
      ...(needsTable(kind)
        ? {}
        : { hallId: null, hallTitle: null, tableId: null, tableTitle: null }),
      // Питание — личный вычет, делить его между людьми нельзя.
      ...(kind === "staff" && d.waiterIds.length > 1
        ? { waiterIds: d.waiterIds.slice(0, 1) }
        : {}),
    }));
  }

  function toggleWaiter(id: number) {
    setDraft((d) => ({
      ...d,
      waiterIds: d.waiterIds.includes(id)
        ? d.waiterIds.filter((x) => x !== id)
        : d.kind === "staff"
          ? [id]
          : [...d.waiterIds, id],
    }));
  }

  async function save() {
    setBusy(true);
    setFailed(null);
    const answer = await correctEvent({ businessDay: day, key: event.key, draft, note });
    setBusy(false);
    if ("error" in answer) {
      setFailed(answer.error);
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <Overlay onClose={onClose}>
      <div className="border-b border-line px-5 py-3">
        <div className="text-base">Поправить запись</div>
        <div className="text-sm text-fg-muted">
          {clock(event.createdAt)} · внесла {event.operatorName} ·{" "}
          {KIND_TITLE[event.kind]} {money(event.gross)}
          {event.waiters.length > 1 &&
            ` · поделено между ${event.waiters.length} официантами`}
        </div>
      </div>

      <div className="flex flex-col gap-5 px-5 py-4">
        <Field label="Вид денег">
          <div className="flex flex-wrap gap-2">
            {KINDS.map((k) => (
              <Chip key={k} on={draft.kind === k} onClick={() => setKind(k)}>
                {KIND_TITLE[k]}
              </Chip>
            ))}
          </div>
          {draft.kind === "staff" && (
            <p className="mt-1.5 text-xs text-fg-muted">
              Питание — не доход, а вычет: сколько человек проел за смену.
            </p>
          )}
        </Field>

        <Field label={draft.kind === "staff" ? "Сколько проел" : "Сколько оставил гость"}>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={draft.gross || ""}
            onChange={(e) =>
              setDraft((d) => ({ ...d, gross: Number(e.target.value) }))
            }
            className="w-48 rounded-xl border border-line bg-ink px-3 py-2 tabular-nums"
          />
          {/* Комиссия названа прямо: иначе до официанта дойдёт меньше, чем
              ввели, и непонятно, куда делись деньги. */}
          {net !== draft.gross && draft.gross > 0 && (
            <p className="mt-1.5 text-xs text-fg-muted">
              до официанта дойдёт {money(net)} — Сбер удержит{" "}
              {money(draft.gross - net)}
            </p>
          )}
        </Field>

        {needsTable(draft.kind) && (
          <Field label="Стол">
            <div className="flex flex-wrap gap-2">
              <select
                value={draft.hallId ?? ""}
                onChange={(e) => {
                  const h = HALLS.find((x) => x.id === Number(e.target.value));
                  setDraft((d) => ({
                    ...d,
                    hallId: h?.id ?? null,
                    hallTitle: h?.title ?? null,
                    tableId: null,
                    tableTitle: null,
                  }));
                }}
                className="rounded-xl border border-line bg-ink px-3 py-2"
              >
                <option value="">— зал —</option>
                {HALLS.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.title}
                  </option>
                ))}
              </select>

              <select
                value={draft.tableId ?? ""}
                disabled={!hall}
                onChange={(e) => {
                  const t = hall?.tables.find((x) => x.id === Number(e.target.value));
                  setDraft((d) => ({
                    ...d,
                    tableId: t?.id ?? null,
                    tableTitle: t?.title ?? null,
                  }));
                }}
                className="rounded-xl border border-line bg-ink px-3 py-2 disabled:opacity-40"
              >
                <option value="">— стол —</option>
                {hall?.tables.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </div>
          </Field>
        )}

        <Field
          label={
            draft.kind === "staff"
              ? "Кому вычесть"
              : draft.waiterIds.length > 1
                ? `Кому — поровну на ${draft.waiterIds.length}`
                : "Кому"
          }
        >
          <div className="flex flex-wrap gap-2">
            {crew.map((p) => (
              <Chip
                key={p.id}
                on={draft.waiterIds.includes(p.id)}
                onClick={() => toggleWaiter(p.id)}
              >
                {p.short}
              </Chip>
            ))}
            {/* Официант не из состава смены: показываем, но помечаем — иначе
                непонятно, почему кнопка «сохранить» не работает. */}
            {outside.map((id) => (
              <Chip key={id} on alert onClick={() => toggleWaiter(id)}>
                {nameOf(id, people, event)}
              </Chip>
            ))}
          </div>
          <select
            value=""
            onChange={(e) => e.target.value && toggleWaiter(Number(e.target.value))}
            className="mt-2 rounded-xl border border-line bg-ink px-3 py-2 text-sm"
          >
            <option value="">+ кто-то ещё</option>
            {people
              .filter((p) => !crewIds.has(p.id) && !draft.waiterIds.includes(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </Field>

        <Field label="Зачем поправили — по желанию">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="например: перепутали официанта"
            className="w-full rounded-xl border border-line bg-ink px-3 py-2"
          />
        </Field>

        <Compare before={before} after={after} />

        {problem && <p className="text-sm text-alert">{problem}</p>}
        {failed && <p className="text-sm text-alert">{failed}</p>}
      </div>

      <div className="sticky bottom-0 flex gap-3 border-t border-line bg-surface px-5 py-3">
        <button
          disabled={busy || problem !== null}
          onClick={save}
          className="rounded-xl bg-sand px-5 py-2.5 font-medium text-ink disabled:bg-line disabled:text-fg-muted"
        >
          {busy ? "Сохраняю…" : "Сохранить правку"}
        </button>
        <button onClick={onClose} className="px-3 text-fg-muted underline">
          не менять
        </button>
      </div>
    </Overlay>
  );
}

function nameOf(id: number, people: Employee[], event: ShiftEvent): string {
  return (
    people.find((p) => p.id === id)?.short ??
    event.waiters.find((w) => w.id === id)?.name ??
    `№${id}`
  );
}

export function Overlay({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-10 overflow-y-auto bg-ink/80 p-4 sm:p-8"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="mx-auto max-w-2xl rounded-2xl border border-line bg-surface">
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-sm text-fg-muted">{label}</div>
      {children}
    </div>
  );
}

export function Chip({
  on,
  alert,
  onClick,
  children,
}: {
  on: boolean;
  alert?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border px-3 py-1.5 text-sm ${
        alert
          ? "border-alert text-alert"
          : on
            ? "border-sand bg-sand/15 text-sand"
            : "border-line text-fg-muted hover:border-fg-muted"
      }`}
    >
      {children}
    </button>
  );
}
