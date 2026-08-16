import Link from "next/link";
import { notFound } from "next/navigation";
import { статьяЗаМесяц } from "@/lib/db/finance";
import { money } from "@/lib/format";

export const dynamic = "force-dynamic";

const МЕСЯЦЫ = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

function названиеМесяца(месяц: string): string {
  const [год, м] = месяц.split("-").map(Number);
  return `${МЕСЯЦЫ[м - 1]} ${год}`;
}

/**
 * Финансы: одна статья расходов за месяц. Экран владельца.
 *
 * Просьба владельца 16.08.2026: в таблице месяца видно «Кухня 1 200 000 ₽»,
 * а кому именно эти деньги ушли — приходится искать глазами по выписке.
 * Здесь статья открывается нажатием и показывает контрагентов.
 *
 * ⚠️ Название статьи едет параметром запроса, а не сегментом адреса. Сегмент
 * с кириллицей роняет страницу ещё до разметки — Next.js делает из имени
 * сегмента идентификатор. Поэтому папка `article`, а «Аренда/коммуналка»
 * в `?статья=`. Заодно это снимает вопрос с косой чертой внутри названия:
 * в сегменте она разделила бы адрес надвое.
 *
 * Право смотреть спрашивается внутри `статьяЗаМесяц`, а не здесь.
 */
export default async function СтатьяФинансов({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | undefined }>;
}) {
  const параметры = await searchParams;
  const месяц = параметры.месяц ?? "";
  const статья = параметры.статья ?? "";
  if (!/^\d{4}-\d{2}$/.test(месяц) || !статья) notFound();

  const д = await статьяЗаМесяц(месяц, статья);

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-medium">{статья}</h1>
          <p className="mt-1 text-fg-muted">
            Кому платили · {названиеМесяца(месяц)}
          </p>
        </div>
        {/* ⚠️ Подпись говорит «назад», а не «весь месяц». Владелец 16.08.2026:
            по прежней подписи непонятно, как вернуться — она читалась как
            другой разрез, а не как выход со страницы. Название места, откуда
            пришли, тут не помогает: помогает слово «назад». */}
        <Link href={`/finance?месяц=${месяц}`} className="text-fg-muted underline">
          ← назад к таблице
        </Link>
      </header>

      {д.пусто ? (
        <p className="mt-8 text-fg-muted">
          За {названиеМесяца(месяц)} по этой статье платежей нет.
        </p>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-baseline gap-x-10 gap-y-2 border-y border-line py-4">
            <div>
              <div className="text-sm text-fg-muted">Всего за месяц</div>
              <div className="text-lg tabular-nums text-sand">{money(д.итог)}</div>
            </div>
            {д.поЮрлицам.map((ю) => (
              <div key={ю.юрлицо}>
                <div className="text-sm text-fg-muted">{ю.подпись}</div>
                <div className="text-lg tabular-nums">{money(ю.сумма)}</div>
              </div>
            ))}
          </div>

          <table className="mt-6 w-full border-collapse text-sm">
            <thead className="text-fg-muted">
              <tr className="border-b border-line">
                <th className="py-2 pr-4 text-left font-normal">контрагент</th>
                <th className="py-2 pr-4 text-left font-normal">юрлицо</th>
                <th className="py-2 pr-4 text-right font-normal">платежей</th>
                <th className="py-2 text-right font-normal">за месяц</th>
              </tr>
            </thead>
            <tbody>
              {д.контрагенты.map((к) => (
                <tr key={к.контрагент} className="border-b border-line/40">
                  <td className="py-2 pr-4">{к.контрагент}</td>
                  <td className="py-2 pr-4 text-fg-muted">{к.юрлица.join(", ")}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-fg-muted">
                    {к.платежей}
                  </td>
                  <td className="py-2 text-right tabular-nums">{money(к.сумма)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line font-medium">
                <td className="py-2 pr-4" colSpan={3}>
                  итого · контрагентов {д.контрагенты.length}
                </td>
                <td className="py-2 text-right tabular-nums">{money(д.итог)}</td>
              </tr>
            </tfoot>
          </table>

          <p className="mt-4 text-sm text-fg-muted">
            Наличные расходы контрагента не называют — в Google-таблице
            его поля нет вовсе. Вместо имени там стоит столбец таблицы:
            это и есть указание, кому и за что.
          </p>
        </>
      )}
    </main>
  );
}
