"use client";

import { useMemo } from "react";
import type { Hall, Table } from "@/lib/types";

/**
 * Столы по возрастанию номера.
 *
 * Quick Resto отдаёт их в порядке расстановки по залу, и на экране это
 * выглядит случайной россыпью: 6, Бар 1, Бар 2, 9, 4, 1… Искать нужный
 * стол приходится глазами по всей сетке.
 *
 * Обычное сравнение строк не подходит: «Б11» встало бы раньше «Б2»,
 * потому что посимвольно «1» меньше «2». Поэтому разбираем название
 * на буквенную часть и число и сравниваем их порознь.
 *
 * Столы без числа вовсе (BOSS, STAFF) уходят в конец: у них нет места
 * в нумерации, а мешать они не должны.
 */
function parseTitle(title: string): { prefix: string; number: number } {
  const parts = title.match(/^(\D*?)\s*(\d+)\s*$/);
  return parts
    ? { prefix: parts[1], number: Number(parts[2]) }
    : { prefix: title, number: Number.POSITIVE_INFINITY };
}

function byNumber(a: Table, b: Table): number {
  const left = parseTitle(a.title);
  const right = parseTitle(b.title);

  // Чистые номера идут первыми: в Малом зале это основная нумерация,
  // а «Бар 1» и BOSS — приставные места.
  const named = (p: { prefix: string; number: number }) =>
    p.prefix === "" ? 0 : Number.isFinite(p.number) ? 1 : 2;
  if (named(left) !== named(right)) return named(left) - named(right);

  if (left.prefix !== right.prefix) {
    return left.prefix.localeCompare(right.prefix, "ru");
  }
  return left.number - right.number;
}

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
  const tables = useMemo(() => [...hall.tables].sort(byNumber), [hall]);

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
        {tables.map((t) => (
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
