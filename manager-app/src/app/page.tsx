import Link from "next/link";
import { redirect } from "next/navigation";
import Nav from "@/components/Nav";
import { requireManager } from "@/lib/db/managers";
import { money, plural } from "@/lib/format";
import { заПериод, состояние, type Показатели } from "@/lib/db/dashboard";

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

const ДНИ_НЕДЕЛИ = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

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
 * Столбики. Высота от максимума в наборе — сравниваем внутри графика.
 *
 * ⚠️ Высота считается В ТОЧКАХ, а не в процентах. 07.09.2026 проценты дали
 * пустые графики в бою: процент высоты берётся от родителя, а у родителя
 * с `flex-1` своей высоты нет, и браузер считает такую высоту нулевой.
 * Подписи при этом рисовались, и на первый взгляд график выглядел «пустым
 * периодом», а не поломкой — худший вид ошибки.
 */
const ВЫСОТА_ГРАФИКА = 112;

function Столбики({
  значения, подписи, выделить,
}: { значения: number[]; подписи: string[]; выделить?: number }) {
  const макс = Math.max(...значения, 1);
  return (
    <div className="flex items-end gap-[3px]">
      {значения.map((v, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
          <div className="flex w-full items-end" style={{ height: ВЫСОТА_ГРАФИКА }}>
            <div
              className={"w-full rounded-sm " + (i === выделить ? "bg-sand" : "bg-sand-dim")}
              style={{
                // Ненулевую сумму рисуем хотя бы двумя точками: иначе тихий
                // час выглядит так же, как час без выручки вовсе.
                height: v > 0 ? Math.max(Math.round((v / макс) * ВЫСОТА_ГРАФИКА), 2) : 0,
              }}
              title={`${подписи[i] || i} — ${money(Math.round(v))}`}
            />
          </div>
          <span className="text-[11px] font-medium leading-none text-fg-muted">{подписи[i]}</span>
        </div>
      ))}
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

  const пикЧаса = сейчас.часы.indexOf(Math.max(...сейчас.часы));
  const пикДня = сейчас.дниНедели.indexOf(Math.max(...сейчас.дниНедели));
  const живыеДни = сейчас.дниНедели.filter((v) => v > 0);
  const тихийДень = живыеДни.length
    ? сейчас.дниНедели.indexOf(Math.min(...живыеДни))
    : -1;
  const выручкаВДень = сейчас.дней ? сейчас.выручка / сейчас.дней : 0;

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

        <div className="mt-4 grid gap-4 lg:grid-cols-2">

          {/* ── 2. Направления ─────────────────────────────── */}
          <Карточка заголовок="Откуда выручка" пояснение="по позициям чеков">
            <div className="space-y-3">
              {сейчас.направления.map((н) => {
                const макс = сейчас.направления[0]?.сумма || 1;
                return (
                  <div key={н.имя} className="grid grid-cols-[84px_1fr_112px] items-center gap-3">
                    <span className="text-sm font-medium text-fg">{н.имя}</span>
                    <span className="h-2.5 overflow-hidden rounded-full bg-line">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${(н.сумма / макс) * 100}%`,
                          background: ЦВЕТ_НАПРАВЛЕНИЯ[н.имя] ?? "var(--color-sand-dim)",
                        }}
                      />
                    </span>
                    <span className="text-right text-sm tabular-nums">
                      {крупно(н.сумма)}
                      <span className="ml-1.5 text-xs text-fg-muted">
                        {н.доля.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} %
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </Карточка>

          {/* ── 3. Дни недели ──────────────────────────────── */}
          <Карточка
            заголовок="Дни недели"
            пояснение={
              тихийДень >= 0 && сейчас.дниНедели[тихийДень] > 0 && пикДня !== тихийДень
                ? `${ДНИ_НЕДЕЛИ[пикДня]} даёт в ${(сейчас.дниНедели[пикДня] / сейчас.дниНедели[тихийДень]).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} раза больше, чем ${ДНИ_НЕДЕЛИ[тихийДень]}`
                : undefined
            }
          >
            <Столбики значения={сейчас.дниНедели} подписи={ДНИ_НЕДЕЛИ} выделить={пикДня} />
          </Карточка>
        </div>

        {/* ── 4. Часы ──────────────────────────────────────── */}
        <div className="mt-4">
          <Карточка
            заголовок="Когда приходят деньги"
            пояснение={`пик — ${String(пикЧаса).padStart(2, "0")}:00 · час суток, не торговые сутки`}
          >
            <Столбики
              значения={сейчас.часы}
              подписи={Array.from({ length: 24 }, (_, ч) => (ч % 2 === 0 ? String(ч) : ""))}
              выделить={пикЧаса}
            />
          </Карточка>
        </div>

        {/* ── 5. Возвраты и чаевые ─────────────────────────── */}
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
