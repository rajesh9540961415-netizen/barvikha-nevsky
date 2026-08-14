"use client";

import Link from "next/link";
import { useActionState } from "react";
import { renameManual } from "@/lib/db/people";
import type { ManualPerson } from "@/lib/db/people";
import { dayLabel } from "@/lib/format";

/**
 * Вписанные руками — те, кого нет в Quick Resto, и потому их имя набирает
 * администратор в зале.
 *
 * Здесь их можно переименовать по-настоящему: имя меняется и на будущее,
 * и в уже сделанных записях о деньгах. Суммы не трогаются.
 */

/**
 * Похоже ли имя на сокращение.
 *
 * ⚠️ Это проверка **написания**, а не догадка о том, кто есть кто. Угадывать
 * людей по похожести имён в этом проекте уже наказывало: «Лиза Н.»
 * и «Елизавета Недорезова» не совпадают ни одной буквой, а Настя С. —
 * Саблина, хотя в кассе есть Анастасия Щеляпа. Поэтому здесь только форма
 * записи, и вывод всегда за владельцем.
 */
function похоже_на_сокращение(имя: string): string | null {
  const части = имя.trim().split(/\s+/).filter(Boolean);
  if (части.length === 0) return null;
  if (части.length === 1) return "одно слово — фамилии нет";
  // «Настя С.» и «Настя С» — фамилия свёрнута до буквы.
  if (части.slice(1).some((ч) => /^[А-ЯЁA-Z]\.?$/u.test(ч))) {
    return "фамилия сокращена до буквы";
  }
  return null;
}

export default function ManualPeople({ people }: { people: ManualPerson[] }) {
  const [итог, переименовать, идёт] = useActionState(renameManual, null);

  if (people.length === 0) return null;

  const подозрительных = people.filter((p) => похоже_на_сокращение(p.name)).length;

  return (
    <section className="mt-10 rounded-xl border border-line p-4">
      <h2 className="font-medium">Вписанные руками</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Этих людей нет в Quick Resto, поэтому их имя набирает администратор
        в зале. Здесь имя можно поправить: оно сменится и в прошлых записях
        о деньгах, а суммы останутся теми же.
      </p>

      {подозрительных > 0 && (
        <p className="mt-3 text-sand">
          Похоже на сокращение: {подозрительных}. Отчёт покажет такого человека
          так, как он записан, — и в бумагах он останется «Настей С.».
        </p>
      )}

      {итог && (
        <p className={`mt-3 ${итог.ok ? "text-fg" : "text-alert"}`}>{итог.текст}</p>
      )}

      <div className="mt-4 flex flex-col gap-3">
        {people.map((p) => {
          const беда = похоже_на_сокращение(p.name);
          return (
            <form key={p.id} action={переименовать} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="id" value={p.id} />

              <div className="w-56 shrink-0">
                {/* Имя — ссылка на карточку: деньги считаются там, тем же
                    расчётом, что и везде. Второй раз их здесь не считаем. */}
                <Link href={`/people?id=${p.id}`} className="text-sand underline">
                  {p.name}
                </Link>
                <div className="text-sm text-fg-muted">
                  {p.shifts === 0
                    ? "записей нет"
                    : `смен: ${p.shifts}${p.lastDay ? ` · последняя ${dayLabel(p.lastDay)}` : ""}`}
                </div>
                {беда && <div className="text-sm text-sand">{беда}</div>}
              </div>

              <input
                name="name"
                defaultValue={p.name}
                placeholder="имя и фамилия полностью"
                className="min-w-56 flex-1 rounded-xl border border-line bg-surface px-3 py-2"
              />
              <button
                disabled={идёт}
                className="rounded-xl bg-sand px-3 py-2 font-medium text-ink disabled:opacity-40"
              >
                {идёт ? "Меняю…" : "Переименовать"}
              </button>
            </form>
          );
        })}
      </div>

      <p className="mt-4 text-sm text-fg-muted">
        ⚠️ Людей из Quick Resto переименовать нельзя: их имена приезжают
        из кассы и вернулись бы обратно при следующей выгрузке. Такие правки
        делаются в самой кассе.
      </p>
    </section>
  );
}
