"use client";

import { useState } from "react";
import type { PickedPayee } from "./AmountPad";
import SidePots from "./SidePots";
import { formatBusinessDay, formatMoney } from "@/lib/businessDay";
import { shares } from "@/lib/split";
import type { Contour, Employee, QrTip } from "@/lib/types";

/**
 * Распределение поступления по персональному QR.
 *
 * Эти деньги приходят мимо зала: гость платит по QR на чеке, кассир их
 * не видит и внести не может — о поступлении сообщает только Сбер
 * уведомлением в Telegram.
 *
 * Сбер называет не человека, а котёл — «Официант 5». Кто именно обслуживал
 * гостя, не знает никто, поэтому получателей выбирает кассир из состава
 * смены, а сумма делится между ними поровну.
 *
 * ⚠️ Получатели бывают из разных котлов — как и за столом. До 21.08.2026
 * это было запрещено: считалось, что Сбер прислал поступление уже
 * адресованным котлу, и делить его между котлами значит переложить деньги
 * из чужого котла в свой. Владелец 21.08.2026 запрет сняла, и вот почему
 * он не держался: **номер котла за человеком не закреплён** — проверено
 * 20.08.2026, «Официант 3» 12-го был Яной, 13-го Пархоменко, 16-го Алиной.
 * Раз номер ничего не говорит о том, кто обслуживал, он тем более ничего
 * не говорит о том, кому гость хотел оставить.
 *
 * 💡 Зальная доля отдаёт 20 % администратору и долю кассира, барская
 * и хостес — ничего. Это следствие котла у каждой строки, никаких
 * отдельных правил для QR здесь нет.
 */

type Props = {
  tip: QrTip;
  /**
   * Официанты той смены, к которой относится поступление.
   *
   * Обычно это текущая смена. Но забытое поступление разносят уже следующим
   * вечером, и тогда здесь состав ТОГО вечера — делить надо между теми,
   * кто работал, когда гость платил.
   */
  crew: Employee[];
  /** Хостес того же вечера. Пусто — значит её не отметили в составе. */
  hostess: Employee[];
  /** Кальянщики смены и общий котёл бара. Котёл есть всегда. */
  hookah: Employee[];
  /** Текущий бизнес-день — чтобы отличить сегодняшнее поступление от забытого. */
  today: string;
  /** Открыть состав смены — если нужного человека в списке нет. */
  onCrew: () => void;
  onCancel: () => void;
  onConfirm: (payees: PickedPayee[]) => Promise<void>;
};

/** «01:26» — время поступления, чтобы соотнести его с вечером. */
function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function QrTipScreen({
  tip,
  crew,
  hostess,
  hookah,
  today,
  onCrew,
  onCancel,
  onConfirm,
}: Props) {
  const stale = tip.businessDay !== today;
  const [ids, setIds] = useState<number[]>([]);
  /** Кто выбран из хостес и кальянного бара — по порядку нажатий. */
  const [side, setSide] = useState<{ id: number; contour: Contour }[]>([]);
  /** Какой котёл раскрыт. Раскрытым остаётся и тот, из кого уже выбрали. */
  const [openSide, setOpenSide] = useState<Contour | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // Порядок тот же, что и в долях: кто выбран первым, тот первый в раскладке,
  // ему же достаётся лишняя копейка от нечётной суммы. Зал идёт первым,
  // сторона за ним — так же они лягут в базу.
  const payees: PickedPayee[] = [
    ...ids.map((id) => ({
      person: crew.find((w) => w.id === id),
      contour: "hall" as Contour,
    })),
    ...side.map(({ id, contour }) => ({
      person: (contour === "hookah" ? hookah : hostess).find((p) => p.id === id),
      contour,
    })),
  ].filter((p): p is PickedPayee => p.person !== undefined);
  const parts = shares(tip.amount, payees.length);
  const ready = payees.length > 0 && !saving;
  const allPicked = crew.length > 0 && ids.length === crew.length;
  /**
   * Есть ли получатель со стороны.
   *
   * От этого зависит подпись под кнопкой: у зальной доли будут вычтены
   * 20 % администратору и доля кассира, у барской и хостес — ничего.
   * Кассир должен видеть это до нажатия, а не узнавать из итогов.
   */
  const mixed = side.length > 0;

  function toggle(id: number) {
    setFailed(null);
    setIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }

  /** Отмечает получателя из хостес или кальянного бара — всегда добавлением. */
  function pickSide(id: number, contour: Contour) {
    setFailed(null);
    setSide((current) =>
      current.some((p) => p.id === id)
        ? current.filter((p) => p.id !== id)
        : [...current, { id, contour }],
    );
  }

  async function confirm() {
    if (!ready) return;
    setSaving(true);
    setFailed(null);
    try {
      await onConfirm(payees);
      // При успехе экран закрывается сверху.
    } catch (error) {
      // Второй кассир мог разнести это поступление секундой раньше —
      // тогда база откажет, и сказать об этом надо прямо.
      setFailed(
        error instanceof Error && error.message
          ? error.message
          : "не получилось — проверьте связь и повторите",
      );
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
        <div className="text-base">Чаевые по QR</div>
      </header>

      {/* Забытое поступление — не рядовой случай, и молчать об этом нельзя:
          кассир видит сегодняшний экран, а раздаёт деньги за прошлый вечер
          прошлому составу. Если он этого не поймёт, то решит, что ошибся
          списком людей, и разнесёт не тем. */}
      {stale && (
        <div className="mx-4 mt-4 rounded-xl border border-alert bg-alert/10 px-3 py-2">
          <div className="text-sm text-fg">
            Не разнесли в смену {formatBusinessDay(tip.businessDay)}
          </div>
          <div className="text-xs text-fg-muted">
            деньги уйдут в ту смену, а не в сегодняшнюю — и список ниже
            тоже её, а не сегодняшний
          </div>
        </div>
      )}

      <div className="flex flex-1 flex-col items-center justify-center gap-1 py-6">
        <span className="text-4xl tabular-nums text-fg">
          {formatMoney(tip.amount)}
        </span>
        <span className="text-xs text-fg-muted">
          {tip.team} · пришли в {clock(tip.receivedAt)}
          {stale && ` ${formatBusinessDay(tip.businessDay)}`}
        </span>
      </div>

      <div className="px-4 pb-3">
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-xs text-fg-muted">
            {payees.length === 0
              ? "кому раздать"
              : payees.length === 1
                ? "получатель"
                : `делим поровну на ${payees.length}`}
          </span>
          {crew.length > 1 && (
            <button
              onClick={() => {
                setFailed(null);
                setIds(allPicked ? [] : crew.map((w) => w.id));
              }}
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs ${
                allPicked
                  ? "border-sand bg-sand/10 text-fg"
                  : "border-line bg-surface text-fg-muted active:bg-surface-2"
              }`}
            >
              {allPicked ? "× снять всех" : "всем на смене"}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {crew.map((w) => {
            const on = ids.includes(w.id);
            return (
              <button
                key={w.id}
                onClick={() => toggle(w.id)}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  on
                    ? "border-sand bg-sand/10 text-fg"
                    : "border-line bg-surface text-fg-muted active:bg-surface-2"
                }`}
              >
                {w.short}
              </button>
            );
          })}
        </div>
        {/* Хостес и кальянный бар — тот же кусок, что и на экране суммы
            за столом: гость по QR тоже платит одной суммой за всех. */}
        <SidePots
          hostess={hostess}
          hookah={hookah}
          side={side}
          open={openSide}
          onOpen={(c) => {
            setFailed(null);
            setOpenSide(c);
          }}
          onPick={pickSide}
          onCrew={onCrew}
        />

        {payees.length > 1 && (
          <div className="mt-2 text-xs text-fg-muted">
            {payees
              .map((p, i) => `${p.person.short} — ${formatMoney(parts[i])}`)
              .join(" · ")}
          </div>
        )}
      </div>

      <div className="px-4 pb-6 pt-3">
        <div
          className={`mb-1.5 text-xs ${failed ? "text-alert" : "text-fg-muted"}`}
        >
          {saving
            ? "сохраняю…"
            : failed
              ? failed
              : mixed
                ? "доля бара и хостес ни с кем не делится — ни администратору, ни кассиру"
                : "войдут в заработок официанта наравне с остальными чаевыми"}
        </div>
        <button
          disabled={!ready}
          onClick={confirm}
          className="w-full rounded-xl bg-sand py-3.5 text-base text-ink disabled:bg-surface disabled:text-fg-muted"
        >
          Разнести
        </button>
      </div>
    </div>
  );
}
