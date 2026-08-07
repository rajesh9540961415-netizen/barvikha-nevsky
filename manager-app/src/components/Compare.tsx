"use client";

import { delta, money, moneyOrDash } from "@/lib/format";
import { accrued, accruedTotal } from "@/lib/office";
import { THRESHOLD, type ShiftSplit } from "@/lib/split";

/**
 * «Было / стало» по всей смене.
 *
 * Главное правило исправлений и самое неочевидное: правка одной записи
 * меняет всю смену. Заработок официанта проходит через порог 1300 ₽,
 * и правка на сто рублей может перевести человека через порог — тогда
 * пересчитываются доли администратора, кассира и итог каждого.
 *
 * Поэтому перед сохранением показываем смену целиком, а не одну строку.
 * Строки, где ничего не изменилось, приглушены: глаз должен сразу цепляться
 * за то, что поедет.
 */

type Props = { before: ShiftSplit; after: ShiftSplit };

export default function Compare({ before, after }: Props) {
  const crossed = after.waiters.filter((w) => {
    const was = before.waiters.find((x) => x.waiterId === w.waiterId);
    return was && was.aboveThreshold !== w.aboveThreshold;
  });

  // Человек, которого раньше в раскладке не было вовсе, или наоборот.
  const appeared = after.waiters.filter(
    (w) => !before.waiters.some((x) => x.waiterId === w.waiterId),
  );
  const gone = before.waiters.filter(
    (w) => !after.waiters.some((x) => x.waiterId === w.waiterId),
  );

  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line px-4 py-2.5 text-sm text-fg-muted">
        Что станет со сменой
      </div>

      {(crossed.length > 0 || appeared.length > 0 || gone.length > 0) && (
        <div className="border-b border-line bg-sand/10 px-4 py-3 text-sm">
          {crossed.map((w) => {
            const was = before.waiters.find((x) => x.waiterId === w.waiterId)!;
            return (
              <p key={w.waiterId} className="text-sand">
                {w.waiterName}{" "}
                {w.aboveThreshold
                  ? `перешагнёт порог ${money(THRESHOLD)} — начнёт отдавать доли администратору и кассиру`
                  : `опустится ниже порога ${money(THRESHOLD)} — перестанет отдавать доли`}
                . Было {money(was.total)}, станет {money(w.total)}.
              </p>
            );
          })}
          {appeared.map((w) => (
            <p key={w.waiterId} className="text-sand">
              {w.waiterName} появится в раскладке смены.
            </p>
          ))}
          {gone.map((w) => (
            <p key={w.waiterId} className="text-alert">
              {w.waiterName} исчезнет из раскладки смены — проверьте состав.
            </p>
          ))}
        </div>
      )}

      <table className="w-full border-collapse text-right text-sm">
        <thead className="text-xs text-fg-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-2 text-left font-normal"> </th>
            <th className="px-2 py-2 font-normal">было</th>
            <th className="px-2 py-2 font-normal">станет</th>
            <th className="px-4 py-2 font-normal">разница</th>
          </tr>
        </thead>

        <tbody>
          <Line label="Заработано за смену" was={before.totalEarned} now={after.totalEarned} strong />
          <Line label="чаевые" was={before.totalTips} now={after.totalTips} inset />
          <Line label="сервисный сбор" was={before.totalService} now={after.totalService} inset />
          <Line
            label="Гости оставили"
            was={before.totalGross}
            now={after.totalGross}
            note="до комиссии Сбера"
          />
          <Line label="Администратору" was={before.adminTotal} now={after.adminTotal} />
          <Line
            label="Кассиру"
            was={before.cashierTotal}
            now={after.cashierTotal}
            note={
              before.cashierShare === after.cashierShare
                ? `по ${money(after.cashierShare)} с каждого, кто перешагнул порог`
                : `доля была ${money(before.cashierShare)}, стала ${money(after.cashierShare)}`
            }
          />
          <Line
            label="Начислено официантам"
            was={accruedTotal(before)}
            now={accruedTotal(after)}
            strong
          />
        </tbody>

        <tbody className="border-t border-line">
          <tr>
            <td colSpan={4} className="px-4 pb-1 pt-3 text-left text-xs text-fg-muted">
              по официантам — начислено
            </td>
          </tr>
          {after.waiters.map((w) => {
            const was = before.waiters.find((x) => x.waiterId === w.waiterId);
            return (
              <Line
                key={w.waiterId}
                label={w.waiterName}
                was={was ? accrued(was) : 0}
                now={accrued(w)}
                note={
                  w.aboveThreshold
                    ? undefined
                    : `заработано ${money(w.total)} — меньше порога, не делится`
                }
              />
            );
          })}
          {gone.map((w) => (
            <Line key={w.waiterId} label={w.waiterName} was={accrued(w)} now={0} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Line({
  label,
  was,
  now,
  note,
  strong,
  inset,
}: {
  label: string;
  was: number;
  now: number;
  note?: string;
  strong?: boolean;
  inset?: boolean;
}) {
  const changed = Math.round((now - was) * 100) !== 0;
  return (
    <tr className={`border-b border-line/40 ${changed ? "" : "text-fg-muted"}`}>
      <td className={`py-1.5 text-left ${inset ? "pl-8 pr-4 text-xs" : "px-4"}`}>
        <span className={strong ? "font-medium text-fg" : undefined}>{label}</span>
        {note && <div className="text-xs text-fg-muted">{note}</div>}
      </td>
      <td className="px-2 py-1.5 tabular-nums">{moneyOrDash(was)}</td>
      <td className={`px-2 py-1.5 tabular-nums ${changed ? "text-fg" : ""}`}>
        {moneyOrDash(now)}
      </td>
      <td
        className={`px-4 py-1.5 tabular-nums ${
          !changed ? "" : now > was ? "text-sand" : "text-alert"
        }`}
      >
        {delta(Math.round((now - was) * 100) / 100)}
      </td>
    </tr>
  );
}
