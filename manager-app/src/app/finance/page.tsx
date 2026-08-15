import Link from "next/link";
import { финансыЗаМесяц } from "@/lib/db/finance";
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

function сдвиг(месяц: string, на: number): string {
  const [год, м] = месяц.split("-").map(Number);
  const d = new Date(год, м - 1 + на, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** «6 авг» — короткая подпись столбца: в 31 столбец длинная не влезет. */
function короткийДень(день: string): string {
  const [, , число] = день.split("-");
  return String(Number(число));
}

/**
 * Финансы: месяц в форме ДДС. Экран владельца.
 *
 * Форма выбрана владельцем 15.08.2026: расходы стоят по дням, а не свалены
 * в месяц. Из этого ритма строится план платежей — видно, что 10-е зарплата,
 * 15-е и 25-е аренда, 28-е налоги.
 *
 * Право смотреть спрашивается не здесь, а внутри `финансыЗаМесяц`: страница
 * может забыть спросить, а данные — нет. Тот же приём, что у экрана доступа.
 *
 * ⚠️ Таблица широкая нарочно — 31 столбец, по столбцу на день. Это и есть
 * форма ДДС; сворачивать её в недели значило бы потерять то единственное,
 * ради чего она выбрана. Первый столбец закреплён, остальное прокручивается.
 */
export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | undefined }>;
}) {
  const параметры = await searchParams;
  const сейчас = new Date();
  const поумолчанию = `${сейчас.getFullYear()}-${String(сейчас.getMonth() + 1).padStart(2, "0")}`;
  const месяц = /^\d{4}-\d{2}$/.test(параметры.месяц ?? "") ? параметры.месяц! : поумолчанию;

  const д = await финансыЗаМесяц(месяц);

  const наличные = д.источники.find((и) => и.source === "cash");
  const банк = д.источники.find((и) => и.source === "bank");

  return (
    <main className="mx-auto max-w-[1600px] px-6 py-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-medium">Финансы · {названиеМесяца(месяц)}</h1>
          <p className="mt-1 text-fg-muted">
            Движение денежных средств: что пришло, что ушло, по дням
          </p>
        </div>
        <div className="flex items-baseline gap-5">
          <Link href={`/finance?месяц=${сдвиг(месяц, -1)}`} className="text-sand underline">
            ← {названиеМесяца(сдвиг(месяц, -1))}
          </Link>
          <Link href={`/finance?месяц=${сдвиг(месяц, 1)}`} className="text-sand underline">
            {названиеМесяца(сдвиг(месяц, 1))} →
          </Link>
          <Link href="/" className="text-fg-muted underline">
            смены
          </Link>
        </div>
      </header>

      {/* ⚠️ Про свежесть источников — до таблицы, а не сноской под ней.
          Банк доведён до вчера, а наличные ведутся руками в Google-таблице
          и отстают. Показать их рядом молча значило бы соврать: читатель
          решит, что видит месяц целиком. */}
      <p className="mt-4 text-sm text-fg-muted">
        Банк заполнен по {банк?.filledTo ?? "—"}
        {наличные && (
          <>
            {" · "}
            <span className="text-alert">наличные — только по {наличные.filledTo}</span>
          </>
        )}
      </p>

      {д.пусто ? (
        <p className="mt-8 text-fg-muted">
          За этот месяц данных нет. Отправить их с компьютера:{" "}
          <code className="text-sand">python3 scripts/fin_push.py {месяц}</code>
        </p>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap gap-x-10 gap-y-2 border-y border-line py-4">
            <Итог подпись="Выручка" сумма={д.итоги.выручка} />
            <Итог подпись="Поступления по банку" сумма={д.итоги.поступления} />
            <Итог подпись="Расходы" сумма={д.итоги.расходы} />
            <Итог подпись="Без вознаграждения" сумма={д.итоги.безВознаграждения} главный />
            <Итог подпись="Вознаграждение" сумма={д.итоги.вознаграждение} />
          </div>

          <div className="mt-6 overflow-x-auto">
            <table className="border-collapse text-right text-sm">
              <thead className="text-fg-muted">
                <tr className="border-b border-line">
                  <th className="sticky left-0 z-10 min-w-56 whitespace-nowrap bg-ink py-2 pr-4 text-left font-normal">
                    статья
                  </th>
                  {/* Число дня — ссылка на разбор этого дня по контрагентам.
                      Это и есть блок 3 формы владельца, который в Excel
                      приходится искать глазами. */}
                  {д.дни.map((день) => (
                    <th key={день} className="min-w-14 px-2 py-2 font-normal">
                      <Link href={`/finance/${день}`} className="hover:text-sand hover:underline">
                        {короткийДень(день)}
                      </Link>
                    </th>
                  ))}
                  <th className="min-w-36 whitespace-nowrap px-2 py-2 pl-6 font-normal">за месяц</th>
                </tr>
              </thead>
              <tbody>
                {д.строки.map((с) => (
                  <tr key={с.статья} className="border-b border-line/40">
                    <td
                      className={`sticky left-0 z-10 min-w-56 whitespace-nowrap bg-ink py-2 pr-4 text-left ${
                        с.неизвестная || с.неопознанная ? "text-alert" : ""
                      }`}
                      title={
                        с.неопознанная
                          ? "Платежи, статью которых определить не удалось. Это не «прочие расходы»: тут неизвестно, за что ушли деньги."
                          : с.неизвестная
                            ? "Этой статьи нет в списке порядка. Показана отдельно, чтобы деньги не потерялись."
                            : undefined
                      }
                    >
                      {с.статья}
                      {(с.неизвестная || с.неопознанная) && " ←"}
                    </td>
                    {д.дни.map((день) => (
                      <td key={день} className="px-2 py-2 tabular-nums">
                        {с.поДням[день]
                          ? Math.round(с.поДням[день]).toLocaleString("ru-RU")
                          : ""}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-2 py-2 pl-6 tabular-nums text-fg">
                      {money(с.итог)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line font-medium">
                  <td className="sticky left-0 z-10 min-w-56 whitespace-nowrap bg-ink py-2 pr-4 text-left">итого</td>
                  {д.дни.map((день) => {
                    const заДень = д.строки.reduce((s, с) => s + (с.поДням[день] ?? 0), 0);
                    return (
                      <td key={день} className="px-2 py-2 tabular-nums">
                        {заДень ? Math.round(заДень).toLocaleString("ru-RU") : ""}
                      </td>
                    );
                  })}
                  <td className="whitespace-nowrap px-2 py-2 pl-6 tabular-nums">{money(д.итоги.расходы)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {д.строки.some((с) => с.неопознанная) && (
            <p className="mt-4 text-sm text-alert">
              «Не опознано» — платежи, статью которых определить не удалось.
              Это не «прочие расходы»: там статья есть и она осознанная, а здесь
              неизвестно, за что ушли деньги. Разбирается правилами в{" "}
              <code>scripts/fin_articles.py</code>.
            </p>
          )}
          {д.строки.some((с) => с.неизвестная) && (
            <p className="mt-2 text-sm text-alert">
              Прочие строки со стрелкой — статьи, которых нет в списке порядка
              (<code>ARTICLES</code> в <code>scripts/fin_articles.py</code>).
              Показаны отдельно нарочно: лучше нарушенный порядок, чем молча
              пропавшие деньги.
            </p>
          )}
        </>
      )}
    </main>
  );
}

function Итог({
  подпись,
  сумма,
  главный,
}: {
  подпись: string;
  сумма: number;
  главный?: boolean;
}) {
  return (
    <div>
      <div className="text-sm text-fg-muted">{подпись}</div>
      <div className={`tabular-nums ${главный ? "text-lg text-sand" : "text-lg"}`}>
        {money(сумма)}
      </div>
    </div>
  );
}
