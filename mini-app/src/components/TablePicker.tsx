"use client";

import type { Hall, Table } from "@/lib/types";

type Props = {
  halls: Hall[];
  activeHallId: number;
  onHallChange: (hallId: number) => void;
  onPick: (hall: Hall, table: Table) => void;
  /** Столы, по которым за смену уже вносили чаевые. */
  usedTableIds: Set<number>;
};

export default function TablePicker({
  halls,
  activeHallId,
  onHallChange,
  onPick,
  usedTableIds,
}: Props) {
  const hall = halls.find((h) => h.id === activeHallId) ?? halls[0];

  return (
    <>
      <div className="flex gap-2 overflow-x-auto px-4 pb-3">
        {halls.map((h) => {
          const active = h.id === hall.id;
          return (
            <button
              key={h.id}
              onClick={() => onHallChange(h.id)}
              className={`shrink-0 rounded-lg px-3.5 py-2 text-sm transition-colors ${
                active
                  ? "bg-sand text-ink"
                  : "bg-surface text-fg-muted active:bg-surface-2"
              }`}
            >
              {h.title.replace(" зал", "")}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-4 gap-2 px-4 pb-4">
        {hall.tables.map((t) => (
          <button
            key={t.id}
            onClick={() => onPick(hall, t)}
            className="relative rounded-xl border border-line bg-surface py-4 text-base tabular-nums active:bg-surface-2"
          >
            {t.title}
            {usedTableIds.has(t.id) && (
              <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-sand" />
            )}
          </button>
        ))}
      </div>
    </>
  );
}
