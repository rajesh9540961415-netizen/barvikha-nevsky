import Link from "next/link";
import Nav from "@/components/Nav";
import { notFound } from "next/navigation";
import { финансыЗаДень } from "@/lib/db/finance";
import { dayLabel, money, weekday } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Соседний день — стрелками, не возвращаясь каждый раз в месяц. */
function сдвигДня(день: string, на: number): string {
  const [г, м, д] = день.split("-").map(Number);
  const дата = new Date(г, м - 1, д + на);
  return `${дата.getFullYear()}-${String(дата.getMonth() + 1).padStart(2, "0")}-${String(
    дата.getDate(),
  ).padStart(2, "0")}`;
}

const РОД: Record<string, string> = {
  internal: "перевод между своими счетами",
  withdrawal: "вывод собственнику",
};

/**
 * Финансы: один день. Экран владельца.
 *
 * Это блок «Платежи по контрагентам» из файла владельца: платежи
 * сгруппированы по источнику денег — расчётный счёт ООО, счета ИП, наличные.
 * В Excel его приходится искать глазами; здесь он открывается нажатием
 * на день в таблице месяца.
 *
 * Право смотреть спрашивается внутри `финансыЗаДень`, а не здесь.
 *
 * ⚠️ Имя сегмента адреса — латиницей, как и у `shift/[day]`. С кириллическим
 * `[день]` страница падала с «InvalidCharacterError: Invalid character»
 * ещё до первой строчки разметки: Next.js делает из имени сегмента
 * идентификатор, а кириллица там не проходит. Проверено 15.08.2026.
 * Внутри кода и в параметрах запроса (`?месяц=`) кириллица работает нормально —
 * ломается именно имя папки-сегмента.
 */
export default async function ДеньФинансов({
  params,
}: {
  params: Promise<{ day: string }>;
}) {
  const { day: сырой } = await params;
  const день = decodeURIComponent(сырой);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(день)) notFound();

  const д = await финансыЗаДень(день);
  const месяц = день.slice(0, 7);

  return (
    <>
      <Nav раздел="finance" />
        <main className="mx-auto max-w-5xl px-6 py-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-medium">{dayLabel(день)}</h1>
          <p className="mt-1 text-fg-muted">{weekday(день)}</p>
        </div>
        <div className="flex items-baseline gap-5">
          <Link href={`/finance/${сдвигДня(день, -1)}`} className="text-sand underline">
            ← вчера
          </Link>
          <Link href={`/finance/${сдвигДня(день, 1)}`} className="text-sand underline">
            завтра →
          </Link>
          {/* Та же подпись, что на странице статьи, и по той же причине:
              «весь месяц» не читалось как выход. Стрелка здесь соседствует
              со стрелками «вчера» и «завтра», но путаницы нет — те про время,
              а эта со словом «назад». */}
          <Link href={`/finance?месяц=${месяц}`} className="text-fg-muted underline">
            ← назад к таблице
          </Link>
        </div>
      </header>

      <div className="mt-6 flex flex-wrap gap-x-10 gap-y-2 border-y border-line py-4">
        {д.выручка && (
          <>
            <Число подпись="Выручка безналом" сумма={д.выручка.безнал} />
            <Число подпись="Выручка наличными" сумма={д.выручка.нал} />
          </>
        )}
        {д.чеков !== null && (
          <div>
            <div className="text-sm text-fg-muted">Чеков</div>
            <div className="text-lg tabular-nums">{д.чеков}</div>
          </div>
        )}
        {/* «Расходы» — то же число, что стоит в столбце этого дня в таблице
            месяца. Переводы между своими счетами показаны отдельно, иначе
            день и месяц не сходились бы, и разница выглядела бы ошибкой. */}
        <Число подпись="Расходы" сумма={д.расходы} />
        {д.переводы > 0 && (
          <Число подпись="Переводы между своими счетами" сумма={д.переводы} />
        )}
        <Число подпись="Пришло на счета" сумма={д.пришло} />
      </div>

      {д.пусто ? (
        <p className="mt-8 text-fg-muted">
          В этот день движений по счетам не было. Это не то же самое, что
          отсутствие данных: если день не загружен, его не будет и в таблице месяца.
        </p>
      ) : (
        д.группы.map((г) => (
          <section key={г.ключ} className="mt-8">
            <h2 className="flex items-baseline justify-between border-b border-line pb-2">
              <span>{г.подпись}</span>
              <span className="text-sm text-fg-muted tabular-nums">
                ушло {money(г.ушло)}
                {г.пришло > 0 && ` · пришло ${money(г.пришло)}`}
              </span>
            </h2>
            <table className="mt-2 w-full border-collapse text-sm">
              <tbody>
                {г.платежи.map((п) => (
                  <tr key={п.id} className="border-b border-line/40 align-top">
                    <td className="py-2 pr-4">
                      <div className={п.направление === "in" ? "text-sand" : ""}>
                        {п.контрагент ?? "без контрагента"}
                      </div>
                      {/* Назначение платежа мелким: оно длинное и нужно
                          не всегда, но когда нужно — нужно целиком. */}
                      {п.назначение && (
                        <div className="mt-1 text-xs text-fg-muted">{п.назначение}</div>
                      )}
                      {п.почему && (
                        <div className="mt-1 text-xs text-sand-dim">{п.почему}</div>
                      )}
                    </td>
                    <td className="w-56 py-2 pr-4 text-fg-muted">
                      {/* ⚠️ Красное «не опознано» — только для настоящих
                          расходов. У поступлений статьи не бывает по устройству
                          (её ставит разметка расходов), а у переводов между
                          своими счетами её не должно быть вовсе. Красить их
                          тревожным цветом значит звать разбираться туда,
                          где разбираться нечего. */}
                      {п.статья ??
                        (п.направление === "out" && п.род === "external" ? (
                          <span className="text-alert" title="Статью определить не удалось">
                            не опознано
                          </span>
                        ) : п.направление === "in" ? (
                          "поступление"
                        ) : (
                          ""
                        ))}
                      {п.род && РОД[п.род] && (
                        <div className="mt-1 text-xs text-fg-muted">{РОД[п.род]}</div>
                      )}
                    </td>
                    <td className="w-40 whitespace-nowrap py-2 text-right tabular-nums">
                      {п.направление === "in" ? (
                        <span className="text-sand">+{money(п.сумма)}</span>
                      ) : (
                        money(п.сумма)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </main>
    </>
  );
}

function Число({ подпись, сумма }: { подпись: string; сумма: number | null }) {
  if (сумма === null) return null;
  return (
    <div>
      <div className="text-sm text-fg-muted">{подпись}</div>
      <div className="text-lg tabular-nums">{money(сумма)}</div>
    </div>
  );
}
