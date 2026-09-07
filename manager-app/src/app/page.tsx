import Link from "next/link";
import { redirect } from "next/navigation";
import Nav from "@/components/Nav";
import { requireManager } from "@/lib/db/managers";
import { money, plural } from "@/lib/format";
import {
  ПЕРИОДЫ, заПериод, годНазад, окно, рост, собрано, последнийДень,
  type Показатели,
} from "@/lib/dashboard";

export const dynamic = "force-dynamic";

/**
 * Обзор — первый экран владельца.
 *
 * Заведён 07.09.2026 по её задаче: «первая страничка с основными
 * показателями работы заведения». До этого корень бэк-офиса просто
 * перенаправлял на «Финансы», и общей картины не было нигде.
 *
 * Пять блоков — ровно те, что считаются по имеющимся данным, без новых
 * выгрузок: главные числа, направления, часы, дни недели, возвраты
 * и чаевые. Столы, оборачиваемость и повторные гости сюда НЕ вошли
 * сознательно: привязки чека к столу в фискальных данных нет, а рисовать
 * пустой блок — обещать то, чего нет.
 *
 * Управляющего сюда не пускаем: обзор — это выручка и прибыль, его экран
 * начинается с чаевых.
 */

const ДНИ_НЕДЕЛИ = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

/** «12,4 млн» — на плитке важен порядок величины, а не рубль. */
function крупно(v: number): string {
  if (Math.abs(v) >= 1_000_000) {
    return (v / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " млн";
  }
  if (Math.abs(v) >= 10_000) {
    return Math.round(v / 1000).toLocaleString("ru-RU") + " тыс";
  }
  return money(v);
}

function Дельта({ значение, чтоЗначит }: { значение: number | null; чтоЗначит: string }) {
  if (значение === null) {
    return <p className="mt-1.5 text-xs text-fg-muted">не с чем сравнить</p>;
  }
  const вверх = значение >= 0;
  return (
    <p className={"mt-1.5 text-xs " + (вверх ? "text-sand" : "text-alert")}>
      {вверх ? "↑" : "↓"} {Math.abs(значение).toLocaleString("ru-RU", { maximumFractionDigits: 0 })} %{" "}
      <span className="text-fg-muted">{чтоЗначит}</span>
    </p>
  );
}

function Плитка({
  подпись, значение, единица, дельта,
}: {
  подпись: string; значение: string; единица?: string;
  дельта?: { значение: number | null; чтоЗначит: string } | { текст: string };
}) {
  return (
    <div className="bg-surface p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-fg-muted">{подпись}</p>
      <p className="mt-2 text-2xl leading-none tabular-nums">
        {значение}
        {единица ? <span className="ml-1 text-base text-fg-muted">{единица}</span> : null}
      </p>
      {дельта && "текст" in дельта
        ? <p className="mt-1.5 text-xs text-fg-muted">{дельта.текст}</p>
        : дельта
          ? <Дельта значение={дельта.значение} чтоЗначит={дельта.чтоЗначит} />
          : null}
    </div>
  );
}

function Карточка({
  заголовок, пояснение, children,
}: { заголовок: string; пояснение?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-medium">{заголовок}</h2>
        {пояснение ? <p className="text-right text-xs text-fg-muted">{пояснение}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Столбики. Высота от максимума в наборе — сравниваем внутри графика. */
function Столбики({
  значения, подписи, выделить,
}: { значения: number[]; подписи: string[]; выделить?: number }) {
  const макс = Math.max(...значения, 1);
  return (
    <div className="flex items-end gap-[3px]" style={{ height: 132 }}>
      {значения.map((v, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
          <div className="flex w-full flex-1 items-end">
            <div
              className={"w-full rounded-sm " + (i === выделить ? "bg-sand" : "bg-sand-dim")}
              style={{ height: `${Math.max((v / макс) * 100, v > 0 ? 1.5 : 0)}%` }}
              title={`${подписи[i]} — ${money(Math.round(v))}`}
            />
          </div>
          <span className="text-[10px] leading-none text-fg-muted">{подписи[i]}</span>
        </div>
      ))}
    </div>
  );
}

export default async function Обзор({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | undefined }>;
}) {
  const manager = await requireManager();
  if (manager.role !== "owner") redirect("/tips");

  const параметры = await searchParams;
  const выбран = ПЕРИОДЫ.find((п) => п.ключ === параметры.период) ?? ПЕРИОДЫ[2];
  const { с, по } = окно(выбран.дней);
  const сейчас: Показатели = заПериод(с, по);
  const было: Показатели = годНазад(с, по);

  const пикЧаса = сейчас.часы.indexOf(Math.max(...сейчас.часы));
  const пикДня = сейчас.дниНедели.indexOf(Math.max(...сейчас.дниНедели));
  const тихийДень = сейчас.дниНедели.indexOf(
    Math.min(...сейчас.дниНедели.filter((v) => v > 0)));
  const выручкаВДень = сейчас.дней ? сейчас.выручка / сейчас.дней : 0;

  return (
    <>
      <Nav раздел="обзор" />
      <main className="mx-auto max-w-[1600px] px-6 py-6">

        <div className="mb-5 flex flex-wrap items-baseline gap-x-2 gap-y-3">
          {ПЕРИОДЫ.map((п) => (
            <Link
              key={п.ключ}
              href={п.ключ === "30" ? "/" : `/?период=${п.ключ}`}
              aria-current={п.ключ === выбран.ключ ? "page" : undefined}
              className={
                "rounded-full border px-3.5 py-1.5 text-sm transition-colors " +
                (п.ключ === выбран.ключ
                  ? "border-sand bg-sand/15 font-medium text-sand"
                  : "border-line text-fg-muted hover:border-sand-dim hover:text-fg")
              }
            >
              {п.подпись}
            </Link>
          ))}
          <span className="ml-1 text-xs text-fg-muted">
            {сейчас.с} — {сейчас.по} · сравнение с тем же периодом год назад
          </span>
        </div>

        {/* ── 1. Главные числа ─────────────────────────────── */}
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
          <Плитка
            подпись="Выручка" значение={крупно(сейчас.выручка)} единица="₽"
            дельта={{ значение: рост(сейчас.выручка, было.выручка), чтоЗначит: "к прошлому году" }}
          />
          <Плитка
            подпись="Чеков" значение={сейчас.чеков.toLocaleString("ru-RU")}
            дельта={{ значение: рост(сейчас.чеков, было.чеков), чтоЗначит: "к прошлому году" }}
          />
          <Плитка
            подпись="Средний чек" значение={money(Math.round(сейчас.среднийЧек))}
            дельта={{ текст: "с июля — две кассы, сравнивать с прошлым нельзя" }}
          />
          <Плитка
            подпись="Наличными"
            значение={сейчас.долянала.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}
            единица="%"
            дельта={{ текст: `остальное — терминал и QR` }}
          />
          <Плитка
            подпись="В день" значение={крупно(выручкаВДень)} единица="₽"
            дельта={{ текст: `${сейчас.дней} ${plural(сейчас.дней, "день", "дня", "дней")} в периоде` }}
          />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">

          {/* ── 2. Направления ─────────────────────────────── */}
          <Карточка заголовок="Откуда выручка" пояснение="по позициям чеков">
            <div className="space-y-3">
              {сейчас.направления.map((н) => {
                const макс = сейчас.направления[0]?.сумма || 1;
                return (
                  <div key={н.имя} className="grid grid-cols-[84px_1fr_104px] items-center gap-3">
                    <span className="text-sm text-fg-muted">{н.имя}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-line">
                      <span
                        className="block h-full rounded-full bg-sand-dim"
                        style={{ width: `${(н.сумма / макс) * 100}%` }}
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
              сейчас.дниНедели[пикДня] && сейчас.дниНедели[тихийДень]
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
          <Карточка заголовок="Возвраты и отмены" пояснение="единственное число здесь, которое смотрят как тревогу">
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
            пояснение={сейчас.днейСЧаевыми ? `по ${сейчас.днейСЧаевыми} ${plural(сейчас.днейСЧаевыми, "смене", "сменам", "сменам")} из приложения` : "нет данных за период"}
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
              <p className="text-sm text-fg-muted">
                За этот период смен в приложении нет. Чаевые появились в учёте
                с августа 2026 — на длинных периодах доля будет заниженной.
              </p>
            )}
          </Карточка>
        </div>

        <p className="mt-6 text-xs text-fg-muted">
          Числа — фискальные чеки обеих касс, торговые сутки с 11:00 до 10:59.
          Слепок собран {собрано().replace("T", ", ")}, последний день с чеками —{" "}
          {последнийДень()}. Столы, оборачиваемость и повторные гости сюда пока
          не вошли: привязки чека к столу в фискальных данных нет.
        </p>
      </main>
    </>
  );
}
