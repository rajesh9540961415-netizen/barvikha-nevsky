"use client";

import { useState } from "react";
import { formatMoney } from "@/lib/businessDay";
import type { SideSplit } from "@/lib/split";
import type { Contour, Employee, Kind } from "@/lib/types";

/**
 * Чаевые хостес и кальянного бара.
 *
 * Два котла, которых у приложения не было вовсе: хостес получала чаевые
 * мимо всякого учёта, кальянный бар жил отдельным контуром. В отчёте блоки
 * под них есть с 11.08.2026, а данных в них не было ни одного дня.
 *
 * Главное отличие от зала: **эти деньги не делятся ни с кем**. Ни 20 %
 * администратору, ни доли кассиру, ни порога 1300 ₽ — решение владельца
 * 18.08.2026. Сколько гость оставил, столько человек и получил. Поэтому
 * здесь нет ни одного поля про отчисления: пустое поле «для симметрии»
 * однажды кто-нибудь заполнит.
 *
 * Видов денег три — наличные, QR и сервисный сбор. Терминала здесь нет
 * и не будет: своего терминала у бара и хостес не существует, чаевые
 * на терминале Сбера расписаны по котлам зала.
 *
 * ⚠️ Это не значит, что терминальных денег у них не бывает вовсе. Гость
 * за столом платит на ЗАЛЬНОМ терминале и просит поделить чаевые
 * с кальянщиком — такая доля вводится за столом, вместе с зальной, и котёл
 * ей ставится там же (решение владельца 20.08.2026). Здесь вводят только то,
 * что оставили лично, мимо зала, — а мимо зала терминала нет.
 */

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"];

/** Столько за раз не оставляют: защита от лишнего нуля. */
const MAX_AMOUNT = 300_000;

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "cash", label: "наличные" },
  { kind: "qr", label: "по QR" },
  { kind: "service", label: "сервисный сбор" },
];

type Props = {
  contour: Contour;
  onContour: (contour: Contour) => void;
  /** Хостес этого вечера — те, кого отметили в составе смены. */
  hostess: Employee[];
  /** Кальянщики смены и общий котёл бара. */
  hookah: Employee[];
  /** Уже записанное за смену: показываем рядом с именем. */
  split: Record<"hostess" | "hookah", SideSplit>;
  /** Открыть состав смены — если нужного человека в списке нет. */
  onCrew: () => void;
  /** Открыть мотивацию бара. Показывается только в котле кальянщиков. */
  onMotivation: () => void;
  onCancel: () => void;
  onConfirm: (input: {
    amount: number;
    kind: Kind;
    payee: Employee;
    contour: Contour;
  }) => Promise<void>;
};

export default function SideScreen({
  contour,
  onContour,
  hostess,
  hookah,
  split,
  onCrew,
  onMotivation,
  onCancel,
  onConfirm,
}: Props) {
  const [digits, setDigits] = useState("");
  const [payeeId, setPayeeId] = useState<number | null>(null);
  const [kind, setKind] = useState<Kind>("cash");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const side = contour === "hookah" ? "hookah" : "hostess";
  const people = side === "hookah" ? hookah : hostess;
  const amount = Number(digits || "0");
  const payee = people.find((p) => p.id === payeeId) ?? null;
  const ready = amount > 0 && payee !== null && !saving;

  /** Сколько этому человеку уже записано за смену — чтобы не внести дважды. */
  const already = (id: number) =>
    split[side].rows.find((r) => r.payeeId === id)?.total ?? 0;

  function press(key: string) {
    setFailed(false);
    if (key === "⌫") {
      setDigits((d) => d.slice(0, -1));
      return;
    }
    const next = (digits + key).replace(/^0+/, "");
    if (Number(next || "0") <= MAX_AMOUNT) setDigits(next);
  }

  async function confirm() {
    if (!ready || !payee) return;
    setSaving(true);
    setFailed(false);
    try {
      await onConfirm({ amount, kind, payee, contour });
      setDigits("");
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <button
          onClick={onCancel}
          aria-label="Назад"
          className="-ml-1 rounded-lg px-2 py-1 text-2xl leading-none text-fg-muted active:bg-surface"
        >
          ‹
        </button>
        <div className="text-base">Хостес и кальянный бар</div>
        {/* Мотивация бара — не чаевые: её платит заведение за проданные
            кальяны, и в суммы этого экрана она не входит. Но спрашивают про
            неё здесь же, в разговоре про деньги бара, поэтому вход стоит
            рядом. В шапке главного экрана места под ещё одну кнопку нет. */}
        {side === "hookah" && (
          <button
            onClick={onMotivation}
            className="ml-auto rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted active:bg-surface"
          >
            мотивация
          </button>
        )}
      </header>

      {/* Переключатель котлов. Выбранный котёл виден постоянно: перепутать
          их значит записать деньги другим людям, а по цифрам это потом
          не отличить — суммы у обоих одинаково «просто чаевые». */}
      <div className="flex gap-2 px-4 pt-3">
        {(["hostess", "hookah"] as const).map((c) => {
          const on = side === c;
          return (
            <button
              key={c}
              onClick={() => {
                onContour(c);
                setPayeeId(null);
                setFailed(false);
              }}
              className={`flex-1 rounded-xl border py-2.5 text-sm ${
                on
                  ? "border-sand bg-sand/10 text-fg"
                  : "border-line bg-surface text-fg-muted active:bg-surface-2"
              }`}
            >
              {c === "hostess" ? "Хостес" : "Кальянный бар"}
              <span className="ml-1.5 text-xs text-fg-muted tabular-nums">
                {formatMoney(split[c].total)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-1 py-5">
        <span
          className={`text-4xl tabular-nums ${amount > 0 ? "text-fg" : "text-fg-muted"}`}
        >
          {formatMoney(amount)}
        </span>
        <span className="text-xs text-fg-muted">
          {payee
            ? `${payee.short} получит всё целиком`
            : "делить не с кем — ни администратору, ни кассиру"}
        </span>
      </div>

      <div className="px-4 pb-3">
        <div className="mb-1.5 text-xs text-fg-muted">
          {payee ? "кому" : "выберите, кому"}
        </div>
        {people.length === 0 ? (
          // Пустой список — не тупик. Человека просто не отметили в составе
          // смены, и сказать об этом надо там же, где он понадобился.
          <button
            onClick={onCrew}
            className="w-full rounded-xl border border-dashed border-line px-3 py-3 text-left text-sm text-fg-muted active:bg-surface"
          >
            {side === "hookah"
              ? "Кальянщиков нет в составе смены — отметить"
              : "Хостес нет в составе смены — отметить"}
          </button>
        ) : (
          <div className="flex flex-wrap gap-2">
            {people.map((p) => {
              const on = p.id === payeeId;
              const had = already(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => {
                    setFailed(false);
                    setPayeeId(p.id);
                  }}
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    on
                      ? "border-sand bg-sand/10 text-fg"
                      : "border-line bg-surface text-fg-muted active:bg-surface-2"
                  }`}
                >
                  {p.short}
                  {had > 0 && (
                    <span className="ml-1.5 text-xs text-fg-muted tabular-nums">
                      {formatMoney(had)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-4 pb-3">
        <div className="mb-1.5 text-xs text-fg-muted">чем оставили</div>
        <div className="flex gap-2">
          {KINDS.map((k) => {
            const on = kind === k.kind;
            return (
              <button
                key={k.kind}
                onClick={() => {
                  setFailed(false);
                  setKind(k.kind);
                }}
                className={`flex-1 rounded-lg border px-2 py-2 text-sm ${
                  on
                    ? "border-sand bg-sand/10 text-fg"
                    : "border-line bg-surface text-fg-muted active:bg-surface-2"
                }`}
              >
                {k.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 px-4">
        {KEYS.map((k) => (
          <button
            key={k}
            onClick={() => press(k)}
            className="rounded-xl border border-line bg-surface py-3.5 text-2xl tabular-nums active:bg-surface-2"
          >
            {k}
          </button>
        ))}
      </div>

      <div className="px-4 pb-6 pt-3">
        <div
          className={`mb-1.5 text-xs ${failed ? "text-alert" : "text-fg-muted"}`}
        >
          {saving
            ? "сохраняю…"
            : failed
              ? "не сохранилось — проверьте связь и повторите"
              : "не делится и не облагается порогом 1 300 ₽"}
        </div>
        <button
          disabled={!ready}
          onClick={confirm}
          className="w-full rounded-xl bg-sand py-3.5 text-base text-ink disabled:bg-surface disabled:text-fg-muted"
        >
          Записать
        </button>
      </div>
    </div>
  );
}
