"use client";

import { useEffect, useMemo, useState } from "react";
import AmountPad from "@/components/AmountPad";
import ShiftCrew from "@/components/ShiftCrew";
import ShiftSummary from "@/components/ShiftSummary";
import TablePicker from "@/components/TablePicker";
import scheme from "@/data/tables.json";
import { businessDayKey, formatBusinessDay, formatMoney } from "@/lib/businessDay";
import type { Shift } from "@/lib/crew";
import { getLastShift, getShift, isReady, setShift } from "@/lib/crew";
import { getManualPeople, getQuickRestoPeople } from "@/lib/people";
import { listByDay, remove, save } from "@/lib/storage";
import type { Employee, Entry, Hall, Kind, Scheme, Table } from "@/lib/types";

const { halls } = scheme as Scheme;

const KIND_LABEL: Record<Kind, string> = {
  cash: "наличные",
  terminal: "терминал",
  service: "сервисный сбор",
};

type Picked = { hall: Hall; table: Table };

export default function TipsScreen() {
  // Экран рисуется только в браузере (см. page.tsx), поэтому день, состав
  // смены и записи можно читать сразу при первом рендере.
  const [day] = useState(businessDayKey);
  const [shift, setShiftState] = useState<Shift>(() => getShift(day));
  const [manual, setManual] = useState<Employee[]>(getManualPeople);
  const [entries, setEntries] = useState<Entry[]>(() => listByDay(day));
  const [hallId, setHallId] = useState(halls[0].id);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [editingCrew, setEditingCrew] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const everyone = useMemo(
    () => [...getQuickRestoPeople(), ...manual],
    [manual],
  );
  const crew = useMemo(
    () => everyone.filter((p) => shift.crew.includes(p.id)),
    [everyone, shift.crew],
  );
  const operator = useMemo(
    () => everyone.find((p) => p.id === shift.operator) ?? null,
    [everyone, shift.operator],
  );
  const total = useMemo(
    () => entries.reduce((sum, e) => sum + e.amount, 0),
    [entries],
  );
  const usedTableIds = useMemo(
    () => new Set(entries.map((e) => e.tableId)),
    [entries],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  function saveShift(next: Shift) {
    setShift(day, next);
    setShiftState(next);
    setEditingCrew(false);
  }

  function addEntry(amount: number, waiter: Employee, kind: Kind) {
    if (!picked || !operator) return;
    const entry: Entry = {
      id: crypto.randomUUID(),
      hallId: picked.hall.id,
      hallTitle: picked.hall.title,
      tableId: picked.table.id,
      tableTitle: picked.table.title,
      waiterId: waiter.id,
      waiterName: waiter.name,
      amount,
      kind,
      operatorId: operator.id,
      operatorName: operator.name,
      createdAt: new Date().toISOString(),
      businessDay: day,
    };
    save(entry);
    setEntries(listByDay(day));
    setToast(
      `${picked.table.title} · ${formatMoney(amount)} · ${waiter.short} · ${KIND_LABEL[kind]}`,
    );
    setPicked(null);
  }

  function undoLast() {
    const last = entries[0];
    if (!last) return;
    remove(last.id);
    setEntries(listByDay(day));
    setToast(`Отменено: ${last.tableTitle} · ${formatMoney(last.amount)}`);
  }

  // Смену надо собрать до первого ввода: без официантов запись некому приписать,
  // а без ответственного непонятно, кто её внёс.
  if (editingCrew || !isReady(shift) || !operator) {
    return (
      <ShiftCrew
        day={day}
        initial={isReady(shift) ? shift : getLastShift()}
        manual={manual}
        onManualChange={setManual}
        onDone={saveShift}
        onCancel={
          isReady(shift) && operator ? () => setEditingCrew(false) : undefined
        }
      />
    );
  }

  if (showSummary) {
    return (
      <ShiftSummary
        day={day}
        entries={entries}
        crew={crew}
        shift={shift}
        everyone={everyone}
        onClose={() => setShowSummary(false)}
      />
    );
  }

  if (picked) {
    // Кто уже обслуживал этот стол сегодня — его и предлагаем.
    const previous = entries.find((e) => e.tableId === picked.table.id);
    return (
      <AmountPad
        hall={picked.hall}
        table={picked.table}
        crew={crew}
        suggestedWaiterId={previous?.waiterId ?? null}
        onCancel={() => setPicked(null)}
        onConfirm={addEntry}
      />
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-start justify-between px-4 pb-3 pt-4">
        <div>
          <h1 className="text-lg">Чаевые</h1>
          <p className="text-xs text-fg-muted">
            смена · {formatBusinessDay(day)} · вносит {operator.short}
          </p>
        </div>
        <button
          onClick={() => setEditingCrew(true)}
          className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted active:bg-surface"
        >
          смена · {crew.length}
        </button>
      </header>

      <TablePicker
        halls={halls}
        activeHallId={hallId}
        onHallChange={setHallId}
        onPick={(hall, table) => setPicked({ hall, table })}
        usedTableIds={usedTableIds}
      />

      <div className="mt-auto border-t border-line px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => setShowSummary(true)}
            className="-m-2 flex-1 rounded-lg p-2 text-left active:bg-surface"
          >
            <div className="text-lg tabular-nums">{formatMoney(total)}</div>
            <div className="text-xs text-fg-muted">
              за смену · {entries.length}{" "}
              {plural(entries.length, "запись", "записи", "записей")} · итоги ›
            </div>
          </button>
          {entries.length > 0 && (
            <button
              onClick={undoLast}
              className="shrink-0 rounded-lg border border-line px-3 py-2 text-sm text-fg-muted active:bg-surface"
            >
              Отменить
            </button>
          )}
        </div>
      </div>

      {toast && (
        <div className="pointer-events-none fixed inset-x-4 bottom-24 rounded-xl bg-surface-2 px-4 py-3 text-center text-sm">
          {toast}
        </div>
      )}
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
