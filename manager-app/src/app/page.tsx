import Link from "next/link";
import { redirect } from "next/navigation";
import Nav from "@/components/Nav";
import { requireManager } from "@/lib/db/managers";
import { money, plural } from "@/lib/format";
import { заПериод, состояние, type Показатели } from "@/lib/db/dashboard";
import {
  затратыЗаПериод, свежестьВыписок,
  type ЗатратыПериода, type СвежестьИсточника,
} from "@/lib/db/finance";

export const dynamic = "force-dynamic";

/**
 * Сводка — первый экран владельца. Название её же: сначала было «Обзор»,
 * 07.09.2026 она выбрала «Сводка».
 *
 * Заведён 07.09.2026 по её задаче: «первая страничка с основными
 * показателями работы заведения». До этого корень бэк-офиса просто
 * перенаправлял на «Финансы», и общей картины не было нигде.
 *
 * Пять блоков — ровно те, что считаются без новых выгрузок: главные числа
 * с ростом год к году, выручка по направлениям, часы суток, дни недели,
 * возвраты и чаевые. Столы, оборачиваемость и повторные гости сюда НЕ вошли
 * сознательно: привязки чека к столу в фискальных данных нет, а рисовать
 * пустой блок — обещать то, чего нет.
 *
 * Числа берутся из `dashboard_days` — живьём из базы. В первой версии того
 * же дня они лежали файлом внутри сборки и обновлялись только с выкладкой;
 * владелец 07.09.2026: «делай живое обновление через базу». Наполняет
 * таблицу `scripts/dashboard_push.py` через служебную дверь `/api/dashboard`.
 *
 * Управляющего сюда не пускаем: сводка — это выручка и прибыль, его экран
 * начинается с чаевых.
 */

/**
 * Цвет закреплён за НАПРАВЛЕНИЕМ, а не за местом в списке.
 *
 * Список отсортирован по сумме, и порядок меняется от периода к периоду:
 * в июне первым был бар, за вчера — кальяны. Крась мы по месту, у бара
 * при каждом переключении менялся бы цвет, и глаз перестал бы узнавать
 * направление без чтения подписи.
 */
const ЦВЕТ_НАПРАВЛЕНИЯ: Record<string, string> = {
  "Бар": "var(--color-chart-1)",
  "Кухня": "var(--color-chart-2)",
  "Кальяны": "var(--color-chart-3)",
  "Аренда VIP": "var(--color-chart-4)",
};

/**
 * Сдвинуть день на столько-то суток.
 *
 * Живёт здесь, а не рядом с чтением из базы: тот файл помечен "use server",
 * и в нём каждый вывоз обязан быть асинхронной функцией. Обычная функция
 * там роняет разом и эту страницу, и служебную дверь, и /api/health.
 */
function сдвинуть(день: string, наДней: number): string {
  const d = new Date(день + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + наДней);
  return d.toISOString().slice(0, 10);
}

const ПЕРИОДЫ = [
  { ключ: "1", подпись: "Вчера", дней: 1 },
  { ключ: "7", подпись: "7 дней", дней: 7 },
  { ключ: "30", подпись: "30 дней", дней: 30 },
  { ключ: "90", подпись: "90 дней", дней: 90 },
  { ключ: "365", подпись: "Год", дней: 365 },
];
const ПО_УМОЛЧАНИЮ = "30";
const ДАТА = /^\d{4}-\d{2}-\d{2}$/;

/** «7 сентября, 13:42» по Москве — время заливки читает человек в Петербурге. */
function когда(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  });
}

/** «12,4 млн» — на плитке важен порядок величины, а не рубль. */
function крупно(v: number): string {
  if (Math.abs(v) >= 1_000_000) {
    return (v / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " млн";
  }
  if (Math.abs(v) >= 10_000) {
    return Math.round(v / 1000).toLocaleString("ru-RU") + " тыс";
  }
  return money(Math.round(v));
}

function Плитка({
  подпись, значение, единица, дельта, пояснение,
}: {
  подпись: string; значение: string; единица?: string;
  дельта?: number | null; пояснение?: string;
}) {
  return (
    <div className="bg-surface p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">{подпись}</p>
      <p className="mt-2 text-2xl font-medium leading-none tabular-nums">
        {значение}
        {единица ? <span className="ml-1 text-base font-normal text-fg-muted">{единица}</span> : null}
      </p>
      {дельта === undefined ? null : дельта === null ? (
        <p className="mt-1.5 text-xs text-fg-muted">не с чем сравнить</p>
      ) : (
        <p className={"mt-1.5 text-xs " + (дельта >= 0 ? "text-sand" : "text-alert")}>
          {дельта >= 0 ? "↑" : "↓"}{" "}
          {Math.abs(дельта).toLocaleString("ru-RU", { maximumFractionDigits: 0 })} %{" "}
          <span className="text-fg-muted">к прошлому году</span>
        </p>
      )}
      {пояснение ? <p className="mt-1.5 text-xs text-fg-muted">{пояснение}</p> : null}
    </div>
  );
}

function Карточка({
  заголовок, пояснение, children,
}: { заголовок: string; пояснение?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">{заголовок}</h2>
        {пояснение ? <p className="text-right text-xs text-fg-muted">{пояснение}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Кольцо «Откуда выручка» с подписями сбоку.
 *
 * Кольцом, а не полосами, — просьба владельца 07.09.2026 по образцу
 * аналитики Quick Resto. Для четырёх долей одного целого это и правда
 * честнее: полосы сравнивают направления между собой, кольцо показывает,
 * из чего складывается выручка.
 *
 * ⚠️ Дуги рисуются штрихом по окружности (`stroke-dasharray`), а не
 * путями с дугами: у путей на долю в 0 % вырождается геометрия и браузер
 * рисует артефакт. Штрих на нулевой длине просто не виден.
 */
const РАДИУС = 64;
const ТОЛЩИНА = 26;
const ОКРУЖНОСТЬ = 2 * Math.PI * РАДИУС;

function Кольцо({
  доли, всего,
}: { доли: { имя: string; сумма: number; доля: number }[]; всего: number }) {
  let пройдено = 0;
  const дуги = доли.map((д) => {
    const длина = (д.доля / 100) * ОКРУЖНОСТЬ;
    const дуга = {
      имя: д.имя,
      цвет: ЦВЕТ_НАПРАВЛЕНИЯ[д.имя] ?? "var(--color-sand-dim)",
      // Зазор в 2 точки между секторами, но только если сектор его переживёт:
      // на доле в полпроцента зазор съел бы её целиком.
      длина: длина > 5 ? длина - 2 : длина,
      смещение: -пройдено,
    };
    пройдено += длина;
    return дуга;
  });

  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-8">
      <svg viewBox="0 0 180 180" className="h-44 w-44 shrink-0" role="img"
           aria-label={"Выручка по направлениям: " +
             доли.map((д) => `${д.имя} ${Math.round(д.доля)} %`).join(", ")}>
        <g transform="rotate(-90 90 90)">
          <circle cx="90" cy="90" r={РАДИУС} fill="none"
                  stroke="var(--color-line)" strokeWidth={ТОЛЩИНА} />
          {дуги.map((д) => (
            <circle
              key={д.имя} cx="90" cy="90" r={РАДИУС} fill="none"
              stroke={д.цвет} strokeWidth={ТОЛЩИНА}
              strokeDasharray={`${д.длина} ${ОКРУЖНОСТЬ - д.длина}`}
              strokeDashoffset={д.смещение}
            />
          ))}
        </g>
        <text x="90" y="84" textAnchor="middle"
              className="fill-[var(--color-fg-muted)] text-[11px] font-medium uppercase tracking-wider">
          всего
        </text>
        <text x="90" y="106" textAnchor="middle"
              className="fill-[var(--color-fg)] text-[19px] font-semibold tabular-nums">
          {крупно(всего)}
        </text>
      </svg>

      <div className="w-full min-w-0 space-y-2.5">
        {доли.map((д) => (
          <div key={д.имя} className="grid grid-cols-[14px_46px_1fr_auto] items-center gap-x-3">
            <span className="h-3 w-3 rounded-sm"
                  style={{ background: ЦВЕТ_НАПРАВЛЕНИЯ[д.имя] ?? "var(--color-sand-dim)" }} />
            <span className="text-sm font-semibold tabular-nums">
              {д.доля.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%
            </span>
            <span className="truncate text-sm text-fg-muted">{д.имя}</span>
            <span className="text-right text-sm font-medium tabular-nums">{money(Math.round(д.сумма))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Насколько выросло. `null` — сравнивать не с чем, а не «ноль». */
function рост(сейчас: number, было: number): number | null {
  if (!было) return null;
  return ((сейчас - было) / было) * 100;
}

function Пусто({ обновлено }: { обновлено: string | null }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-6">
      <h2 className="text-base font-medium">Чисел пока нет</h2>
      <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-fg-muted">
        Дневные итоги считаются на компьютере владельца из фискальных чеков
        и заливаются сюда отдельной командой: до сервера папка с чеками
        не доезжает, а напрямую в базу с Мака не достучаться — мешает VPN.
      </p>
      <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-fg-muted">
        Залить: <code className="text-fg">python3 scripts/dashboard_push.py</code> в папке
        проекта. Если команда ругается на ключ — значит в панели Amvera
        у приложения <span className="text-fg">nevsky-office</span> не задана
        переменная <span className="text-fg">DASHBOARD_KEY</span>.
      </p>
      {обновлено ? (
        <p className="mt-3 text-xs text-fg-muted">
          Последняя заливка была {когда(обновлено)}, но за
          выбранный период данных нет — попробуйте период длиннее.
        </p>
      ) : null}
    </section>
  );
}

export default async function Сводка({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | undefined }>;
}) {
  const manager = await requireManager();
  if (manager.role !== "owner") redirect("/tips");

  const параметры = await searchParams;
  const { первый, последний, обновлено } = await состояние();

  // Свой период: обе даты заданы и разобрались. Одной даты мало — окно
  // с открытым концом пришлось бы чем-то достраивать, и владелец увидела бы
  // не тот отрезок, который просила.
  const свойС = ДАТА.test(параметры.с ?? "") ? параметры.с! : null;
  const свойПо = ДАТА.test(параметры.по ?? "") ? параметры.по! : null;
  const свой = свойС && свойПо && свойС <= свойПо ? { с: свойС, по: свойПо } : null;

  const выбран = свой
    ? null
    : ПЕРИОДЫ.find((п) => п.ключ === параметры.период) ??
      ПЕРИОДЫ.find((п) => п.ключ === ПО_УМОЛЧАНИЮ)!;

  const полоса = (
    <div className="mb-5 flex flex-wrap items-end gap-x-2 gap-y-3">
      {ПЕРИОДЫ.map((п) => (
        <Link
          key={п.ключ}
          href={п.ключ === ПО_УМОЛЧАНИЮ ? "/" : `/?период=${п.ключ}`}
          aria-current={п.ключ === выбран?.ключ ? "page" : undefined}
          className={
            "rounded-full border px-3.5 py-1.5 text-sm transition-colors " +
            (п.ключ === выбран?.ключ
              ? "border-sand bg-sand/15 font-medium text-sand"
              : "border-line text-fg-muted hover:border-sand-dim hover:text-fg")
          }
        >
          {п.подпись}
        </Link>
      ))}

      {/*
        Свои даты — обычная форма с методом GET: она складывает адрес сама,
        и страница остаётся серверной. Ни кнопок на JS, ни библиотеки выбора
        дат: календарь тут и так свой, браузерный.
      */}
      <form method="get" className="ml-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-fg-muted">с</span>
          <input
            type="date" name="с" defaultValue={свой?.с ?? ""}
            min={первый ?? undefined} max={последний ?? undefined}
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-fg
                       focus:border-sand focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-fg-muted">по</span>
          <input
            type="date" name="по" defaultValue={свой?.по ?? ""}
            min={первый ?? undefined} max={последний ?? undefined}
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-fg
                       focus:border-sand focus:outline-none"
          />
        </label>
        <button
          type="submit"
          className={
            "rounded-full border px-3.5 py-1.5 text-sm transition-colors " +
            (свой
              ? "border-sand bg-sand/15 font-medium text-sand"
              : "border-line text-fg-muted hover:border-sand-dim hover:text-fg")
          }
        >
          Показать
        </button>
      </form>
    </div>
  );

  if (!последний) {
    return (
      <>
        <Nav раздел="сводка" />
        <main className="mx-auto max-w-[1600px] px-6 py-6">
          <Пусто обновлено={обновлено} />
        </main>
      </>
    );
  }

  const по = свой ? свой.по : последний;
  const с = свой ? свой.с : сдвинуть(по, -(выбран!.дней - 1));
  const сейчас: Показатели = await заПериод(с, по);
  const было: Показатели = await заПериод(сдвинуть(с, -365), сдвинуть(по, -365));

  if (сейчас.днейСЧеками === 0) {
    return (
      <>
        <Nav раздел="сводка" />
        <main className="mx-auto max-w-[1600px] px-6 py-6">
          {полоса}
          <Пусто обновлено={обновлено} />
        </main>
      </>
    );
  }

  const выручкаВДень = сейчас.дней ? сейчас.выручка / сейчас.дней : 0;
  const затраты: ЗатратыПериода = await затратыЗаПериод(с, по);
  const прибыль = сейчас.выручка - затраты.затраты;
  const маржа = сейчас.выручка ? (прибыль / сейчас.выручка) * 100 : 0;
  // Восемь строк и «остальное»: двадцать статей подряд — это уже не сводка,
  // а таблица, за ней ходят в «Финансы».
  const ГЛАВНЫХ = 8;
  const главные = затраты.статьи.slice(0, ГЛАВНЫХ);
  const остальные = затраты.статьи.slice(ГЛАВНЫХ);
  const остальныеСумма = остальные.reduce((s, а) => s + а.сумма, 0);
  const свежесть: СвежестьИсточника[] = await свежестьВыписок(по);
  // Три дня — обычный ход дела: выписка за пятницу приходит в понедельник,
  // касса перепроверяется руками раз в 7–10 дней. Кричать на этом нельзя,
  // иначе крик перестанут читать. Больше трёх — уже вопрос.
  const ПОРОГ_ОТСТАВАНИЯ = 3;
  const отстают = свежесть.filter((и) => и.отстаёт > ПОРОГ_ОТСТАВАНИЯ);

  return (
    <>
      <Nav раздел="сводка" />
      <main className="mx-auto max-w-[1600px] px-6 py-6">
        {полоса}
        <p className="-mt-2 mb-5 text-xs text-fg-muted">
          {сейчас.с} — {сейчас.по} · сравнение с тем же периодом год назад
        </p>

        {/* ── 1. Главные числа ─────────────────────────────── */}
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
          <Плитка
            подпись="Выручка" значение={крупно(сейчас.выручка)} единица="₽"
            дельта={рост(сейчас.выручка, было.выручка)}
            пояснение="за вычетом возвратов"
          />
          <Плитка
            подпись="Чеков" значение={сейчас.чеков.toLocaleString("ru-RU")}
            дельта={рост(сейчас.чеков, было.чеков)}
          />
          <Плитка
            подпись="Средний чек" значение={money(Math.round(сейчас.среднийЧек))}
            пояснение="с июля — две кассы, с прошлым не сравнивать"
          />
          <Плитка
            подпись="Наличными"
            значение={сейчас.долянала.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}
            единица="%"
            пояснение="остальное — терминал и QR"
          />
          <Плитка
            подпись="В день" значение={крупно(выручкаВДень)} единица="₽"
            пояснение={`${сейчас.дней} ${plural(сейчас.дней, "день", "дня", "дней")} в периоде, из них с чеками ${сейчас.днейСЧеками}`}
          />
        </div>

        {/* ── 1б. Стол и гость ─────────────────────────────────
            Средний чек по чекам про температуру зала врёт: стол платит
            двумя чеками — кухня и бар на одной кассе, кальян на второй.
            За 1–26 августа на чек выходило 4 578 ₽, а на стол — 8 242 ₽.
            Стол здесь — закрытая бронь Рестоплейс, то есть посадка.  */}
        {сейчас.столов > 0 ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-4">
              {/* Столов — первой плиткой, а не подписью под «гостями на стол».
                  Просьба владельца 10.09.2026. Это число, на которое делятся
                  три остальных: не видя его, невозможно понять, посчитаны они
                  по трёмстам посадкам или по трём. */}
              <Плитка
                подпись="Столов"
                значение={сейчас.столов.toLocaleString("ru-RU")}
                пояснение="закрытые посадки Рестоплейс"
              />
              <Плитка
                подпись="Средний чек по столу"
                значение={money(Math.round(сейчас.среднийЧекПоСтолу))}
                пояснение="кухня, бар и кальян одной посадки вместе"
              />
              <Плитка
                подпись="Средний чек на гостя"
                значение={money(Math.round(сейчас.среднийЧекНаГостя))}
                пояснение="не зависит от того, как разбили счёт"
              />
              <Плитка
                подпись="Гостей на стол"
                значение={сейчас.гостейНаСтол.toLocaleString("ru-RU", {
                  minimumFractionDigits: 2, maximumFractionDigits: 2,
                })}
                пояснение={`гостей за период: ${сейчас.гостей.toLocaleString("ru-RU")}`}
              />
            </div>
            {/* Период почти всегда шире того, что знает Рестоплейс: он отдаёт
                скользящее окно в 33 дня, и глубже 27.07.2026 столов нет
                и не будет. Молчать об этом нельзя — иначе три плитки
                выглядят как числа за весь период. */}
            {сейчас.днейСоСтолами < сейчас.дней ? (
              <p className="mt-2 text-xs text-fg-muted">
                Столы известны за {сейчас.днейСоСтолами}{" "}
                {plural(сейчас.днейСоСтолами, "день", "дня", "дней")} из{" "}
                {сейчас.дней} — эти три числа посчитаны только по ним. Раньше
                27 июля 2026 Рестоплейс посадок не отдаёт.
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-3 text-xs text-fg-muted">
            Чек по столу за этот период не посчитать: посадки известны
            начиная с 27 июля 2026.
          </p>
        )}

        {/* ── 2. Откуда выручка ────────────────────────────── */}
        <div className="mt-4">
          <Карточка заголовок="Откуда выручка" пояснение="по позициям чеков">
            <Кольцо доли={сейчас.направления} всего={сейчас.выручка} />
          </Карточка>
        </div>

        {/* ── 3. Затраты и прибыль ─────────────────────────── */}
        <div className="mt-4">
          <Карточка
            заголовок="Затраты и прибыль"
            пояснение="выручка по кассам, затраты по банку и наличным"
          >
            <div className="grid gap-6 lg:grid-cols-[minmax(0,260px)_1fr] lg:gap-10">

              <div className="space-y-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                    Прибыль
                  </p>
                  <p className={"mt-2 text-3xl font-medium leading-none tabular-nums " +
                                (прибыль >= 0 ? "text-fg" : "text-alert")}>
                    {крупно(прибыль)} <span className="text-lg font-normal text-fg-muted">₽</span>
                  </p>
                  <p className="mt-1.5 text-xs text-fg-muted">
                    {маржа.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} % от выручки
                  </p>
                </div>

                <div className="space-y-1.5 border-t border-line pt-4 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-fg-muted">Выручка</span>
                    <span className="tabular-nums">{money(Math.round(сейчас.выручка))}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-fg-muted">Затраты</span>
                    <span className="tabular-nums">− {money(Math.round(затраты.затраты))}</span>
                  </div>
                </div>

                {затраты.вывод > 0 || затраты.заимствования > 0 ? (
                  <div className="space-y-1.5 border-t border-line pt-4 text-xs text-fg-muted">
                    <p>В затраты не входят и в прибыли не участвуют:</p>
                    {затраты.вывод > 0 ? (
                      <div className="flex justify-between gap-4">
                        <span>Вывод собственнику</span>
                        <span className="tabular-nums">{money(Math.round(затраты.вывод))}</span>
                      </div>
                    ) : null}
                    {затраты.заимствования > 0 ? (
                      <div className="flex justify-between gap-4">
                        <span>Займы московской площадке</span>
                        <span className="tabular-nums">{money(Math.round(затраты.заимствования))}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="min-w-0">
                {затраты.статьи.length === 0 ? (
                  <p className="text-sm text-fg-muted">
                    За этот период расходов в учёте нет. Либо выписки ещё не загружены,
                    либо период короче одного платёжного дня.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {главные.map((а) => (
                      <div key={а.статья}
                           className="grid grid-cols-[minmax(0,1fr)_84px_112px] items-center gap-x-3">
                        <span className="truncate text-sm">{а.статья}</span>
                        <span className="h-2 overflow-hidden rounded-full bg-line">
                          <span className="block h-full rounded-full bg-sand-dim"
                                style={{ width: `${(а.сумма / (главные[0]?.сумма || 1)) * 100}%` }} />
                        </span>
                        <span className="text-right text-sm tabular-nums">
                          {крупно(а.сумма)}
                          <span className="ml-1.5 text-xs text-fg-muted">
                            {а.доля.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%
                          </span>
                        </span>
                      </div>
                    ))}
                    {остальные.length > 0 ? (
                      <div className="grid grid-cols-[minmax(0,1fr)_84px_112px] items-center gap-x-3 pt-1">
                        <span className="truncate text-sm text-fg-muted">
                          ещё {остальные.length} {plural(остальные.length, "статья", "статьи", "статей")}
                        </span>
                        <span />
                        <span className="text-right text-sm tabular-nums text-fg-muted">
                          {крупно(остальныеСумма)}
                        </span>
                      </div>
                    ) : null}
                  </div>
                )}

                <div className="mt-4 space-y-2 border-t border-line pt-3 text-xs text-fg-muted">
                  <div>
                    <p className="mb-1.5 font-semibold uppercase tracking-wider">
                      Выписки загружены
                    </p>
                    <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                      {свежесть.map((и) => {
                        const плохо = и.отстаёт > ПОРОГ_ОТСТАВАНИЯ;
                        return (
                          <div key={и.ключ} className="flex justify-between gap-3">
                            <span className={плохо ? "text-alert" : undefined}>{и.подпись}</span>
                            <span className={"tabular-nums " + (плохо ? "text-alert" : "")}>
                              {и.последний
                                ? `по ${и.последний}${и.отстаёт > 0 ? ` · ${и.отстаёт} ${plural(и.отстаёт, "день", "дня", "дней")}` : ""}`
                                : "нет данных"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {отстают.length > 0 ? (
                    <p className="text-alert">
                      ⚠ {отстают.map((и) => и.подпись).join(", ")} —{" "}
                      {отстают.length === 1 ? "отстаёт" : "отстают"}. Затраты за период
                      неполные, а прибыль поэтому завышена.
                    </p>
                  ) : null}
                  {затраты.неопознано > 0 ? (
                    <p>
                      Из них {money(Math.round(затраты.неопознано))} — платежи, статью
                      которых определить не удалось. Это не «прочие расходы»,
                      а вопрос: разбирать в «Финансах».
                    </p>
                  ) : null}
                  <p>
                    Прибыль здесь — оборотная: выручка по кассам минус то, что ушло
                    со счетов и из кассы. Это не бухгалтерская прибыль и не заменяет
                    месячный P&amp;L.
                  </p>
                </div>
              </div>
            </div>
          </Карточка>
        </div>

        {/* ── 4. Возвраты и чаевые ─────────────────────────── */}
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Карточка
            заголовок="Возвраты и отмены"
            пояснение="единственное число здесь, которое смотрят как тревогу"
          >
            <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
              <div>
                <p className="text-2xl tabular-nums">
                  {сейчас.доляВозвратов.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}
                  <span className="ml-1 text-base text-fg-muted">% от выручки</span>
                </p>
                <p className="mt-1.5 text-xs text-fg-muted">
                  {money(Math.round(сейчас.возвраты))} · {сейчас.возвратов}{" "}
                  {plural(сейчас.возвратов, "чек", "чека", "чеков")}
                </p>
              </div>
              <p className="max-w-[34ch] text-xs leading-relaxed text-fg-muted">
                Разбор по людям и причинам — в отчёте по отменам. Здесь только доля,
                чтобы было видно, когда она поползла.
              </p>
            </div>
          </Карточка>

          <Карточка
            заголовок="Чаевые"
            пояснение={
              сейчас.днейСЧаевыми
                ? `по ${сейчас.днейСЧаевыми} ${plural(сейчас.днейСЧаевыми, "смене", "сменам", "сменам")} из приложения`
                : undefined
            }
          >
            {сейчас.чаевые > 0 ? (
              <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
                <div>
                  <p className="text-2xl tabular-nums">{money(Math.round(сейчас.чаевые))}</p>
                  <p className="mt-1.5 text-xs text-fg-muted">
                    {сейчас.выручка
                      ? `${((сейчас.чаевые / сейчас.выручка) * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} % от выручки`
                      : ""}
                  </p>
                </div>
                <Link href="/tips" className="text-sm text-sand underline hover:text-fg">
                  разбор по сменам
                </Link>
              </div>
            ) : (
              <p className="text-sm leading-relaxed text-fg-muted">
                За этот период смен в приложении нет. Чаевые ведутся с августа
                2026 — на длинных периодах их доля будет заниженной.
              </p>
            )}
          </Карточка>
        </div>

        <p className="mt-6 max-w-[92ch] text-xs leading-relaxed text-fg-muted">
          Числа — фискальные чеки обеих касс, торговые сутки с 11:00 до 10:59.
          {обновлено ? ` Залито ${когда(обновлено)}.` : ""} Последний
          день с чеками — {последний}. Столы, оборачиваемость и повторные гости
          сюда пока не вошли: привязки чека к столу в фискальных данных нет.
        </p>
      </main>
    </>
  );
}
