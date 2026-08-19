"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { saveCrew } from "@/lib/db/corrections";
import { money, twinHint } from "@/lib/format";
import { splitOffice, type OfficeEntry } from "@/lib/office";
import { adminShares, cashierPool } from "@/lib/split";
import type { Employee, Shift } from "@/lib/types";
import Compare from "./Compare";
import { Chip, Field, Overlay } from "./EventEditor";

/**
 * Правка состава смены и ролей задним числом.
 *
 * Это тоже исправление факта: кто на самом деле работал в тот вечер.
 * И оно двигает деньги не меньше, чем правка записи, — доля кассира делится
 * на число официантов смены, поэтому один лишний человек в составе
 * уменьшает её у каждого.
 *
 * Отсюда тот же порядок, что и у записей: сначала «было / стало» по всей
 * смене, потом сохранение, и обязательно след — кто менял и когда.
 */

type Props = {
  day: string;
  shift: Shift;
  live: OfficeEntry[];
  crew: Employee[];
  people: Employee[];
  onClose: () => void;
};

export default function CrewEditor({ day, shift, live, crew, people, onClose }: Props) {
  const router = useRouter();
  const [next, setNext] = useState<Shift>(shift);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const before = useMemo(() => splitOffice(live, crew, day), [live, crew, day]);

  // Официанта, которого нет в справочнике, но который стоит в смене,
  // всё равно надо посчитать: иначе доля кассира разделится на меньшее
  // число людей и остальные получат больше, чем им причитается.
  const nextCrew = useMemo(
    () =>
      next.crew.map(
        (id) =>
          people.find((p) => p.id === id) ??
          crew.find((p) => p.id === id) ?? { id, name: `№${id}`, short: `№${id}` },
      ),
    [next.crew, people, crew],
  );

  const after = useMemo(
    () => splitOffice(live, nextCrew, day),
    [live, nextCrew, day],
  );

  const problem =
    next.crew.length === 0
      ? "Отметьте хотя бы одного официанта"
      : next.operator === null
        ? "Укажите, кто вносил записи"
        : next.admin === null && next.admin2 !== null
          ? "Второй администратор есть, а первого нет"
          : next.admin !== null && next.admin === next.admin2
            ? "Оба администратора — один и тот же человек"
            : null;

  function toggle(id: number) {
    setNext((s) => ({
      ...s,
      crew: s.crew.includes(id)
        ? s.crew.filter((x) => x !== id)
        : [...s.crew, id],
    }));
  }

  async function save() {
    setBusy(true);
    setFailed(null);
    const answer = await saveCrew({ businessDay: day, shift: next, note });
    setBusy(false);
    if ("error" in answer) {
      setFailed(answer.error);
      return;
    }
    router.refresh();
    onClose();
  }

  // Люди, за которыми в этой смене есть деньги, но которых нет в справочнике.
  const extra = [...new Set(live.map((e) => e.waiterId))]
    .filter((id) => !people.some((p) => p.id === id))
    .map((id) => ({
      id,
      name: live.find((e) => e.waiterId === id)!.waiterName,
      short: live.find((e) => e.waiterId === id)!.waiterName,
    }));
  const everyone = [...people, ...extra];

  return (
    <Overlay onClose={onClose}>
      <div className="border-b border-line px-5 py-3">
        <div className="text-base">Поправить состав смены</div>
        <div className="text-sm text-fg-muted">
          от состава зависит доля кассира: {money(cashierPool(day))} делится
          на всех отмеченных
        </div>
      </div>

      <div className="flex flex-col gap-5 px-5 py-4">
        <Field label={`Официанты смены — отмечено ${next.crew.length}`}>
          <div className="flex flex-wrap gap-2">
            {everyone.map((p) => (
              <Chip key={p.id} on={next.crew.includes(p.id)} onClick={() => toggle(p.id)}>
                {p.short}
                {twinHint(p, everyone)}
              </Chip>
            ))}
          </div>
        </Field>

        <Role
          label="Кто вносил записи"
          people={everyone}
          value={next.operator}
          onPick={(id) => setNext((s) => ({ ...s, operator: id }))}
        />
        <Role
          label="Администратор смены — ему уходят 20 %"
          people={everyone}
          value={next.admin}
          onPick={(id) => setNext((s) => ({ ...s, admin: id }))}
        />
        {/* Второй администратор пустует в обычную смену — и это не пропуск,
            а норма. Заполняется, когда смену делили надвое: один до
            пересменки, второй после. Доля тогда делится пополам, без
            привязки к часам — решение владельца 18.08.2026. */}
        <Role
          label="Второй администратор — если смену делили надвое"
          people={everyone}
          value={next.admin2}
          onPick={(id) => setNext((s) => ({ ...s, admin2: id }))}
        />
        {next.admin2 !== null && (
          <p className="-mt-3 text-sm text-fg-muted">
            доля администратора делится пополам:{" "}
            {adminShares(after.adminTotal, 2)
              .map((доля) => money(доля))
              .join(" и ")}
          </p>
        )}
        <Role
          label={`Кассир смены — ему уходит доля от ${money(cashierPool(day))}`}
          people={everyone}
          value={next.cashier}
          onPick={(id) => setNext((s) => ({ ...s, cashier: id }))}
        />

        <Field label="Зачем поправили — по желанию">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="например: Регита ушла в 22:00, вместо неё вышла Алеся"
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
          {busy ? "Сохраняю…" : "Сохранить состав"}
        </button>
        <button onClick={onClose} className="px-3 text-fg-muted underline">
          не менять
        </button>
      </div>
    </Overlay>
  );
}

function Role({
  label,
  people,
  value,
  onPick,
}: {
  label: string;
  people: Employee[];
  value: number | null;
  onPick: (id: number | null) => void;
}) {
  return (
    <Field label={label}>
      <select
        value={value ?? ""}
        onChange={(e) => onPick(e.target.value ? Number(e.target.value) : null)}
        className="rounded-xl border border-line bg-ink px-3 py-2"
      >
        <option value="">— не указан —</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {`${p.name}${twinHint(p, people)}`}
          </option>
        ))}
      </select>
    </Field>
  );
}
