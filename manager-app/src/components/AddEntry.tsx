"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import scheme from "@/data/tables.json";
import { добавитьЗапись } from "@/lib/db/corrections";
import { money } from "@/lib/format";
import {
  KIND_TITLE,
  draftError,
  needsTable,
  rowsFromDraft,
  splitOffice,
  type Draft,
  type OfficeEntry,
} from "@/lib/office";
import { netAmount } from "@/lib/split";
import type { Employee, Kind } from "@/lib/types";
import Compare from "./Compare";
import { Chip, Field, Overlay } from "./EventEditor";

/**
 * Запись, которой не было вовсе.
 *
 * Правка исправляет уже внесённое, а это — восполняет пропущенное. Разница
 * не косметическая: пропущенную запись НЕ ВИДНО НИГДЕ. У QR есть второй
 * канал — Сбер сообщает приложению о поступлении, и неразнесённые деньги
 * встают отдельной строкой. У наличных и терминала такого канала нет: не
 * вбил кассир — записи не существует, и пустая клетка выглядит ровно так же,
 * как тихий вечер.
 *
 * Нашлось это только сверкой с бумажными листами: 5, 13 и 16 августа 2026 —
 * 13 116 ₽ мимо учёта, каждый раз потому, что человека не внесли в смену.
 *
 * ⚠️ Пояснение здесь обязательно, в отличие от правки. У правки есть
 * «было / стало», и по нему видно, что изменилось. У записи из ниоткуда
 * сравнить не с чем — единственное, что отличает её от выдумки, это слова
 * того, кто её завёл, и лист смены за спиной.
 */

type Scheme = { halls: { id: number; title: string; tables: { id: number; title: string }[] }[] };
const HALLS = (scheme as Scheme).halls;
const KINDS: Kind[] = ["cash", "terminal", "qr", "service", "staff"];

const ПУСТОЙ: Draft = {
  kind: "cash",
  contour: "hall",
  gross: 0,
  hallId: null,
  hallTitle: null,
  tableId: null,
  tableTitle: null,
  waiterIds: [],
};

type Props = {
  day: string;
  live: OfficeEntry[];
  crew: Employee[];
  onClose: () => void;
};

export default function AddEntry({ day, live, crew, onClose }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(ПУСТОЙ);
  const [время, setВремя] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const имя = useCallback(
    (id: number) => crew.find((p) => p.id === id)?.short ?? `№${id}`,
    [crew],
  );
  const before = useMemo(() => splitOffice(live, crew, day), [live, crew, day]);

  const свежие = useMemo(
    () =>
      draft.waiterIds.length === 0 || !draft.gross
        ? []
        : rowsFromDraft(draft, {
            businessDay: day,
            createdAt: new Date().toISOString(),
            operatorId: null,
            operatorName: "",
            managerId: 0,
            corrects: null,
            note: null,
            nameOf: имя,
          }).map((r) => ({
            ...r,
            corrects: null,
            source: "office" as const,
            managerId: 0,
            managerName: null,
            note: null,
            deletedNote: null,
          })),
    [draft, day, имя],
  );

  const after = useMemo(
    () => splitOffice([...live, ...свежие], crew, day),
    [live, свежие, crew, day],
  );

  const hall = HALLS.find((h) => h.id === draft.hallId) ?? null;
  const net = netAmount(draft.gross || 0, draft.kind);

  const problem =
    draftError(draft) ??
    (!/^\d{1,2}:\d{2}$/.test(время) ? "Укажите время, как на листе: 19:40" : null) ??
    (note.trim().length < 3 ? "Напишите, откуда эта запись" : null);

  function setKind(kind: Kind) {
    setDraft((d) => ({
      ...d,
      kind,
      ...(needsTable(kind)
        ? {}
        : { hallId: null, hallTitle: null, tableId: null, tableTitle: null }),
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
    const ответ = await добавитьЗапись({ businessDay: day, draft, время, note });
    setBusy(false);
    if ("error" in ответ) {
      setFailed(ответ.error);
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <Overlay onClose={onClose}>
      <div className="border-b border-line px-5 py-3">
        <div className="text-base">Завести запись задним числом</div>
        <div className="text-sm text-fg-muted">
          для того, что было в зале, а в приложение не попало
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
        </Field>

        <Field label={draft.kind === "staff" ? "Сколько проел" : "Сколько оставил гость"}>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={draft.gross || ""}
            onChange={(e) => setDraft((d) => ({ ...d, gross: Number(e.target.value) }))}
            className="w-48 rounded-xl border border-line bg-ink px-3 py-2 tabular-nums"
          />
          {net !== draft.gross && draft.gross > 0 && (
            <p className="mt-1.5 text-xs text-fg-muted">
              до официанта дойдёт {money(net)} — Сбер удержит {money(draft.gross - net)}
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
          </div>
          {/* Человека вне состава здесь нет намеренно: раскладка смены
              перебирает состав, и деньги за таким человеком не попали бы
              никуда. Сначала состав, потом запись. */}
          <p className="mt-1.5 text-xs text-fg-muted">
            в списке только состав смены — нет нужного, сначала «поправить состав»
          </p>
        </Field>

        <Field label="Во сколько — как на листе смены">
          <input
            value={время}
            onChange={(e) => setВремя(e.target.value)}
            placeholder="19:40"
            className="w-32 rounded-xl border border-line bg-ink px-3 py-2 tabular-nums"
          />
        </Field>

        <Field label="Откуда эта запись — обязательно">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="например: с бумажного листа смены, Никиту не внесли в приложение"
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
          {busy ? "Сохраняю…" : "Завести запись"}
        </button>
        <button onClick={onClose} className="px-3 text-fg-muted underline">
          не заводить
        </button>
      </div>
    </Overlay>
  );
}
