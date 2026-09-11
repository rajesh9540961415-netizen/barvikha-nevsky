import Nav from "@/components/Nav";
import { требоватьВладельца } from "@/lib/db/managers";
import { вознаграждение, ЮРЛИЦА } from "@/lib/db/boss";
import { dayLabel, money, moment, plural } from "@/lib/format";

export const dynamic = "force-dynamic";

const МЕСЯЦЫ = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/** «2026-07» → «июль 2026». Null — месяц не назван. */
function названиеМесяца(м: string | null): string {
  if (!м) return "месяц не назван";
  const [год, номер] = м.split("-");
  return `${МЕСЯЦЫ[Number(номер) - 1]} ${год}`;
}

/**
 * Вознаграждение босса: что выведено, за какой месяц и с каких юрлиц.
 *
 * Задача владельца 11.09.2026: «месяц, за который мы заплатили, общая сумма,
 * с каких юридических лиц какие суммы были выведены».
 *
 * 🔴 **Строки — это месяцы, ЗА которые платили, а не месяцы платежей.**
 * Разница не косметическая: за июль 2026 платили пятью платежами с 22 июля
 * по 8 сентября, и часть одного сентябрьского платежа тоже относится к июлю.
 * Сложи по датам платежей — получится три разных месяца вместо одного.
 *
 * ⚠️ **«Месяц не назван» — отдельной строкой внизу, и размазывать его
 * по месяцам нельзя.** Это выплаты, про которые владелец ещё не сказала,
 * за что они. Догадка, выданная за факт, стоит здесь миллионы: на 11.09.2026
 * месяц известен у восьми выплат из ста десяти.
 */
export default async function BossPage() {
  await требоватьВладельца();
  const д = await вознаграждение();

  if (д.выплаты.length === 0) {
    return (
      <>
        <Nav раздел="boss" />
        <main className="mx-auto max-w-5xl px-6 py-8">
          <h1 className="text-2xl font-medium">Вознаграждение босса</h1>
          <p className="mt-3 text-sm text-fg-muted">
            Выплат пока нет. Их присылает с компьютера владельца{" "}
            <code className="text-fg">scripts/boss_push.py</code>.
          </p>
        </main>
      </>
    );
  }

  const юрлица = ЮРЛИЦА.filter((ю) => д.поЮрлицамВсего[ю.ключ]);

  return (
    <>
      <Nav раздел="boss" />
      <main className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="text-2xl font-medium">Вознаграждение босса</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Что выведено, за какой месяц и с каких юрлиц
        </p>

        <section className="mt-6 rounded-xl border border-line bg-surface px-6 py-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
            Выведено всего
          </p>
          <p className="mt-1 text-4xl font-medium tabular-nums">{money(д.всего)}</p>
          <p className="mt-1 text-xs text-fg-muted">
            {д.платежей} {plural(д.платежей, "выплата", "выплаты", "выплат")}
            {д.безМесяца > 0 && (
              <> · из них без названного месяца {money(д.безМесяца)}</>
            )}
          </p>
        </section>

        {/* ── По месяцам, за которые платили ───────────────────────────── */}
        <h2 className="mt-8 text-lg font-medium">По месяцам, за которые платили</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="text-xs text-fg-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 text-left font-normal">За месяц</th>
                <th className="px-4 py-2 text-right font-normal">Всего</th>
                {юрлица.map((ю) => (
                  <th key={ю.ключ} className="px-4 py-2 text-right font-normal">
                    {ю.подпись}
                  </th>
                ))}
                <th className="px-4 py-2 text-right font-normal">Выплат</th>
              </tr>
            </thead>
            <tbody>
              {д.месяцы.map((м) => (
                <tr key={м.месяц ?? "—"} className="border-b border-line last:border-0">
                  <td className={`px-4 py-2.5 ${м.месяц ? "" : "text-fg-muted"}`}>
                    {названиеМесяца(м.месяц)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{money(м.всего)}</td>
                  {юрлица.map((ю) => (
                    <td key={ю.ключ} className="px-4 py-2.5 text-right tabular-nums text-fg-muted">
                      {/* Прочерк, а не ноль: с этого юрлица в этот месяц
                          не выводили вовсе, и ноль читался бы как расчёт. */}
                      {м.поЮрлицам[ю.ключ] ? money(м.поЮрлицам[ю.ключ]) : "—"}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">
                    {м.выплат}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-line">
                <td className="px-4 py-2.5 font-medium">Итого</td>
                <td className="px-4 py-2.5 text-right font-medium tabular-nums">
                  {money(д.всего)}
                </td>
                {юрлица.map((ю) => (
                  <td key={ю.ключ} className="px-4 py-2.5 text-right font-medium tabular-nums">
                    {money(д.поЮрлицамВсего[ю.ключ] ?? 0)}
                  </td>
                ))}
                <td className="px-4 py-2.5 text-right font-medium tabular-nums">
                  {д.платежей}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {д.безМесяца > 0 && (
          <p className="mt-3 text-xs leading-relaxed text-fg-muted">
            Строка «месяц не назван» — это выплаты, про которые ещё не сказано,
            за какой месяц они. Они не размазаны по месяцам нарочно: пока месяц
            не назван, отнести их куда-либо значит выдать догадку за факт.
          </p>
        )}

        {/* ── Сами выплаты ─────────────────────────────────────────────── */}
        <h2 className="mt-8 text-lg font-medium">Выплаты, свежие сверху</h2>
        <p className="mt-1 text-xs text-fg-muted">
          Платёж, поделённый между месяцами, стоит двумя строками — под суммой
          подписано, из какой выплаты она взята.
        </p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="text-xs text-fg-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 text-left font-normal">Дата</th>
                <th className="px-4 py-2 text-left font-normal">Документ</th>
                <th className="px-4 py-2 text-left font-normal">С кого</th>
                <th className="px-4 py-2 text-right font-normal">Сумма</th>
                <th className="px-4 py-2 text-left font-normal">За месяц</th>
                <th className="px-4 py-2 text-left font-normal">Комментарий</th>
              </tr>
            </thead>
            <tbody>
              {д.выплаты.map((в) => (
                <tr key={`${в.день}-${в.документ}-${в.сумма}`}
                    className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap px-4 py-2.5 align-top text-fg-muted">
                    {dayLabel(в.день)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 align-top tabular-nums text-fg-muted">
                    {в.документ || "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 align-top">
                    {ЮРЛИЦА.find((ю) => ю.ключ === в.юрлицо)?.подпись ?? в.юрлицо}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right align-top tabular-nums">
                    {money(в.сумма)}
                    {/* Делёный платёж стоит двумя строками, и без этой
                        подписи они читаются как две разные выплаты. */}
                    {в.делёный && (
                      <span className="block text-xs text-fg-muted">
                        из {money(в.весьПлатёж)}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 align-top">
                    {в.заМесяц ? названиеМесяца(в.заМесяц)
                               : <span className="text-fg-muted">— не назван</span>}
                  </td>
                  <td className="px-4 py-2.5 align-top text-fg-muted">
                    {в.комментарий ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {д.обновлено && (
          <p className="mt-8 text-xs text-fg-muted">
            Числа обновлены {moment(д.обновлено)}
          </p>
        )}
      </main>
    </>
  );
}
