import Link from "next/link";
import Nav from "@/components/Nav";
import Ставки from "@/components/Ставки";
import { требоватьСмену } from "@/lib/db/managers";
import { месяцыСПродажами, продажиМесяца, ставки as ставкиИзБазы } from "@/lib/db/hookah";
import { КАТЕГОРИИ, СТАВКИ_ПО_УМОЛЧАНИЮ, посчитать } from "@/lib/hookahMotivation";
import { dayLabel, money, plural } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Мотивация кальянного бара: сколько бар заработал сверх оклада.
 *
 * Ставки владельца 06.09.2026 — рубли за штуку, мотивация ОБЩАЯ НА СМЕНУ.
 * Поимённо не делим: решение владельца 22.08.2026, подтверждённое 07.09.
 *
 * 🔴 **Страница ничего не решает, она показывает.** Категория позиции и то,
 * за что положена доплата, приезжают готовыми с Мака: доплата за «ЧМ»
 * полагается только в комплекте с электронной чашей, а комплект виден
 * по составу чека, которого на сервере нет. 08.09.2026 три ошибки счёта
 * выросли из того, что одно правило жило в двух местах, — третьего места
 * здесь не будет.
 *
 * 💡 **Позиции внутри категории показываем нарочно.** Владелец 08.09.2026
 * поймала ошибку именно так: сверила число парфюм-чаш с отчётом
 * администратора. Сумму, которую нельзя разложить обратно на конкретные
 * кальяны, проверить нечем.
 */
export default async function MotivaciyaPage({
  searchParams,
}: {
  searchParams: Promise<{ месяц?: string }>;
}) {
  await требоватьСмену();
  const { месяц: выбран } = await searchParams;

  const месяцы = await месяцыСПродажами();
  const месяц = выбран && месяцы.includes(выбран) ? выбран : месяцы[0];

  if (!месяц) {
    return (
      <>
        <Nav раздел="motivaciya" />
        <main className="mx-auto max-w-5xl px-6 py-8">
          <h1 className="text-2xl font-medium">Мотивация кальянного бара</h1>
          <p className="mt-8 text-fg-muted">
            Продаж пока нет. Их присылает счётчик на компьютере владельца —
            команда <code className="text-fg">hookah_push.py --залить</code>.
          </p>
        </main>
      </>
    );
  }

  const [продажи, ставкиСейчас] = await Promise.all([
    продажиМесяца(месяц),
    ставкиИзБазы(),
  ]);
  const действующие: Record<string, number> = { ...СТАВКИ_ПО_УМОЛЧАНИЮ, ...ставкиСейчас };
  const { поКатегориям, всего, штукВсего } = посчитать(продажи, действующие);

  // По дням считаем ТОЙ ЖЕ функцией, а не отдельной формулой: две формулы
  // для одного числа однажды разойдутся, и разойдутся молча.
  const дни = [...new Set(продажи.map((п) => п.day))].sort().reverse();
  const поДням = дни.map((день) => ({
    день,
    ...посчитать(продажи.filter((п) => п.day === день), действующие),
  }));

  return (
    <>
      <Nav раздел="motivaciya" />
      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <h1 className="text-2xl font-medium">Мотивация кальянного бара</h1>
          <div className="flex flex-wrap gap-1">
            {месяцы.map((м) => (
              <Link
                key={м}
                href={`/motivaciya?месяц=${м}`}
                aria-current={м === месяц ? "page" : undefined}
                className={
                  "rounded-md px-2.5 py-1 text-sm transition-colors " +
                  (м === месяц
                    ? "bg-sand/15 font-medium text-sand"
                    : "text-fg-muted hover:bg-line/40 hover:text-fg")
                }
              >
                {м}
              </Link>
            ))}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
          <div className="bg-surface p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
              К доплате за месяц
            </p>
            <p className="mt-2 text-2xl font-medium leading-none tabular-nums">{money(всего)}</p>
            <p className="mt-1.5 text-xs text-fg-muted">общая на смену, не поимённо</p>
          </div>
          <div className="bg-surface p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
              Кальянов с доплатой
            </p>
            <p className="mt-2 text-2xl font-medium leading-none tabular-nums">
              {штукВсего.toLocaleString("ru-RU")}
            </p>
            <p className="mt-1.5 text-xs text-fg-muted">возвраты уже вычтены</p>
          </div>
          <div className="bg-surface p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
              Смен в месяце
            </p>
            <p className="mt-2 text-2xl font-medium leading-none tabular-nums">{дни.length}</p>
            <p className="mt-1.5 text-xs text-fg-muted">
              в среднем {money(дни.length ? всего / дни.length : 0)} за смену
            </p>
          </div>
        </div>

        <h2 className="mt-8 text-lg font-medium">По типам кальянов</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-right text-sm">
            <thead className="text-fg-muted">
              <tr className="border-b border-line">
                <th className="p-3 text-left font-medium">тип</th>
                <th className="p-3 font-medium">штук</th>
                <th className="p-3 font-medium">ставка</th>
                <th className="p-3 font-medium">к доплате</th>
              </tr>
            </thead>
            <tbody>
              {поКатегориям.map((к) => (
                <tr key={к.категория} className="border-b border-line/60 align-top last:border-0">
                  <td className="p-3 text-left">
                    <span className={к.штук ? "" : "text-fg-muted"}>{к.категория}</span>
                    {к.позиции.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-xs text-fg-muted">
                        {к.позиции.map((п) => (
                          <li key={п.позиция}>
                            {п.штук.toLocaleString("ru-RU")} × {п.позиция}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="p-3 tabular-nums">{к.штук.toLocaleString("ru-RU")}</td>
                  <td className="p-3 tabular-nums text-fg-muted">{money(к.ставка)}</td>
                  <td className="p-3 tabular-nums">{money(к.мотивация)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line font-medium">
                <td className="p-3 text-left">Итого</td>
                <td className="p-3 tabular-nums">{штукВсего.toLocaleString("ru-RU")}</td>
                <td />
                <td className="p-3 tabular-nums">{money(всего)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <h2 className="mt-8 text-lg font-medium">По сменам</h2>
        <p className="mt-1 text-xs text-fg-muted">
          Смена идёт с 11:00 до 10:59 следующего дня — ночные кальяны принадлежат
          вечеру, а не утру.
        </p>
        <div className="mt-3 overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-right text-sm">
            <thead className="text-fg-muted">
              <tr className="border-b border-line">
                <th className="p-3 text-left font-medium">смена</th>
                <th className="p-3 font-medium">кальянов</th>
                <th className="p-3 font-medium">к доплате</th>
              </tr>
            </thead>
            <tbody>
              {поДням.map((д) => (
                <tr key={д.день} className="border-b border-line/60 last:border-0">
                  <td className="p-3 text-left">{dayLabel(д.день)}</td>
                  <td className="p-3 tabular-nums">{д.штукВсего.toLocaleString("ru-RU")}</td>
                  <td className="p-3 tabular-nums">{money(д.всего)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="mt-8 text-lg font-medium">Ставки</h2>
        <p className="mt-1 text-xs text-fg-muted">
          Рубли за штуку. Меняются здесь и сразу пересчитывают все месяцы —
          страница показывает то, что причитается по СЕГОДНЯШНИМ ставкам.
        </p>
        <Ставки категории={КАТЕГОРИИ} ставки={действующие} />

        <p className="mt-8 text-xs text-fg-muted">
          Категорию и то, за что положена доплата, считает счётчик на компьютере
          владельца: доплата за «Чемпионат мира» полагается только в комплекте
          с электронной чашей, а комплект виден по составу чека.
        </p>
      </main>
    </>
  );
}
