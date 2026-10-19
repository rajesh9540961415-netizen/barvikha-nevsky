"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import scheme from "@/data/tables.json";
import { добавитьЗапись } from "@/lib/db/corrections";
import { money, twinHint } from "@/lib/format";
import {
  KIND_TITLE,
  canHaveTable,
  contoursOf,
  draftError,
  needsTable,
  rowsFromDraft,
  splitOffice,
  контурНового,
  получатели,
  type Draft,
  type OfficeEntry,
  людиРолей,
} from "@/lib/office";
import { isDeduction, netAmount } from "@/lib/split";
import type { Contour, Employee, Kind, Shift } from "@/lib/types";
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
const KINDS: Kind[] = ["cash", "terminal", "qr", "service", "staff", "hold"];

const ПУСТОЙ: Draft = {
  kind: "cash",
  gross: 0,
  hallId: null,
  hallTitle: null,
  tableId: null,
  tableTitle: null,
  payees: [],
};

type Props = {
  day: string;
  live: OfficeEntry[];
  crew: Employee[];
  /** Справочник: по нему находится имя хостес — в составе зала её нет. */
  people: Employee[];
  /**
   * Состав ТОЙ смены — по нему определяется котёл получателя. См.
   * `контурНового`: у записи, которой не было вовсе, своего котла взяться
   * неоткуда, и единственный честный источник это состав смены.
   */
  shift: Shift;
  onClose: () => void;
};

export default function AddEntry({ day, live, crew, people, shift, onClose }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(ПУСТОЙ);
  const [время, setВремя] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const СТОРОНА = useMemo(() => получатели(shift, people), [shift, people]);

  const имя = useCallback(
    (id: number) => crew.find((p) => p.id === id)?.short ?? `№${id}`,
    [crew],
  );
  // Полсмены — из состава: кассиру такой официант не платит и в делителе
  // не стоит. Без этого «было / стало» показало бы одну долю кассира,
  // а приложение смены посчитало бы другую.
  const полсмены = shift.halfShift ?? [];
  const before = useMemo(
    () => splitOffice(live, crew, day, полсмены),
    [live, crew, day, полсмены],
  );

  const свежие = useMemo(
    () =>
      draft.payees.length === 0 || !draft.gross
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
    () => splitOffice([...live, ...свежие], crew, day, полсмены),
    [live, свежие, crew, day, полсмены],
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
      ...(needsTable(kind, contoursOf(d.payees))
        ? {}
        : { hallId: null, hallTitle: null, tableId: null, tableTitle: null }),
      ...(isDeduction(kind) && d.payees.length > 1
        ? { payees: d.payees.slice(0, 1) }
        : {}),
    }));
  }

  function toggleWaiter(id: number) {
    setDraft((d) => ({
      ...d,
      payees: d.payees.some((p) => p.id === id)
        ? d.payees.filter((p) => p.id !== id)
        : isDeduction(d.kind)
          ? [{ id, contour: контурНового(id, shift) }]
          : [...d.payees, { id, contour: контурНового(id, shift) }],
    }));
  }

  /**
   * Отмечает получателя из хостес или кальянного бара.
   *
   * Котёл берётся из списка, в котором нажали, а не выводится из человека:
   * от него зависит, вычтут ли из доли 20 % администратору и долю кассира.
   */
  function toggleSide(id: number, contour: Contour) {
    setDraft((d) => ({
      ...d,
      payees: d.payees.some((p) => p.id === id && p.contour === contour)
        ? d.payees.filter((p) => !(p.id === id && p.contour === contour))
        : [...d.payees, { id, contour }],
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

        <Field
          label={
            draft.kind === "staff"
              ? "Сколько проел"
              : draft.kind === "hold"
                ? "Сколько удержать"
                : "Сколько оставил гость"
          }
        >
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

        {needsTable(draft.kind, contoursOf(draft.payees)) && (
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
            isDeduction(draft.kind)
              ? "Кому вычесть"
              : draft.payees.length > 1
                ? `Кому — поровну на ${draft.payees.length}`
                : "Кому"
          }
        >
          <div className="flex flex-wrap gap-2">
            {crew.map((p) => (
              <Chip
                key={p.id}
                on={draft.payees.some((x) => x.id === p.id)}
                onClick={() => toggleWaiter(p.id)}
              >
                {p.short}
                {twinHint(p, crew)}
              </Chip>
            ))}
            {/* Вычет — и на администратора с кассиром: решение владельца
                19.10.2026. Деньги им сюда не пишут — их доля считается сама. */}
            {isDeduction(draft.kind) &&
              людиРолей(shift, crew, people).map(({ person, роль }) => (
                <Chip
                  key={person.id}
                  on={draft.payees.some((x) => x.id === person.id)}
                  onClick={() => toggleWaiter(person.id)}
                >
                  {person.short} · {роль}
                </Chip>
              ))}
          </div>

          {/* Хостес и кальянный бар. Отдельными рядами с подписями, а не
              вперемешку с залом: от того, из какого списка выбран человек,
              зависят его деньги — зальная доля делится с администратором
              и кассиром, барская и хостес не делятся ни с кем.

              Только у записи СО СТОЛОМ: гость оставляет чаевые за стол
              и просит поделить. У QR и питания такого не бывает. */}
          {СТОРОНА.length > 0 && canHaveTable(draft.kind) && (
            <>
              {(["hookah", "hostess"] as const).map((c) => {
                const список = СТОРОНА.filter((o) => o.contour === c);
                if (список.length === 0) return null;
                return (
                  <div key={c} className="mt-2">
                    <div className="mb-1 text-xs text-fg-muted">
                      {c === "hookah" ? "кальянный бар" : "хостес"}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {список.map(({ person }) => (
                        <Chip
                          key={`${c}-${person.id}`}
                          on={draft.payees.some(
                            (x) => x.id === person.id && x.contour === c,
                          )}
                          onClick={() => toggleSide(person.id, c)}
                        >
                          {person.short}
                        </Chip>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          )}

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
