"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { DayData } from "@/lib/db/corrections";
import { cancelEvent } from "@/lib/db/corrections";
import { clock, money, moneyOrDash, moment, plural } from "@/lib/format";
import {
  KIND_TITLE,
  accrued,
  accruedTotal,
  eventKey,
  splitOffice,
  type ShiftEvent,
} from "@/lib/office";
import { THRESHOLD, cashierPool } from "@/lib/split";
import Compare from "./Compare";
import CrewEditor from "./CrewEditor";
import EventEditor, { Field, Overlay } from "./EventEditor";

/**
 * Смена целиком: раскладка, состав и все записи.
 *
 * Отменённые записи остаются на экране перечёркнутыми. Удалять их нельзя
 * в принципе — это денежный документ, и через год должно быть видно
 * не только «сколько», но и «почему столько».
 */

export default function ShiftScreen({ data }: { data: DayData }) {
  const { businessDay: day, live, events, shift, crew, people } = data;
  const [editing, setEditing] = useState<ShiftEvent | null>(null);
  const [cancelling, setCancelling] = useState<ShiftEvent | null>(null);
  const [crewOpen, setCrewOpen] = useState(false);

  const split = useMemo(() => splitOffice(live, crew, day), [live, crew, day]);
  const nameOf = (id: number | null) =>
    id === null ? "не указан" : people.find((p) => p.id === id)?.short ?? `№${id}`;

  return (
    <>
      <section className="mt-6 rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3">
          <div className="text-sm text-fg-muted">
            {crew.length} {plural(crew.length, "официант", "официанта", "официантов")}
            {" · вносила "}
            {nameOf(shift.operator)}
            {" · администратор "}
            {nameOf(shift.admin)}
            {" · кассир "}
            {nameOf(shift.cashier)}
          </div>
          <button
            onClick={() => setCrewOpen(true)}
            className="text-sm text-sand underline"
          >
            поправить состав
          </button>
        </div>

        <div className="grid gap-x-8 gap-y-1 px-5 py-4 sm:grid-cols-2">
          <Total label="Заработано за смену" value={split.totalEarned} strong />
          <Total label="Начислено официантам" value={accruedTotal(split)} strong />
          <Total label="чаевые" value={split.totalTips} />
          <Total label="Администратору" value={split.adminTotal} />
          <Total label="сервисный сбор" value={split.totalService} />
          <Total
            label="Кассиру"
            value={split.cashierTotal}
            note={`${money(cashierPool(day))} ÷ ${crew.length || 1} = по ${money(split.cashierShare)}`}
          />
          <Total
            label="Гости оставили"
            value={split.totalGross}
            note={
              split.totalCommission > 0
                ? `комиссия Сбера −${money(split.totalCommission)}`
                : undefined
            }
          />
        </div>

        <div className="overflow-x-auto border-t border-line">
          <table className="w-full border-collapse text-right text-sm">
            <thead className="text-xs text-fg-muted">
              <tr className="border-b border-line">
                <th className="px-5 py-2 text-left font-normal">официант</th>
                <th className="px-2 py-2 font-normal">заработано</th>
                <th className="px-2 py-2 font-normal">админу</th>
                <th className="px-2 py-2 font-normal">кассиру</th>
                <th className="px-5 py-2 font-normal">начислено</th>
              </tr>
            </thead>
            <tbody>
              {split.waiters.map((w) => (
                <tr key={w.waiterId} className="border-b border-line/40">
                  <td className="px-5 py-1.5 text-left">
                    {w.waiterName}
                    {!w.aboveThreshold && (
                      <span className="ml-2 text-xs text-fg-muted">
                        ниже {money(THRESHOLD)} — не делится
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">{moneyOrDash(w.total)}</td>
                  <td className="px-2 py-1.5 tabular-nums text-fg-muted">
                    {moneyOrDash(-w.toAdmin)}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums text-fg-muted">
                    {moneyOrDash(-w.toCashier)}
                  </td>
                  <td className="px-5 py-1.5 tabular-nums text-sand">
                    {money(accrued(w))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Та же сноска, что в списке смен и на экране сотрудника: все суммы
            здесь — то, что дошло, а гость оставил больше. Человек, заходящий
            раз в месяц, иначе решит, что цифра неверная. */}
        {split.totalCommission > 0 && (
          <p className="border-t border-line px-5 py-3 text-sm text-fg-muted">
            Суммы — то, что <b className="font-medium text-fg">дошло</b>. Сбер
            удерживает 8 % с чаевых на терминале: гости оставили{" "}
            {money(split.totalGross)}, комиссия — {money(split.totalCommission)}.
            В списке записей ниже обе суммы стоят рядом.
          </p>
        )}
      </section>

      <h2 className="mt-8 text-sm text-fg-muted">
        Записи — {events.filter((e) => !e.deletedAt).length} живых из {events.length}
      </h2>
      {/* Питание видно в записях, но нет в начислениях — и это не забывчивость.
          Бэк-офис показывает, сколько человеку причитается; сколько ему выдали
          на руки за вычетом съеденного, считает смена. Править запись о питании
          при этом больше негде: смена умеет отменять только последнюю. */}
      {events.some((e) => e.kind === "staff" && !e.deletedAt) && (
        <p className="mt-1 text-xs text-fg-muted">
          Питание в записях есть, в начислениях — нет: это вычет при выплате,
          его считает смена.
        </p>
      )}

      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-right text-sm">
          <thead className="text-xs text-fg-muted">
            <tr className="border-b border-line">
              <th className="py-2 pr-3 text-left font-normal">время</th>
              <th className="px-3 py-2 text-left font-normal">вид</th>
              <th className="px-3 py-2 text-left font-normal">стол</th>
              <th className="px-3 py-2 text-left font-normal">кому</th>
              <th className="px-3 py-2 font-normal">гость оставил</th>
              <th className="px-3 py-2 font-normal">дошло</th>
              <th className="py-2 pl-3 font-normal"> </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <EventRow
                key={e.key}
                event={e}
                onEdit={() => setEditing(e)}
                onCancel={() => setCancelling(e)}
              />
            ))}
          </tbody>
        </table>
        {events.length === 0 && (
          <p className="py-6 text-fg-muted">За эту смену записей нет.</p>
        )}
      </div>

      {data.changes.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm text-fg-muted">Правки состава смены</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {data.changes.map((c, i) => (
              <li key={i} className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm">
                <span className="text-fg-muted">{moment(c.at)} · </span>
                {c.managerName}: {describeCrewChange(c, nameOf)}
                {c.note && <div className="text-fg-muted">— {c.note}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing && (
        <EventEditor
          day={day}
          event={editing}
          live={live}
          crew={crew}
          people={people}
          onClose={() => setEditing(null)}
        />
      )}
      {cancelling && (
        <CancelDialog
          day={day}
          event={cancelling}
          live={live}
          crew={crew}
          onClose={() => setCancelling(null)}
        />
      )}
      {crewOpen && (
        <CrewEditor
          day={day}
          shift={shift}
          live={live}
          crew={crew}
          people={people}
          onClose={() => setCrewOpen(false)}
        />
      )}
    </>
  );
}

function EventRow({
  event,
  onEdit,
  onCancel,
}: {
  event: ShiftEvent;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const dead = event.deletedAt !== null;
  const replaced = event.replacedBy !== null;

  return (
    <tr className={`border-b border-line/40 ${dead ? "text-fg-muted" : ""}`}>
      <td className="py-2 pr-3 text-left tabular-nums">{clock(event.createdAt)}</td>
      <td className="px-3 py-2 text-left">{KIND_TITLE[event.kind]}</td>
      <td className="px-3 py-2 text-left">
        {event.tableTitle ? `${event.tableTitle} · ${event.hallTitle}` : "—"}
      </td>
      <td className="px-3 py-2 text-left">
        <span className={dead ? "line-through" : ""}>
          {event.waiters.map((w) => shortName(w.name)).join(" + ")}
        </span>
        {/* След правки. Отмена ради замены и отмена насовсем выглядят в базе
            одинаково, а читаться должны по-разному. */}
        {event.corrects && (
          <div className="text-xs text-sand">
            поправила {event.managerName ?? "бэк-офис"}
            {event.note && ` — ${event.note}`}
          </div>
        )}
        {dead && (
          <div className="text-xs">
            {replaced ? "заменено правкой" : "отменено"}
            {event.deletedByName && ` · ${event.deletedByName}`}
            {event.deletedAt && ` · ${moment(event.deletedAt)}`}
            {event.deletedNote && ` — ${event.deletedNote}`}
          </div>
        )}
      </td>
      <td className={`px-3 py-2 tabular-nums ${dead ? "line-through" : ""}`}>
        {money(event.gross)}
      </td>
      <td className={`px-3 py-2 tabular-nums ${dead ? "line-through" : ""}`}>
        {event.amount === event.gross ? "—" : money(event.amount)}
      </td>
      <td className="py-2 pl-3 text-right whitespace-nowrap">
        {!dead && (
          <>
            <button onClick={onEdit} className="text-sand underline">
              поправить
            </button>
            <button onClick={onCancel} className="ml-3 text-fg-muted underline">
              отменить
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

/**
 * Отмена без замены.
 *
 * Тоже с предпросмотром: убрать запись — это тоже подвинуть всю смену,
 * и человек может провалиться под порог ровно так же, как перешагнуть его.
 */
function CancelDialog({
  day,
  event,
  live,
  crew,
  onClose,
}: {
  day: string;
  event: ShiftEvent;
  live: DayData["live"];
  crew: DayData["crew"];
  onClose: () => void;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const before = useMemo(() => splitOffice(live, crew, day), [live, crew, day]);
  const after = useMemo(
    () => splitOffice(live.filter((r) => eventKey(r) !== event.key), crew, day),
    [live, event.key, crew, day],
  );

  async function run() {
    setBusy(true);
    setFailed(null);
    const answer = await cancelEvent({ businessDay: day, key: event.key, note });
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
        <div className="text-base">Отменить запись</div>
        <div className="text-sm text-fg-muted">
          {clock(event.createdAt)} · {KIND_TITLE[event.kind]} {money(event.gross)} ·{" "}
          {event.waiters.map((w) => shortName(w.name)).join(" + ")}
        </div>
      </div>

      <div className="flex flex-col gap-5 px-5 py-4">
        <p className="text-sm text-fg-muted">
          Запись не сотрётся: она останется в истории перечёркнутой, с вашим
          именем и временем. Стереть строку нельзя в принципе — это денежный
          документ.
        </p>

        <Field label="Зачем отменяем — по желанию">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="например: гость забрал чаевые обратно"
            className="w-full rounded-xl border border-line bg-ink px-3 py-2"
          />
        </Field>

        <Compare before={before} after={after} />
        {failed && <p className="text-sm text-alert">{failed}</p>}
      </div>

      <div className="sticky bottom-0 flex gap-3 border-t border-line bg-surface px-5 py-3">
        <button
          disabled={busy}
          onClick={run}
          className="rounded-xl border border-alert px-5 py-2.5 font-medium text-alert disabled:opacity-40"
        >
          {busy ? "Отменяю…" : "Отменить запись"}
        </button>
        <button onClick={onClose} className="px-3 text-fg-muted underline">
          не отменять
        </button>
      </div>
    </Overlay>
  );
}

function Total({
  label,
  value,
  note,
  strong,
}: {
  label: string;
  value: number;
  note?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/40 py-1.5">
      <div>
        <span className={strong ? "" : "text-sm text-fg-muted"}>{label}</span>
        {note && <div className="text-xs text-fg-muted">{note}</div>}
      </div>
      <span className={`tabular-nums ${strong ? "text-lg" : "text-sm"}`}>
        {moneyOrDash(value)}
      </span>
    </div>
  );
}

/**
 * Что именно поменяли в составе — словами и только изменившееся.
 *
 * «администратор Анна К. → Анна К.» не говорит ничего, а прочитать мимо него
 * нельзя: строка про деньги, и в ней должно быть видно только то, что поехало.
 */
function describeCrewChange(
  c: DayData["changes"][number],
  nameOf: (id: number | null) => string,
): string {
  const parts: string[] = [];

  const added = c.after.crew.filter((id) => !c.before.crew.includes(id));
  const removed = c.before.crew.filter((id) => !c.after.crew.includes(id));
  if (added.length > 0) parts.push(`добавлены ${added.map(nameOf).join(", ")}`);
  if (removed.length > 0) parts.push(`убраны ${removed.map(nameOf).join(", ")}`);

  const roles: [string, number | null, number | null][] = [
    ["вносил записи", c.before.operator, c.after.operator],
    ["администратор", c.before.admin, c.after.admin],
    ["кассир", c.before.cashier, c.after.cashier],
  ];
  for (const [title, was, now] of roles) {
    if (was !== now) parts.push(`${title}: ${nameOf(was)} → ${nameOf(now)}`);
  }

  return parts.length > 0 ? parts.join("; ") : "состав пересохранён без изменений";
}

/** «Яна Миллес» → «Яна М.»: в таблице важна плотность, а не полнота. */
function shortName(name: string): string {
  const [first, second] = name.split(" ");
  return second ? `${first} ${second[0]}.` : first;
}
