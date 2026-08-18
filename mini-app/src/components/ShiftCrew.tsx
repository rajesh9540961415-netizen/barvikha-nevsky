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
  /**
   * Какой раздел раскрыт. Одновременно только один.
   *
   * Людей в кассе стало 23, а списков на экране шесть — официанты, три роли,
   * хостес и кальянный бар. Развёрнутые разом, они дают экран в несколько
   * телефонов длиной, и собрать смену становится работой с прокруткой,
   * а не с людьми. Поэтому разделы свёрнуты, и в строке каждого видно,
   * кто уже выбран, — раскрывать нужно только то, что меняешь.
   *
   * При входе раскрыты официанты и только если смену ещё не собрали:
   * вечер начинается с них. Пришли поправить готовую смену — всё сложено.
   */
  const [open, setOpen] = useState<string | null>(
    initial.crew.length === 0 ? "crew" : null,
  );
  /**
   * В каком разделе сейчас вписывают человека руками.
   *
   * Раньше вписать можно было только в официантах, и человек попадал в состав
   * зала — даже если выходил администратором. Из-за этого Елизавету
   * Недорезову, которой нет в кассе, приходилось заводить официантом, а потом
   * убирать; вместе с ней из выгрузок пропадало её имя, и деньги становились
   * безымянными. Теперь вписать можно в любой роли, и в зал человек при этом
   * не попадает.
   */
  const [addingIn, setAddingIn] = useState<string | null>(null);
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

  function pick(role: "operator" | "admin" | "admin2" | "cashier", id: number) {
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

  async function add(section: string) {
    const before = manual.map((p) => p.id);
    const next = await addManualPerson(name);
    onManualChange(next);
    const fresh = next.find((p) => !before.includes(p.id));
    if (fresh) {
      // Куда именно вписали, туда человек и попадает. В зал — только если
      // вписывали в зал: у официантов состав влияет на долю кассира.
      if (section === "crew") toggleCrew(fresh.id);
      else if (section === "hostess") toggleHostess(fresh.id);
      else if (
        section === "operator" ||
        section === "admin" ||
        section === "admin2" ||
        section === "cashier"
      ) {
        pick(section, fresh.id);
      }
    }
    setName("");
    setAddingIn(null);
  }

  async function drop(person: Employee) {
    onManualChange(await removeManualPerson(person.id));
    setShift((s) => ({
      ...s,
      crew: s.crew.filter((x) => x !== person.id),
      hostess: s.hostess.filter((x) => x !== person.id),
      operator: s.operator === person.id ? null : s.operator,
      admin: s.admin === person.id ? null : s.admin,
      admin2: s.admin2 === person.id ? null : s.admin2,
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
            смена · {formatBusinessDay(day)} · нажмите строку, чтобы раскрыть
          </p>
        </div>
      </header>

      <Section
        title="Официанты"
        summary={
          shift.crew.length === 0
            ? "никого"
            : `${shift.crew.length} ${plural(shift.crew.length, "человек", "человека", "человек")}`
        }
        open={open === "crew"}
        onToggle={() => setOpen(open === "crew" ? null : "crew")}
      >
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

        <AddPerson
          section="crew"
          openIn={addingIn}
          name={name}
          onName={setName}
          onOpen={setAddingIn}
          onAdd={add}
        />
      </Section>

      <Section
        title="Кто вносит записи"
        summary={nameOf(everyone, shift.operator) ?? "не выбран"}
        open={open === "operator"}
        onToggle={() => setOpen(open === "operator" ? null : "operator")}
      >
        <RolePicker
          people={everyone}
          selected={shift.operator}
          onPick={(id) => pick("operator", id)}
        />
        <AddPerson
          section="operator"
          openIn={addingIn}
          name={name}
          onName={setName}
          onOpen={setAddingIn}
          onAdd={add}
        />
      </Section>

      <Section
        title="Администратор смены"
        hint="ему уходят 20 % с заработка официантов"
        summary={nameOf(everyone, shift.admin) ?? "не выбран"}
        open={open === "admin"}
        onToggle={() => setOpen(open === "admin" ? null : "admin")}
      >
        <RolePicker
          people={everyone}
          selected={shift.admin}
          onPick={(id) => pick("admin", id)}
        />
        <AddPerson
          section="admin"
          openIn={addingIn}
          name={name}
          onName={setName}
          onOpen={setAddingIn}
          onAdd={add}
        />
      </Section>

      {/* Второй администратор — только когда смену делят надвое. Строка
          стоит всегда, но обычный вечер её не замечает: «нет» и «нет».
          Доля делится пополам между двумя, кассир при этом всегда один. */}
      <Section
        title="Второй администратор"
        hint={
          shift.admin2 === null
            ? "если смену делили надвое"
            : "доля администратора делится пополам"
        }
        summary={nameOf(everyone, shift.admin2) ?? "нет"}
        open={open === "admin2"}
        onToggle={() => setOpen(open === "admin2" ? null : "admin2")}
      >
        <RolePicker
          people={everyone}
          selected={shift.admin2}
          onPick={(id) => pick("admin2", id)}
        />
        <AddPerson
          section="admin2"
          openIn={addingIn}
          name={name}
          onName={setName}
          onOpen={setAddingIn}
          onAdd={add}
        />
      </Section>

      <Section
        title="Кассир смены"
        hint={`ему уходит доля от ${formatMoney(cashierPool(day))}`}
        summary={nameOf(everyone, shift.cashier) ?? "не выбран"}
        open={open === "cashier"}
        onToggle={() => setOpen(open === "cashier" ? null : "cashier")}
      >
        <RolePicker
          people={everyone}
          selected={shift.cashier}
          onPick={(id) => pick("cashier", id)}
        />
        <AddPerson
          section="cashier"
          openIn={addingIn}
          name={name}
          onName={setName}
          onOpen={setAddingIn}
          onAdd={add}
        />
      </Section>

      {/* Хостес и кальянный бар — ниже ролей намеренно: вечер начинается
          с зала. Их деньги не делятся ни с кем, и сказано об этом прямо
          в строке, чтобы администратор не искал объяснений в отчёте. */}
      <Section
        title="Хостес"
        hint="её чаевые не делятся ни с кем"
        summary={listOf(everyone, shift.hostess)}
        open={open === "hostess"}
        onToggle={() => setOpen(open === "hostess" ? null : "hostess")}
      >
        <MultiPicker
          people={everyone}
          selected={shift.hostess}
          onToggle={toggleHostess}
        />
        <AddPerson
          section="hostess"
          openIn={addingIn}
          name={name}
          onName={setName}
          onOpen={setAddingIn}
          onAdd={add}
        />
      </Section>

      <Section
        title="Кальянный бар"
        hint="касса ИП Шалаевой, чаевые не делятся"
        summary={listOf(FROM_SHALAEVA, shift.hookah)}
        open={open === "hookah"}
        onToggle={() => setOpen(open === "hookah" ? null : "hookah")}
      >
        <MultiPicker
          people={FROM_SHALAEVA}
          selected={shift.hookah}
          onToggle={toggleHookah}
        />
      </Section>

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

/**
 * «Кого нет в списке» — вписать человека прямо здесь.
 *
 * Стоит в каждом разделе, а не только у официантов: администратора или
 * кассира, которых нет в кассе Quick Resto, раньше приходилось заводить
 * официантом. Человек попадал в зал, менял долю кассира и путал отчёт,
 * а убрать его оттуда значило потерять его имя в выгрузках.
 */
function AddPerson({
  section,
  openIn,
  name,
  onName,
  onOpen,
  onAdd,
}: {
  section: string;
  openIn: string | null;
  name: string;
  onName: (v: string) => void;
  onOpen: (v: string | null) => void;
  onAdd: (section: string) => void;
}) {
  const open = openIn === section;
  return (
    <div className="px-4 pt-3">
      {open ? (
        <div className="flex gap-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => onName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onAdd(section)}
            placeholder="Максим, стажёр"
            className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-3 text-sm outline-none placeholder:text-fg-muted focus:border-sand"
          />
          <button
            onClick={() => onAdd(section)}
            disabled={!name.trim()}
            className="rounded-xl bg-sand px-4 text-sm text-ink disabled:bg-surface disabled:text-fg-muted"
          >
            Добавить
          </button>
          <button
            onClick={() => {
              onOpen(null);
              onName("");
            }}
            aria-label="Отмена"
            className="rounded-xl border border-line px-3 text-fg-muted"
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          onClick={() => onOpen(section)}
          className="w-full rounded-xl border border-dashed border-line py-3 text-sm text-fg-muted active:bg-surface"
        >
          + Кого нет в списке
        </button>
      )}
    </div>
  );
}

/**
 * Сворачивающийся раздел.
 *
 * Раскрыт всегда один: на телефоне шесть развёрнутых списков по 23 человека
 * дают экран длиной в несколько экранов, и собрать смену становится работой
 * с прокруткой. В свёрнутом виде строка сама отвечает на главный вопрос —
 * кто выбран, — и открывать её нужно, только чтобы поменять.
 */
function Section({
  title,
  hint,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  hint?: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-line">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left active:bg-surface"
      >
        <span className="min-w-0">
          <span className="block text-sm text-fg">{title}</span>
          {hint && <span className="block text-xs text-fg-muted">{hint}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="max-w-36 truncate text-xs text-fg-muted">
            {summary}
          </span>
          <span
            className={`text-lg leading-none text-fg-muted ${open ? "rotate-90" : ""}`}
          >
            ›
          </span>
        </span>
      </button>
      {open && <div className="pb-4">{children}</div>}
    </div>
  );
}

/** Имя выбранного — для свёрнутой строки. */
function nameOf(people: Employee[], id: number | null): string | null {
  if (id === null) return null;
  return people.find((p) => p.id === id)?.short ?? `№${id}`;
}

/** Кого выбрали, через запятую. Пусто — так и говорим. */
function listOf(people: Employee[], ids: number[]): string {
  if (ids.length === 0) return "никого";
  return ids
    .map((id) => people.find((p) => p.id === id)?.short ?? `№${id}`)
    .join(", ");
}

function RolePicker({
  people,
  selected,
  onPick,
}: {
  people: Employee[];
  selected: number | null;
  onPick: (id: number) => void;
}) {
  return (
    <>
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
  people,
  selected,
  onToggle,
}: {
  people: Employee[];
  selected: number[];
  onToggle: (id: number) => void;
}) {
  return (
    <>
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

/** «4 человека», «21 человек» — в свёрнутой строке официантов. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
