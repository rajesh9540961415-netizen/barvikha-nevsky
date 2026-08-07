import Link from "next/link";
import type { PersonStats } from "@/lib/db/people";
import { dayLabel, money, moneyOrDash, plural, weekday } from "@/lib/format";
import { THRESHOLD } from "@/lib/split";

/**
 * Динамика одного человека по сменам.
 *
 * Смены не пропадают: вечер, когда заведение работало, а человек — нет,
 * стоит в таблице пустой строкой с пометкой. Требование владельца
 * 07.08.2026, и оно про суть: пятнадцать строк подряд выглядят как
 * пятнадцать смен, а на деле это может быть три смены за месяц.
 */

export default function PersonStatsView({ stats }: { stats: PersonStats }) {
  const { totals, days } = stats;

  return (
    <>
      <section className="mt-6 grid gap-x-8 gap-y-1 rounded-xl border border-line bg-surface px-5 py-4 sm:grid-cols-2">
        <Row
          label="Отработано смен"
          value={`${stats.shiftsWorked} из ${stats.shiftsTotal}`}
          note={
            stats.shiftsTotal > stats.shiftsWorked
              ? `пропущено смен: ${stats.shiftsTotal - stats.shiftsWorked}`
              : "пропусков нет"
          }
          strong
        />
        <Row label="Получено за период" value={money(totals.got)} strong />
        <Row label="чаевые" value={moneyOrDash(totals.cash + totals.terminal + totals.qr)} />
        <Row
          label="начислено как официанту"
          value={moneyOrDash(totals.accrued)}
          note={
            totals.earned > totals.accrued
              ? `заработано ${money(totals.earned)}, отдано долей ${money(totals.earned - totals.accrued)}`
              : undefined
          }
        />
        <Row label="сервисный сбор" value={moneyOrDash(totals.service)} />
        <Row label="доля за роль администратора" value={moneyOrDash(totals.asAdmin)} />
        <Row
          label="средний заработок за смену"
          value={moneyOrDash(stats.avgPerShift)}
          note="считается только по отработанным сменам"
        />
        <Row
          label="в среднем против коллег"
          value={
            stats.avgVsPeers === null
              ? "—"
              : `${stats.avgVsPeers >= 0 ? "+" : "−"}${Math.abs(stats.avgVsPeers)} %`
          }
          note={
            stats.avgVsPeers === null
              ? "не с кем было сравнивать"
              : stats.avgVsPeers >= 0
                ? "собирает больше остальных в те же вечера"
                : "собирает меньше остальных в те же вечера"
          }
        />
        <Row label="доля за роль кассира" value={moneyOrDash(totals.asCashier)} />
      </section>

      {stats.belowThreshold > 0 && (
        <p className="mt-3 rounded-xl border border-line bg-sand/10 px-4 py-2.5 text-sm text-sand">
          {stats.belowThreshold}{" "}
          {plural(stats.belowThreshold, "смена", "смены", "смен")} из{" "}
          {stats.shiftsWorked} — ниже порога {money(THRESHOLD)}. В такие смены
          доли не отдаются, но и заработок мал.
        </p>
      )}

      <h2 className="mt-8 text-sm text-fg-muted">
        По сменам — от свежих к старым. Вечера без этого человека из списка
        не выпадают: иначе десять строк подряд выглядели бы как десять смен,
        а на деле их могло быть три.
      </h2>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-right text-sm">
          <thead className="text-xs text-fg-muted">
            <tr className="border-b border-line">
              <th className="py-2 pr-3 text-left font-normal">смена</th>
              <th className="px-3 py-2 text-left font-normal">роль</th>
              <th className="px-3 py-2 font-normal">наличные</th>
              <th className="px-3 py-2 font-normal">
                терминал<span className="text-sand">*</span>
              </th>
              <th className="px-3 py-2 font-normal">QR</th>
              <th className="px-3 py-2 font-normal">сбор</th>
              <th className="px-3 py-2 font-normal">заработано</th>
              <th className="px-3 py-2 font-normal">получено</th>
              <th className="py-2 pl-3 text-left font-normal">
                против коллег в этот вечер
              </th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr
                key={d.businessDay}
                className={`border-b border-line/40 ${d.worked ? "" : "text-fg-muted"}`}
              >
                <td className="py-1.5 pr-3 text-left">
                  <Link
                    href={`/shift/${d.businessDay}`}
                    className="underline decoration-line underline-offset-4 hover:decoration-sand"
                  >
                    {dayLabel(d.businessDay)}
                  </Link>
                  <span className="ml-2 text-xs text-fg-muted">
                    {weekday(d.businessDay)}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-left text-xs">
                  {d.worked ? (
                    d.roles.length > 0 ? (
                      <span className="text-sand">{d.roles.join(", ")}</span>
                    ) : (
                      "официант"
                    )
                  ) : (
                    "не в смене"
                  )}
                </td>
                <td className="px-3 py-1.5 tabular-nums">{moneyOrDash(d.cash)}</td>
                <td className="px-3 py-1.5 tabular-nums">{moneyOrDash(d.terminal)}</td>
                <td className="px-3 py-1.5 tabular-nums">{moneyOrDash(d.qr)}</td>
                <td className="px-3 py-1.5 tabular-nums">{moneyOrDash(d.service)}</td>
                <td className="px-3 py-1.5 tabular-nums">
                  {moneyOrDash(d.earned)}
                  {d.worked && d.earned > 0 && !d.aboveThreshold && (
                    <div className="text-xs text-fg-muted">ниже порога</div>
                  )}
                </td>
                <td className="px-3 py-1.5 tabular-nums text-sand">
                  {moneyOrDash(d.got)}
                </td>
                <td className="py-1.5 pl-3">
                  <Versus value={d.vsPeers} peers={d.peers} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-sm text-fg-muted">
        «Заработано» — чаевые и сервисный сбор до долей администратору
        и кассиру. «Получено» — что причитается: начисленное как официанту
        плюс доли за роль администратора или кассира. Питание сюда не входит:
        это вычет при выплате, его считает смена.
      </p>
      {/* Человек, заходящий сюда раз в месяц, увидит в колонке «терминал»
          не ту сумму, которую гость видел на терминале, и решит, что цифра
          неверная. Показываем настоящие рубли за период, а не общее
          «удерживается комиссия». */}
      {totals.commission > 0 && (
        <p className="mt-3 text-sm text-fg-muted">
          <span className="text-sand">*</span> По терминалу показано то, что{" "}
          <b className="font-medium text-fg">дошло до человека</b>. Сбер
          удерживает 8 % с получателя: гость оставляет больше, чем доходит.
          За период удержано {money(totals.commission)} — на эту сумму
          у человека и вышло меньше, чем оставили гости.
        </p>
      )}

      <p className="mt-3 text-sm text-fg-muted">
        <b className="font-medium text-fg">Против коллег</b> — на сколько
        процентов человек собрал больше или меньше остальных официантов
        в тот же вечер. Сравнение именно с коллегами, а не с его обычной
        сменой: в слабый вторник мало собирают все, и ставить это в упрёк
        одному нельзя. Людность вечера одинакова для всех, кто в нём работал,
        поэтому из сравнения она вычитается сама. Середина полоски — «ровно
        как у коллег», вправо — больше, влево — меньше.
      </p>
    </>
  );
}

/**
 * На сколько человек собрал больше или меньше коллег в этот же вечер.
 *
 * Полоска расходится от середины: вправо — собрал больше остальных, влево —
 * меньше. Середина — это не ноль рублей, а «ровно столько же, сколько
 * коллеги», поэтому сравнивать строки между собой можно даже когда вечера
 * были совсем разной людности. В том и смысл: людность одинакова для всех,
 * кто работал в этот вечер, и из сравнения она вычитается сама.
 *
 * Шкала обрезана на ±100 %: собрать вдвое больше среднего — уже очень много,
 * и растягивать ось ради одного выброса значит сплющить все остальные дни.
 */
function Versus({ value, peers }: { value: number | null; peers: number | null }) {
  if (value === null) {
    return (
      <span className="text-xs text-fg-muted">
        {peers === null ? "не с кем сравнить" : "—"}
      </span>
    );
  }

  const capped = Math.max(-100, Math.min(100, value));
  const width = Math.abs(capped) / 2;
  const up = value >= 0;

  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2 w-24 rounded-full bg-line/50">
        <div className="absolute left-1/2 top-0 h-2 w-px bg-fg-muted/60" />
        <div
          className={`absolute top-0 h-2 ${up ? "rounded-r-full bg-sand" : "rounded-l-full bg-alert"}`}
          style={
            up
              ? { left: "50%", width: `${width}%` }
              : { right: "50%", width: `${width}%` }
          }
        />
      </div>
      <span className={`text-xs tabular-nums ${up ? "text-sand" : "text-alert"}`}>
        {up ? "+" : "−"}
        {Math.abs(value)} %
      </span>
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
  value: string;
  note?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/40 py-1.5">
      <div>
        <span className={strong ? "" : "text-sm text-fg-muted"}>{label}</span>
        {note && <div className="text-xs text-fg-muted">{note}</div>}
      </div>
      <span className={`tabular-nums ${strong ? "text-lg" : "text-sm"}`}>{value}</span>
    </div>
  );
}
