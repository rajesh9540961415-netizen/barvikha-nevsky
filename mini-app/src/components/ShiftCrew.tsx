"use client";

import { useState } from "react";
import { formatBusinessDay, formatMoney } from "@/lib/businessDay";
import { cashierPool } from "@/lib/split";
import type { Shift } from "@/lib/crew";
import { HOOKAH_POT_ID } from "@/lib/split";
import {
  addManualPerson,
  getHookahPeople,
  getQuickRestoPeople,
  removeManualPerson,
} from "@/lib/people";
import type { Employee } from "@/lib/types";
import { BUILD } from "@/lib/version";

const FROM_QUICK_RESTO = getQuickRestoPeople();

// Кальянщики из кассы ИП Шалаевой. Общий котёл бара («Весь бар») идёт
// первым в getHookahPeople, но в составе смены ему не место: это получатель
// денег, а не человек, который вышел работать.
const FROM_SHALAEVA = getHookahPeople().filter((p) => p.id !== HOOKAH_POT_ID);

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
      hostess: s.hostess.filter((x) => x !== id),
      crew: s.crew.includes(id)
        ? s.crew.filter((x) => x !== id)
        : [...s.crew, id],
    }));
  }

  function pick(role: "operator" | "admin" | "cashier", id: number) {
    setShift((s) => ({ ...s, [role]: s[role] === id ? null : id }));
  }

  /**
   * Хостес этого вечера.
   *
   * Отметив человека хостес, убираем его из официантов — и наоборот. Быть
   * и тем, и другим одновременно нельзя не из строгости: деньги хостес
   * не делятся ни с кем, а зальные делятся, и человек в обоих списках
   * попал бы в знаменатель доли кассира, оставаясь при этом вне котла.
   * Такую ошибку на экране не видно — видно только в деньгах, через месяц.
   */
  function toggleHostess(id: number) {
    setShift((s) => ({
      ...s,
      crew: s.crew.filter((x) => x !== id),
      hostess: s.hostess.includes(id)
        ? s.hostess.filter((x) => x !== id)
        : [...s.hostess, id],
    }));
  }

  function toggleHookah(id: number) {
    setShift((s) => ({
      ...s,
      hookah: s.hookah.includes(id)
        ? s.hookah.filter((x) => x !== id)
        : [...s.hookah, id],
    }));
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
      ...s,
      crew: s.crew.filter((x) => x !== person.id),
      hostess: s.hostess.filter((x) => x !== person.id),
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
        title={`кассир смены — ему уходит доля от ${formatMoney(cashierPool(day))}`}
        people={everyone}
        selected={shift.cashier}
        onPick={(id) => pick("cashier", id)}
      />

      {/* Хостес и кальянный бар. Стоят ниже официантов и ролей намеренно:
          вечер начинается с зала, а эти два списка чаще всего вчерашние.
          Их деньги не делятся ни с кем — об этом сказано прямо в подписи,
          чтобы администратор не искал объяснений в отчёте. */}
      <MultiPicker
        title="хостес — её чаевые не делятся ни с кем"
        people={everyone}
        selected={shift.hostess}
        onToggle={toggleHostess}
      />
      <MultiPicker
        title="кальянный бар — из кассы ИП Шалаевой, чаевые не делятся"
        people={FROM_SHALAEVA}
        selected={shift.hookah}
        onToggle={toggleHookah}
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
        {/* Отметка сборки на первом же экране: чтобы проверить, доехала ли
            новая версия, не нужно ни собирать смену, ни куда-то заходить —
            достаточно открыть приложение. */}
        <p className="pt-3 text-center text-xs text-fg-muted">сборка {BUILD}</p>
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

/**
 * Выбор нескольких человек: хостес и кальянщики.
 *
 * Отдельно от RolePicker, где выбирается ровно один: там нажатие снимает
 * прежний выбор, здесь — добавляет к списку. Один компонент на оба случая
 * означал бы флаг в каждом вызове и ошибку в том, который писали позже.
 */
function MultiPicker({
  title,
  people,
  selected,
  onToggle,
}: {
  title: string;
  people: Employee[];
  selected: number[];
  onToggle: (id: number) => void;
}) {
  return (
    <>
      <div className="px-4 pb-1.5 pt-5 text-xs text-fg-muted">{title}</div>
      <div className="flex flex-wrap gap-2 px-4">
        {people.map((p) => {
          const on = selected.includes(p.id);
          return (
            <button
              key={p.id}
              onClick={() => onToggle(p.id)}
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
