"use client";

import { useActionState } from "react";
import { renameManual } from "@/lib/db/people";
import type { Employee } from "@/lib/types";

/**
 * Вписанные руками — те, кого нет в Quick Resto, и потому их имя набирает
 * администратор в зале. Набирает коротко: «Настя С.», «Алексей Г.».
 *
 * Здесь их можно переименовать по-настоящему: имя меняется и на будущее,
 * и в уже сделанных записях о деньгах. Суммы не трогаются.
 */

/**
 * Что владелец продиктовала 14.08.2026 — подставляем в поля, чтобы
 * не набирать руками: задача как раз про то, что имена набирают с ошибками.
 *
 * 💡 Список одноразовый. Когда все шестеро переименованы, его можно убрать
 * отсюда вовсе — умение останется, а подсказки больше не нужны.
 */
const ПОДСКАЗКИ: Record<string, string> = {
  "Настя С.": "Анастасия Саблина",
  "Алексей Г.": "Алексей Горбунов",
  "Лиза П.": "Елизавета Пархоменко",
  "Лиза Н.": "Елизавета Недорезова",
  "Дарья Б.": "Дарья Бобылева",
  Михаела: "Михаела Балуцел",
};

export default function ManualPeople({ people }: { people: Employee[] }) {
  const [итог, переименовать, идёт] = useActionState(renameManual, null);

  if (people.length === 0) return null;

  return (
    <section className="mt-10 rounded-xl border border-line p-4">
      <h2 className="font-medium">Вписанные руками</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Этих людей нет в Quick Resto, поэтому их имя набирает администратор
        в зале — часто коротко. Здесь имя можно поправить: оно сменится
        и в прошлых записях о деньгах. Суммы при этом не трогаются.
      </p>

      {итог && (
        <p className={`mt-3 ${итог.ok ? "text-fg" : "text-alert"}`}>{итог.текст}</p>
      )}

      <div className="mt-4 flex flex-col gap-2">
        {people.map((p) => {
          const подсказка = ПОДСКАЗКИ[p.name];
          return (
            <form
              key={p.id}
              action={переименовать}
              className="flex flex-wrap items-center gap-3"
            >
              <input type="hidden" name="id" value={p.id} />
              <span className="w-40 shrink-0 text-fg-muted">{p.name}</span>
              <span className="text-fg-muted">→</span>
              <input
                name="name"
                defaultValue={подсказка ?? p.name}
                className="min-w-56 flex-1 rounded-xl border border-line bg-surface px-3 py-2"
              />
              <button
                disabled={идёт || (подсказка ?? p.name) === p.name}
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
