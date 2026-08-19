"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { twinHint } from "@/lib/format";
import type { Employee } from "@/lib/types";

/**
 * Кого смотрим и за какой период.
 *
 * Выбор живёт в адресе страницы, а не в памяти экрана: тогда ссылку на
 * «Яна Миллес за прошлый месяц» можно послать другому управляющему,
 * и он увидит ровно то же самое.
 */

export const PERIODS: { key: string; title: string }[] = [
  { key: "30", title: "последние 30 дней" },
  { key: "90", title: "последние 90 дней" },
  { key: "month", title: "текущий месяц" },
  { key: "prev", title: "прошлый месяц" },
  { key: "all", title: "всё время" },
];

export default function PersonPicker({
  people,
  personId,
  period,
}: {
  people: Employee[];
  personId: number | null;
  period: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [busy, start] = useTransition();

  function go(next: Record<string, string>) {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) q.set(k, v);
    start(() => router.push(`/people?${q}`));
  }

  return (
    <div className={`flex flex-wrap items-end gap-3 ${busy ? "opacity-60" : ""}`}>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-fg-muted">Сотрудник</span>
        <select
          value={personId ?? ""}
          onChange={(e) => go({ id: e.target.value })}
          className="min-w-64 rounded-xl border border-line bg-surface px-3 py-2"
        >
          <option value="">— выберите —</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {`${p.name}${twinHint(p, people)}`}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm text-fg-muted">Период</span>
        <select
          value={period}
          onChange={(e) => go({ period: e.target.value })}
          className="rounded-xl border border-line bg-surface px-3 py-2"
        >
          {PERIODS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
