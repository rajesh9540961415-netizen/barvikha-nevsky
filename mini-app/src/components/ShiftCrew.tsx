"use client";

import { useState } from "react";
import { formatBusinessDay } from "@/lib/businessDay";
import type { Shift } from "@/lib/crew";
import {
  addManualPerson,
  getQuickRestoPeople,
  removeManualPerson,
} from "@/lib/people";
import type { Employee } from "@/lib/types";

const FROM_QUICK_RESTO = getQuickRestoPeople();

type Props = {
  day: string;
  initial: Shift;
  manual: Employee[];
  onManualChange: (people: Employee[]) => void;
  /** Ждёт ответа хранилища: состав смены нужен и сменщику, а не только тут. */
  onDone: (shift: Shift) => Promise<void>;
  onCancel?: () => void;
};

export default function ShiftCrew({
  day,
  initial,
  manual,
  onManualChange,
  onDone,
  onCancel,
}: Props) {
  const [shift, setShift] = useState<Shift>(initial);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const everyone = [...FROM_QUICK_RESTO, ...manual];
  const ready = shift.crew.length > 0 && shift.operator !== null && !busy;

  function toggleCrew(id: number) {
    setShift((s) => ({
      ...s,
      crew: s.crew.includes(id)
        ? s.crew.filter((x) => x !== id)
        : [...s.crew, id],
    }));
  }

  function pick(role: "operator" | "admin" | "cashier", id: number) {
    setShift((s) => ({ ...s, [role]: s[role] === id ? null : id }));
  }

  async function add() {
    const before = manual.map((p) => p.id);
    const next = await addManualPerson(name);
    onManualChange(next);
    const fresh = next.find((p) => !before.includes(p.id));
    if (fresh) setShift((s) => ({ ...s, crew: [...s.crew, fresh.id] }));
    setName("");
    setAdding(false);
  }

  async function drop(person: Employee) {
    onManualChange(await removeManualPerson(person.id));
    setShift((s) => ({
      crew: s.crew.filter((x) => x !== person.id),
      operator: s.operator === person.id ? null : s.operator,
      admin: s.admin === person.id ? null : s.admin,
      cashier: s.cashier === person.id ? null : s.cashier,
    }));
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-3 px-4 pb-3 pt-4">
        {onCancel && (
          <button
            onClick={onCancel}
            aria-label="Назад"
            className="-ml-1 rounded-lg px-2 py-1 text-2xl leading-none text-fg-muted active:bg-surface"
          >
            ‹
          </button>
        )}
        <div>
          <h1 className="text-lg">Кто на смене</h1>
          <p className="text-xs text-fg-muted">
            смена · {formatBusinessDay(day)} · отметьте официантов
          </p>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 px-4">
        {FROM_QUICK_RESTO.map((p) => (
          <PersonButton
            key={p.id}
            person={p}
            on={shift.crew.includes(p.id)}
            onToggle={() => toggleCrew(p.id)}
          />
        ))}
      </div>

      {manual.length > 0 && (
        <>
          <div className="px-4 pb-1.5 pt-4 text-xs text-fg-muted">
            дописаны вручную
          </div>
          <div className="grid grid-cols-2 gap-2 px-4">
            {manual.map((p) => (
              <PersonButton
                key={p.id}
                person={p}
                on={shift.crew.includes(p.id)}
                onToggle={() => toggleCrew(p.id)}
                onRemove={() => drop(p)}
              />
            ))}
          </div>
        </>
      )}

      <div className="px-4 pt-3">
        {adding ? (
          <div className="flex gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="Максим, стажёр"
              className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-3 text-sm outline-none placeholder:text-fg-muted focus:border-sand"
            />
            <button
              onClick={add}
              disabled={!name.trim()}
              className="rounded-xl bg-sand px-4 text-sm text-ink disabled:bg-surface disabled:text-fg-muted"
            >
              Добавить
            </button>
            <button
              onClick={() => {
                setAdding(false);
                setName("");
              }}
              aria-label="Отмена"
              className="rounded-xl border border-line px-3 text-fg-muted"
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="w-full rounded-xl border border-dashed border-line py-3 text-sm text-fg-muted active:bg-surface"
          >
            + Кого нет в списке
          </button>
        )}
      </div>

      <RolePicker
        title="кто вносит записи"
        people={everyone}
        selected={shift.operator}
        onPick={(id) => pick("operator", id)}
      />
      <RolePicker
        title="администратор смены — ему уходят 20 %"
        people={everyone}
        selected={shift.admin}
        onPick={(id) => pick("admin", id)}
      />
      <RolePicker
        title="кассир смены — ему уходит доля от 750 ₽"
        people={everyone}
        selected={shift.cashier}
        onPick={(id) => pick("cashier", id)}
      />

      <div className="mt-auto border-t border-line px-4 py-3">
        <button
          disabled={!ready}
          onClick={async () => {
            setBusy(true);
            try {
              await onDone(shift);
            } finally {
              setBusy(false);
            }
          }}
          className="w-full rounded-xl bg-sand py-4 text-lg text-ink disabled:bg-surface disabled:text-fg-muted"
        >
          {busy
            ? "Сохраняю…"
            : shift.crew.length === 0
              ? "Отметьте официантов"
              : shift.operator === null
                ? "Укажите, кто вносит записи"
                : `Начать смену · ${shift.crew.length}`}
        </button>
        {ready && (!shift.admin || !shift.cashier) && (
          <p className="pt-2 text-center text-xs text-fg-muted">
            Администратор и кассир не обязательны, но без них отчёт придётся
            дозаполнять руками
          </p>
        )}
      </div>
    </div>
  );
}

function RolePicker({
  title,
  people,
  selected,
  onPick,
}: {
  title: string;
  people: Employee[];
  selected: number | null;
  onPick: (id: number) => void;
}) {
  return (
    <>
      <div className="px-4 pb-1.5 pt-5 text-xs text-fg-muted">{title}</div>
      <div className="flex flex-wrap gap-2 px-4">
        {people.map((p) => {
          const on = p.id === selected;
          return (
            <button
              key={p.id}
              onClick={() => onPick(p.id)}
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
    </>
  );
}

function PersonButton({
  person,
  on,
  onToggle,
  onRemove,
}: {
  person: Employee;
  on: boolean;
  onToggle: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className={`w-full rounded-xl border px-3 py-3.5 text-left text-sm ${
          on
            ? "border-sand bg-sand/10 text-fg"
            : "border-line bg-surface text-fg-muted active:bg-surface-2"
        } ${onRemove ? "pr-9" : ""}`}
      >
        {person.short}
      </button>
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label={`Убрать ${person.short}`}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-sm text-fg-muted active:bg-surface-2"
        >
          ✕
        </button>
      )}
    </div>
  );
}
