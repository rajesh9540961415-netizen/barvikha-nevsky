"use client";

import { formatBusinessDay, formatMoney } from "@/lib/businessDay";
import { THRESHOLD, splitShift } from "@/lib/split";
import type { SideSplit } from "@/lib/split";
import type { Employee, Entry } from "@/lib/types";
import { BUILD } from "@/lib/version";

type Props = {
  day: string;
  entries: Entry[];
  crew: Employee[];
  /**
   * Что ещё не доехало до базы, словами: «2 записи и 1 отмена». Пусто —
   * значит всё в базе.
   *
   * В цифры это уже входит — деньги есть деньги. Но знать, что часть смены
   * пока живёт только на этом телефоне, надо: со второго телефона этих сумм
   * не видно, и итоги там будут другими.
   */
  waiting: string;
  onClose: () => void;
  onHistory: () => void;
  /**
   * Выгрузка живёт наверху намеренно: там перед сборкой перечитывается база.
   * Отчёт, собранный из половины записей, — самая тихая из ошибок.
   */
  onExport: () => void;
  /**
   * Когда смену выгружали и кто. Пусто — значит ещё ни разу.
   *
   * Раньше выгрузка не оставляла следа: файл падал в загрузки, а на экране
   * не менялось ничего. Выгрузил или нет, выгрузил ли уже сменщик — узнать
   * было неоткуда, и смену выгружали дважды либо не выгружали вовсе.
   */
  exported: { at: string; by: string } | null;
  /** Идёт сборка отчёта — кнопка занята. */
  exporting: boolean;
  /** Хостес и кальянный бар: считаются рядом, ни с кем не делятся. */
  side: Record<"hostess" | "hookah", SideSplit>;
};

export default function ShiftSummary({
  day,
  entries,
  crew,
  side,
  waiting,
  onClose,
  onHistory,
  onExport,
  exported,
  exporting,
}: Props) {
  const s = splitShift(entries, crew, day);
  const paying = s.waiters.filter((w) => w.aboveThreshold).length;
  // Внизу главного экрана стоит сумма ВСЕХ полученных денег, включая хостес
  // и кальянный бар. Если бы здесь она была только зальной, два экрана
  // показывали бы разные итоги за один вечер — и объяснить это было бы нечем.
  const sideTotal = side.hostess.total + side.hookah.total;

  return (
    <div className="flex min-h-dvh flex-col pb-8">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <button
          onClick={onClose}
          aria-label="Назад"
          className="-ml-1 rounded-lg px-2 py-1 text-2xl leading-none text-fg-muted active:bg-surface"
        >
          ‹
        </button>
        <div>
          <div className="text-base">Итоги смены</div>
          <div className="text-xs text-fg-muted">
            {formatBusinessDay(day)} · {s.crewSize}{" "}
            {plural(s.crewSize, "официант", "официанта", "официантов")}
          </div>
        </div>
      </header>

      {waiting && (
        <div className="mx-4 mt-4 rounded-xl border border-alert bg-alert/10 px-3 py-2">
          <div className="text-sm text-fg">Не всё ушло в базу: {waiting}</div>
          <div className="text-xs text-fg-muted">
            в цифрах ниже это учтено, но со второго телефона их пока не видно
          </div>
        </div>
      )}

      <div className="px-4 pt-4">
        <div className="rounded-xl bg-surface p-4">
          <div className="text-xs text-fg-muted">заработано за смену</div>
          <div className="text-3xl tabular-nums">
            {formatMoney(s.totalEarned)}
          </div>
          {/* Комиссия названа прямо: иначе итог меньше введённого, и непонятно,
              куда делись деньги. */}
          {s.totalCommission > 0 && (
            <div className="mt-0.5 text-xs text-fg-muted">
              гости оставили {formatMoney(s.totalGross)} · комиссия −
              {formatMoney(s.totalCommission)}
            </div>
          )}

          <div className="mt-3 flex justify-between border-t border-line pt-2.5 text-sm">
            <span className="text-fg-muted">чаевые</span>
            <span className="tabular-nums">{formatMoney(s.totalTips)}</span>
          </div>
          <div className="text-xs text-fg-muted">
            наличные {formatMoney(s.totalCash)} ·{" "}
            <Terminal net={s.totalTerminal} gross={s.totalTerminalGross} />
            {s.totalQr > 0 && ` · QR ${formatMoney(s.totalQr)}`}
          </div>
          <div className="mt-2 flex justify-between text-sm">
            <span className="text-fg-muted">сервисный сбор</span>
            <span className="tabular-nums">{formatMoney(s.totalService)}</span>
          </div>

          {sideTotal > 0 && (
            <>
              <div className="mt-3 flex justify-between border-t border-line pt-2.5 text-sm">
                <span className="text-fg-muted">хостес и кальянный бар</span>
                <span className="tabular-nums">{formatMoney(sideTotal)}</span>
              </div>
              <div className="text-xs text-fg-muted">
                эти деньги не делятся: ни администратору, ни кассиру
              </div>
              <div className="mt-2 flex justify-between text-base">
                <span className="text-fg-muted">всего за смену</span>
                <span className="tabular-nums">
                  {formatMoney(s.totalEarned + sideTotal)}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="px-4 pt-3">
        <Row label="Администратору" value={s.adminTotal} />
        <Row
          label="Кассиру"
          value={s.cashierTotal}
          note={
            s.crewSize > 0
              ? // Сумма кассира зависит от дня недели, поэтому показываем
                // её целиком: видно, из чего сложилась доля.
                `${formatMoney(s.cashierPool)} ÷ ${s.crewSize} = по ${formatMoney(s.cashierShare)} · платят ${paying}`
              : undefined
          }
        />
        {/* Питание — единственная строка, которая уменьшает выплату, а не
            распределяет её. Показываем отдельно, иначе «на руки» окажется
            меньше без объяснения. */}
        {s.totalStaff > 0 && (
          <Row
            label="Удержано за питание"
            value={-s.totalStaff}
            note="вычитается из выплаты, на порог не влияет"
          />
        )}
        <Row label="Официантам на руки" value={s.waitersNet} strong />
      </div>

      <div className="px-4 pt-4">
        <button
          onClick={onHistory}
          className="mb-2 w-full rounded-xl border border-line bg-surface py-3.5 text-base text-fg active:bg-surface-2"
        >
          История записей ›
        </button>
        <button
          disabled={entries.length === 0 || exporting}
          onClick={onExport}
          className={`w-full rounded-xl border py-3.5 text-base disabled:border-line disabled:text-fg-muted ${
            exported
              ? "border-line bg-surface text-fg"
              : "border-sand text-sand"
          }`}
        >
          {exporting
            ? "Собираю отчёт…"
            : exported
              ? "Выгрузить заново"
              : "Выгрузить смену для отчёта"}
        </button>
        {/* Отметка держится на экране, а не мигает сообщением на две секунды:
            вопрос «эту смену уже выгружали?» задают и через час, и назавтра,
            и часто не тот, кто нажимал кнопку. */}
        {exported ? (
          <div className="pt-2 text-center text-xs text-sand">
            ✓ выгружена в {clock(exported.at)}
            {exported.by && ` · ${exported.by}`}
          </div>
        ) : (
          <div className="pt-2 text-center text-xs text-fg-muted">
            ещё не выгружена
          </div>
        )}
      </div>

      {sideTotal > 0 && (
        <>
          <SidePart title="хостес" calc={side.hostess} />
          <SidePart title="кальянный бар" calc={side.hookah} />
        </>
      )}

      <div className="px-4 pb-1.5 pt-5 text-xs text-fg-muted">по официантам</div>
      <div className="flex flex-col gap-2 px-4">
        {s.waiters.map((w) => (
          <div key={w.waiterId} className="rounded-xl bg-surface p-3.5">
            <div className="flex items-baseline justify-between">
              <span className="text-base">{w.waiterName}</span>
              <span className="tabular-nums">{formatMoney(w.total)}</span>
            </div>
            <div className="mt-1.5 flex justify-between text-sm">
              <span className="text-fg-muted">чаевые</span>
              <span className="tabular-nums text-fg-muted">
                {formatMoney(w.tips)}
              </span>
            </div>
            <div className="text-xs text-fg-muted">
              наличные {formatMoney(w.cash)} ·{" "}
              <Terminal net={w.terminal} gross={w.terminalGross} />
              {w.qr > 0 && ` · QR ${formatMoney(w.qr)}`}
              {w.commission > 0 && ` · комиссия −${formatMoney(w.commission)}`}
            </div>
            <div className="mt-1 flex justify-between text-sm">
              <span className="text-fg-muted">сервисный сбор</span>
              <span className="tabular-nums text-fg-muted">
                {formatMoney(w.service)}
              </span>
            </div>

            {w.aboveThreshold ? (
              <div className="mt-2.5 border-t border-line pt-2.5 text-sm">
                <Line label="администратору" value={-w.toAdmin} />
                {w.toCashier > 0 ? (
                  <Line label="кассиру" value={-w.toCashier} />
                ) : (
                  <div className="flex justify-between text-fg-muted">
                    <span>кассиру</span>
                    <span>только сбор — не делится</span>
                  </div>
                )}
                {w.staff > 0 && <Line label="питание" value={-w.staff} />}
                <Payout value={w.net} />
              </div>
            ) : (
              <div className="mt-2.5 border-t border-line pt-2.5 text-sm">
                <div className="text-xs text-fg-muted">
                  меньше {formatMoney(THRESHOLD)} — не делится
                </div>
                {/* Питание вычитается и здесь: оно не зависит от того,
                    перешагнул человек порог или нет. Без этой строки
                    вычет исчез бы с экрана, но остался в деньгах. */}
                {w.staff > 0 && (
                  <div className="mt-1.5">
                    <Line label="питание" value={-w.staff} />
                    <Payout value={w.net} />
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Отметка сборки. Мелко и в самом низу: смене она не нужна, но когда
          спрашивают «а новая версия доехала?» — ответ здесь, а не в панели
          хостинга и не в разборе бандла. */}
      <div className="px-4 pt-6 text-right text-xs text-fg-muted">
        сборка {BUILD}
      </div>
    </div>
  );
}

function Row({
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
    <div className="flex items-baseline justify-between border-b border-line py-2.5 last:border-0">
      <div>
        <div className={strong ? "text-base" : "text-sm"}>{label}</div>
        {note && <div className="text-xs text-fg-muted">{note}</div>}
      </div>
      <span className={`tabular-nums ${strong ? "text-lg" : ""}`}>
        {formatMoney(value)}
      </span>
    </div>
  );
}

/**
 * Терминал двумя цифрами: сколько дошло и, в скобках, сколько оставил гость.
 *
 * Кассиры сверяют смену с лентой терминала, а в ленте пробита полная сумма.
 * Без второй цифры сверка не сходится ровно на комиссию Сбера, и её каждый
 * раз считают в уме. Просьба кассиров 08.08.2026.
 *
 * Скобки появляются только когда комиссию действительно удержали. Совпали
 * суммы — вторая цифра ничего не скажет, а строку удлинит.
 */
function Terminal({ net, gross }: { net: number; gross: number }) {
  return (
    <>
      терминал {formatMoney(net)}
      {gross > net && <span className="text-sand"> ({formatMoney(gross)})</span>}
    </>
  );
}

/**
 * Итог по человеку. Минус подсвечивается: значит он проел больше, чем
 * заработал, и это убыток смены, а не описка.
 */
function Payout({ value }: { value: number }) {
  return (
    <div className="mt-1.5 flex justify-between">
      <span className="text-fg-muted">на руки</span>
      <span className={`tabular-nums ${value < 0 ? "text-alert" : "text-sand"}`}>
        {formatMoney(value)}
      </span>
    </div>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <span className="text-fg-muted">{label}</span>
      <span className="tabular-nums text-fg-muted">{formatMoney(value)}</span>
    </div>
  );
}

/** «06:12» — время по часам того, кто смотрит. */
function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Блок хостес или кальянного бара.
 *
 * Строк меньше, чем у официанта, и намеренно: у этих денег нет ни порога,
 * ни долей, ни комиссии — показывать нечего, кроме того, чем оставили.
 * Пустой блок не рисуем вовсе: место на экране дороже симметрии.
 */
function SidePart({ title, calc }: { title: string; calc: SideSplit }) {
  if (calc.total === 0) return null;
  return (
    <>
      <div className="flex items-baseline justify-between px-4 pb-1.5 pt-5">
        <span className="text-xs text-fg-muted">{title}</span>
        <span className="text-xs tabular-nums text-fg-muted">
          {formatMoney(calc.total)}
        </span>
      </div>
      <div className="flex flex-col gap-2 px-4">
        {calc.rows
          .filter((r) => r.total > 0)
          .map((r) => (
            <div key={r.payeeId} className="rounded-xl bg-surface p-3.5">
              <div className="flex items-baseline justify-between">
                <span className="text-base">{r.payeeName}</span>
                <span className="tabular-nums">{formatMoney(r.total)}</span>
              </div>
              <div className="text-xs text-fg-muted">
                наличные {formatMoney(r.cash)}
                {r.qr > 0 && ` · QR ${formatMoney(r.qr)}`}
                {r.service > 0 && ` · сбор ${formatMoney(r.service)}`}
              </div>
            </div>
          ))}
      </div>
    </>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
