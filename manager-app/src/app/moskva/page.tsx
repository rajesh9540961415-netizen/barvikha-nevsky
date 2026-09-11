import Nav from "@/components/Nav";
import { требоватьВладельца } from "@/lib/db/managers";
import { заимствования, type Движение } from "@/lib/db/zaimy";
import { dayLabel, money, moment, plural } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Заимствования между площадками: что ушло в Москву и что вернулось.
 *
 * Задача владельца 11.09.2026: «сделаем отдельную страничку — какая сумма
 * уходила с питерской площадки на московскую и что приходило с московской,
 * чтобы итоговую сумму фактического долга где-то отобразить. Я по ходу
 * разбирательства буду говорить, на что ушли эти деньги, ты пишешь
 * комментарии».
 *
 * 🔴 **Страница только показывает.** Комментарии пишет владелец — через
 * переписку, а не руками в поле: решение того же дня. Поэтому здесь нет
 * ни одной кнопки: числа и тексты приезжают с Мака через `/api/zaimy`.
 *
 * 🔴 **Главная цифра разложена на две, и это не украшение.** «Остаётся
 * за Москвой» — не подтверждённый долг, а сумма, про которую мы пока ничего
 * не знаем. 09.07.2026 было ровно так: 182 260 ₽ выглядели займом, а
 * оказались возмещением за наши же счета, и из долга ушли. Поэтому остаток
 * разложен на объяснённое и неразобранное: по мере разбора первое растёт,
 * второе тает, и видно, какая часть долга настоящая.
 *
 * ⚠️ **Видно только невскую сторону.** Выписку по московскому счёту владелец
 * сознательно не берёт (решение 15.08.2026), и возврат, сделанный внутри
 * Москвы, сюда не попадёт. Значит цифра может быть завышена, и страница
 * говорит об этом вслух — по прямой просьбе владельца 11.09.2026.
 */
export default async function MoskvaPage() {
  await требоватьВладельца();
  const д = await заимствования();

  if (д.движения.length === 0 && д.неЗаймы.length === 0) {
    return (
      <>
        <Nav раздел="moskva" />
        <main className="mx-auto max-w-5xl px-6 py-8">
          <h1 className="text-2xl font-medium">Москва</h1>
          <p className="mt-3 text-sm text-fg-muted">
            Движений между площадками пока нет. Их присылает с компьютера
            владельца <code className="text-fg">scripts/zaimy_push.py</code> —
            если они должны быть, значит заливка не доехала.
          </p>
        </main>
      </>
    );
  }

  return (
    <>
      <Nav раздел="moskva" />
      <main className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="text-2xl font-medium">Москва</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Заимствования между площадками — что ушло с Невского и что вернулось
        </p>

        {/* ── Главная цифра ────────────────────────────────────────────── */}
        <section className="mt-6 rounded-xl border border-line bg-surface px-6 py-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
            Остаётся за Москвой
          </p>
          <p className="mt-1 text-4xl font-medium tabular-nums">{money(д.остаток)}</p>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Строчка подпись="Выдано займов" значение={money(д.выдано)} />
            <Строчка подпись="Вернулось из Москвы" значение={money(д.возвращено)} />
            <Строчка
              подпись="Из выданного объяснено"
              значение={money(д.объяснено)}
              пояснение="владелец сказала, за что ушли деньги"
            />
            <Строчка
              подпись="Не разобрано"
              значение={money(д.неРазобрано)}
              пояснение="пока просто сумма невыясненного"
              тревога={д.неРазобрано > 0}
            />
          </div>
        </section>

        {/* ⚠️ Оговорка стоит СРАЗУ под цифрой, а не в конце страницы.
            Число без неё читается как установленный долг, а это не так:
            по просьбе владельца 11.09.2026 предупреждение должно быть видно
            тому, кто смотрит только на верх экрана. */}
        <p className="mt-3 text-xs leading-relaxed text-fg-muted">
          Считаем по невским счетам: выписку по московскому счёту мы намеренно
          не берём. Значит возврат, сделанный внутри Москвы, сюда не попадёт —
          цифра может оказаться завышенной, и отсутствие возврата само по себе
          долга не доказывает.
        </p>

        {/* ── Движения ─────────────────────────────────────────────────── */}
        <h2 className="mt-8 text-lg font-medium">
          Движения · {д.движения.length}{" "}
          {plural(д.движения.length, "штука", "штуки", "штук")}
        </h2>
        <Таблица движения={д.движения} />

        {/* ── Разобранные ──────────────────────────────────────────────── */}
        {д.неЗаймы.length > 0 && (
          <>
            <h2 className="mt-8 text-lg font-medium">Разобрано — это не заём</h2>
            <p className="mt-1 text-xs text-fg-muted">
              Движения, которые выглядели займом, а оказались нашим же расходом
              или возмещением. В долг не входят и в счёте выше не участвуют.
            </p>
            <Таблица движения={д.неЗаймы} разобранные />
          </>
        )}

        {д.обновлено && (
          <p className="mt-8 text-xs text-fg-muted">
            Числа обновлены {moment(д.обновлено)}
          </p>
        )}
      </main>
    </>
  );
}

function Строчка({
  подпись,
  значение,
  пояснение,
  тревога,
}: {
  подпись: string;
  значение: string;
  пояснение?: string;
  тревога?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
        {подпись}
      </p>
      <p className={`text-xl tabular-nums ${тревога ? "text-alert" : ""}`}>{значение}</p>
      {пояснение && <p className="text-xs text-fg-muted">{пояснение}</p>}
    </div>
  );
}

function Таблица({
  движения,
  разобранные,
}: {
  движения: Движение[];
  разобранные?: boolean;
}) {
  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-sm">
        <thead className="text-xs text-fg-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-2 text-left font-normal">Дата</th>
            <th className="px-4 py-2 text-left font-normal">Куда</th>
            <th className="px-4 py-2 text-right font-normal">Сумма</th>
            <th className="px-4 py-2 text-left font-normal">
              {разобранные ? "Чем оказалось" : "За что ушли деньги"}
            </th>
          </tr>
        </thead>
        <tbody>
          {движения.map((д) => (
            <tr key={`${д.день}-${д.документ}-${д.сумма}`} className="border-b border-line last:border-0">
              <td className="whitespace-nowrap px-4 py-2.5 align-top text-fg-muted">
                {dayLabel(д.день)}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 align-top">
                {/* Направление словами, а не стрелкой: стрелку читают
                    по-разному, а «вернулось» спутать не с чем. */}
                {д.выдали ? (
                  <span className="text-fg">Питер → Москва</span>
                ) : (
                  <span className="text-sand">Москва → Питер, вернулось</span>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right align-top tabular-nums">
                {money(д.сумма)}
              </td>
              <td className="px-4 py-2.5 align-top">
                {д.почему ?? д.комментарий ?? (
                  // Пусто — это «ещё не разбирали», а не «не за что».
                  // Разница важная: молчание тут легко принять за ответ.
                  <span className="text-fg-muted">— ещё не разбирали</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
