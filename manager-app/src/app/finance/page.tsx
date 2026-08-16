import { Fragment } from "react";
import Link from "next/link";
import Nav from "@/components/Nav";
import { финансыЗаМесяц, type ДоляЮрлица } from "@/lib/db/finance";
import { money } from "@/lib/format";

export const dynamic = "force-dynamic";

const МЕСЯЦЫ = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/** Якорь строки: только латиница и цифры — в id кириллица и косая черта ни к чему. */
function кусокАдреса(статья: string): string {
  return "s" + Array.from(статья).reduce((h, c) => (h * 31 + c.codePointAt(0)!) % 1e9, 7);
}

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
 * 16.08.2026 по просьбе владельца верх переделан: вместо пяти плиток подряд —
 * два блока, выручка и расходы, каждый с разбивкой по юрлицам. «Поступления
 * по банку», «Без вознаграждения» и «Вознаграждение» убраны: первое — деньги
 * в пути, а не заработок, вторые два владелец решила вынести отдельной
 * страницей.
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
  const юрлицо = параметры.юрлицо || null;

  // Какие статьи раскрыты — в самом адресе, а не в памяти браузера.
  //
  // 💡 Так раскрытая таблица переживает обновление страницы, ложится
  // в закладку и отправляется ссылкой. Держи мы это состояние на клиенте,
  // экран пришлось бы делать клиентским целиком — ради галочки, которая
  // и так прекрасно выражается адресом.
  const раскрыто = (параметры.раскрыть ?? "")
    .split(",")
    .map((с) => decodeURIComponent(с.trim()))
    .filter(Boolean);

  const д = await финансыЗаМесяц(месяц, юрлицо, раскрыто);

  const наличные = д.источники.find((и) => и.source === "cash");
  const банк = д.источники.find((и) => и.source === "bank");

  const расходыВсего = д.расходыПоЮрлицам.reduce((s, ю) => s + ю.сумма, 0);
  const выручкаВрозь = д.выручкаПоЮрлицам.reduce((s, ю) => s + ю.сумма, 0);
  // Разбивка обязана складываться в итог. Итог берётся из fin_days, разбивка
  // из fin_revenue — это два разных источника, и молчаливое расхождение между
  // ними означало бы, что одна касса попала в один и не попала в другой.
  const выручкаНеСходится =
    д.выручкаПоЮрлицам.length > 0 && Math.abs(выручкаВрозь - д.итоги.выручка) > 1;

  // Ссылка сохраняет месяц: переключая юрлицо, владелец остаётся в том же
  // месяце, а не улетает в текущий.
  const ссылка = (ю: string | null) =>
    `/finance?месяц=${месяц}${ю ? `&юрлицо=${encodeURIComponent(ю)}` : ""}` +
    (раскрыто.length ? `&раскрыть=${раскрыто.map(encodeURIComponent).join(",")}` : "");

  /** Адрес, в котором эта статья раскрыта или, наоборот, свёрнута. */
  const переключить = (статья: string) => {
    const стало = раскрыто.includes(статья)
      ? раскрыто.filter((с) => с !== статья)
      : [...раскрыто, статья];
    return (
      `/finance?месяц=${месяц}` +
      (юрлицо ? `&юрлицо=${encodeURIComponent(юрлицо)}` : "") +
      (стало.length ? `&раскрыть=${стало.map(encodeURIComponent).join(",")}` : "") +
      // Возврат к той же строке: без якоря длинная таблица после нажатия
      // прыгает в начало, и владелец теряет место, куда смотрела.
      `#${кусокАдреса(статья)}`
    );
  };

  return (
    <>
      <Nav раздел="finance" />
      <main className="mx-auto max-w-[1600px] px-6 py-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-medium">Финансы · {названиеМесяца(месяц)}</h1>
          <p className="mt-1 text-fg-muted">
            Движение денежных средств: что пришло, что ушло, по дням
          </p>
        </div>
        {/* Только соседние месяцы. Ссылка на другие разделы теперь в шапке —
            держать её ещё и здесь значило бы иметь два разных пути к одному
            и тому же и ни одного очевидного. */}
        <div className="flex items-baseline gap-5">
          <Link href={`/finance?месяц=${сдвиг(месяц, -1)}`} className="text-sand underline">
            ← {названиеМесяца(сдвиг(месяц, -1))}
          </Link>
          <Link href={`/finance?месяц=${сдвиг(месяц, 1)}`} className="text-sand underline">
            {названиеМесяца(сдвиг(месяц, 1))} →
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
          <div className="mt-6 grid gap-x-16 gap-y-6 border-y border-line py-5 sm:grid-cols-2">
            <Блок
              подпись="Выручка"
              итог={д.итоги.выручка}
              доли={д.выручкаПоЮрлицам}
              главный
            />
            <Блок подпись="Расходы" итог={расходыВсего} доли={д.расходыПоЮрлицам} />
          </div>

          {/* Что внутри «Расходов», кроме собственно расходов.
              ⚠️ Плиток из этого не делаем — владелец 16.08.2026 просила убрать
              «Вознаграждение» и «Без вознаграждения» наверх отдельной страницей
              позже. Но и молчать нельзя: до этого дня вывод собственнику
              показывался строкой «Не опознано», а заимствования не показывались
              вовсе. Поэтому две тихие строки, а не плитки. */}
          {(д.итоги.вывод > 0 || д.итоги.заимствования > 0) && (
            <p className="mt-3 text-sm text-fg-muted">
              В расходах: {д.итоги.вывод > 0 && (
                <>вывод собственнику {money(д.итоги.вывод)}</>
              )}
              {д.итоги.вывод > 0 && д.итоги.заимствования > 0 && " · "}
              {д.итоги.заимствования > 0 && (
                <span className="text-alert">
                  заимствования между площадками {money(д.итоги.заимствования)}
                </span>
              )}
            </p>
          )}

          {выручкаНеСходится && (
            <p className="mt-3 text-sm text-alert">
              Разбивка выручки по юрлицам даёт {money(выручкаВрозь)}, а всего
              за месяц {money(д.итоги.выручка)}. Состав не сходится с итогом —
              значит какая-то касса попала в один расчёт и не попала в другой.
            </p>
          )}

          {/* Переключатель юрлиц. Меняет только таблицу ниже: блоки сверху
              остаются целыми, иначе не с чем было бы сверить часть. */}
          {д.ктоЕсть.length > 1 && (
            <div className="mt-6 flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="text-fg-muted">Расходы:</span>
              <Кнопка href={ссылка(null)} выбрана={!д.выбрано}>
                все
              </Кнопка>
              {д.ктоЕсть.map((к) => (
                <Кнопка key={к.ключ} href={ссылка(к.ключ)} выбрана={д.выбрано === к.ключ}>
                  {к.подпись}
                </Кнопка>
              ))}
            </div>
          )}

          <div className="mt-4 overflow-x-auto">
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
                {д.строки.map((с) => {
                  const раскрыта = раскрыто.includes(с.статья);
                  return (
                  <Fragment key={с.статья}>
                  <tr id={кусокАдреса(с.статья)} className="border-b border-line/40">
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
                      {/* ⚠️ Статья РАСКРЫВАЕТСЯ на месте, а не уводит на другую
                          страницу. Владелец 16.08.2026: отдельная страница
                          показывает суммы за месяц и теряет главное — в какой
                          день кому платили. Здесь контрагенты встают теми же
                          столбцами дней, и обе вещи видны разом. */}
                      <Link
                        href={переключить(с.статья)}
                        scroll={false}
                        className="hover:text-sand hover:underline"
                      >
                        <span className="inline-block w-3 text-fg-muted">
                          {раскрыта ? "▾" : "▸"}
                        </span>{" "}
                        {с.статья}
                      </Link>
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

                  {раскрыта && с.контрагенты.map((к) => (
                    <tr key={с.статья + "|" + к.контрагент} className="border-b border-line/20 text-fg-muted">
                      <td className="sticky left-0 z-10 min-w-56 bg-ink py-1.5 pr-4 pl-6 text-left text-xs">
                        {к.контрагент}
                      </td>
                      {д.дни.map((день) => (
                        <td key={день} className="px-2 py-1.5 text-xs tabular-nums">
                          {к.поДням[день]
                            ? Math.round(к.поДням[день]).toLocaleString("ru-RU")
                            : ""}
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-2 py-1.5 pl-6 text-xs tabular-nums">
                        {money(к.итог)}
                      </td>
                    </tr>
                  ))}

                  {раскрыта && (
                    <tr className="border-b border-line/40">
                      <td colSpan={д.дни.length + 2} className="py-1.5 pl-6 text-left text-xs text-fg-muted">
                        контрагентов {с.контрагенты.length} ·{" "}
                        <Link
                          href={`/finance/article?месяц=${месяц}&статья=${encodeURIComponent(с.статья)}`}
                          className="underline hover:text-sand"
                        >
                          открыть страницей — там же разбивка по юрлицам
                        </Link>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
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

          {д.выбрано && (
            <p className="mt-3 text-sm text-fg-muted">
              Показаны расходы только по одному юрлицу — {money(д.итоги.расходы)}{" "}
              из {money(расходыВсего)} за месяц.{" "}
              <Link href={ссылка(null)} className="text-sand underline">
                показать все
              </Link>
            </p>
          )}

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
    </>
  );
}

/**
 * Итог месяца с разбивкой по юрлицам.
 *
 * ⚠️ Строка «нет данных» пишется словами, а не нулём. У ИП Шалаевой выписки
 * за август не загружены — ноль там читался бы как «ничего не тратила»,
 * и это была бы уверенная ложь.
 */
function Блок({
  подпись,
  итог,
  доли,
  главный,
}: {
  подпись: string;
  итог: number;
  доли: ДоляЮрлица[];
  главный?: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-6 border-b border-line/40 pb-1">
        <span className="text-sm text-fg-muted">{подпись}</span>
        <span className={`tabular-nums text-lg ${главный ? "text-sand" : ""}`}>
          {money(итог)}
        </span>
      </div>
      <dl className="mt-2 space-y-1 text-sm">
        {доли.map((ю) => (
          <div key={ю.юрлицо} className="flex items-baseline justify-between gap-6">
            <dt className="text-fg-muted">{ю.подпись}</dt>
            <dd className={`tabular-nums ${ю.нетДанных ? "text-alert" : ""}`}>
              {ю.нетДанных ? "нет данных" : money(ю.сумма)}
            </dd>
          </div>
        ))}
        {доли.length === 0 && (
          <div className="text-fg-muted">разбивки по юрлицам за этот месяц нет</div>
        )}
      </dl>
    </div>
  );
}

function Кнопка({
  href,
  выбрана,
  children,
}: {
  href: string;
  выбрана: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded px-2 py-0.5 ${
        выбрана ? "bg-sand/20 text-sand" : "text-fg-muted hover:text-sand"
      }`}
    >
      {children}
    </Link>
  );
}
