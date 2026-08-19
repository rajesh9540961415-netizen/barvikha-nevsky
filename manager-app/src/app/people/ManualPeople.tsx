"use client";

import Link from "next/link";
import { useActionState } from "react";
import { renameManual, вернутьВСписок, склеить, расклеить } from "@/lib/db/people";
import type { ManualPerson } from "@/lib/db/people";
import type { Employee } from "@/lib/types";
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

export default function ManualPeople({
  people,
  все,
}: {
  people: ManualPerson[];
  /** Все, кого знает база: из них выбирают главную запись при склейке. */
  все: Employee[];
}) {
  const [итог, переименовать, идёт] = useActionState(renameManual, null);
  const [возврат, вернуть, возвращаю] = useActionState(вернутьВСписок, null);
  const [склейка, склеитьС, клею] = useActionState(склеить, null);
  const [разрыв, разорвать, рву] = useActionState(расклеить, null);

  if (people.length === 0) return null;

  const имяПо = (id: number) => все.find((p) => p.id === id)?.name ?? `№${id}`;
  const склеенные = people.filter((p) => p.mergedInto !== undefined);

  // Убранные лежат отдельно. Не вперемешку с работающими: список выбора
  // в зале — это «кто сегодня в заведении», и человек, ушедший в июне,
  // среди них только мешает.
  // Склеенные стоят своим блоком: они не «работают» и не «убраны»,
  // они — вторая половина другого человека.
  const работают = people.filter((p) => !p.hidden && p.mergedInto === undefined);
  const убранные = people.filter((p) => p.hidden && p.mergedInto === undefined);

  const подозрительных = работают.filter((p) => похоже_на_сокращение(p.name)).length;

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
        {работают.map((p) => {
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

      {/* Склейка. Отдельной формой под списком, а не кнопкой в каждой строке:
          это редкое действие — раз в жизни каждого стажёра, — и в строке
          оно спорило бы за внимание с переименованием, которое делают чаще. */}
      <div className="mt-8 border-t border-line pt-4">
        <h3 className="font-medium">Это тот же человек</h3>
        <p className="mt-1 text-sm text-fg-muted">
          Стажёра вписали руками, потом оформили — и в кассе у него появился
          свой номер. Склейка говорит, что человек один: имя вписанной записи
          станет таким же, как у кассовой, и в отчёте у него будет одна строка,
          а не две. Номера в записях о деньгах не меняются, суммы тоже.
        </p>

        {склейка && (
          <p className={`mt-3 ${склейка.ok ? "text-fg" : "text-alert"}`}>
            {склейка.текст}
          </p>
        )}

        <form action={склеитьС} className="mt-4 flex flex-wrap items-center gap-3">
          <select
            name="id"
            defaultValue=""
            className="rounded-xl border border-line bg-surface px-3 py-2"
          >
            <option value="">— кого склеить —</option>
            {работают.map((p) => (
              <option key={p.id} value={p.id}>
                {`${p.name} · вписан руками`}
              </option>
            ))}
            {убранные.map((p) => (
              <option key={p.id} value={p.id}>
                {`${p.name} · убран из списка`}
              </option>
            ))}
          </select>

          <span className="text-fg-muted">это тот же, что</span>

          <select
            name="target"
            defaultValue=""
            className="rounded-xl border border-line bg-surface px-3 py-2"
          >
            <option value="">— главная запись —</option>
            {все
              // Уже склеенного главной записью брать нельзя: вышла бы цепочка
              // A → B → C, а её читают в трёх местах и однажды прочитают
              // по-разному. Всех остальных показываем — и кассовых,
              // и вписанных руками.
              .filter((p) => !склеенные.some((m) => m.id === p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {/* Откуда запись — подписываем всегда, а не только
                      у двойников: здесь весь выбор в том и состоит,
                      кассовую брать или вписанную. */}
                  {`${p.name} · ${p.id < 0 ? "вписан руками" : "из кассы"}`}
                </option>
              ))}
          </select>

          <button
            disabled={клею}
            className="rounded-xl bg-sand px-3 py-2 font-medium text-ink disabled:opacity-40"
          >
            {клею ? "Склеиваю…" : "Склеить"}
          </button>
        </form>

        <p className="mt-3 text-sm text-fg-muted">
          ⚠️ Главной делайте запись из кассы: её имя приезжает из Quick Resto
          и не разойдётся. Проверьте, что выбрали того самого человека, —
          склейка меняет имя во всех его прошлых записях.
        </p>

        {склеенные.length > 0 && (
          <div className="mt-6">
            <div className="text-sm text-fg-muted">Уже склеены</div>
            {разрыв && (
              <p className={`mt-2 ${разрыв.ok ? "text-fg" : "text-alert"}`}>
                {разрыв.текст}
              </p>
            )}
            <div className="mt-2 flex flex-col gap-2">
              {склеенные.map((p) => (
                <form
                  key={p.id}
                  action={разорвать}
                  className="flex flex-wrap items-center gap-3"
                >
                  <input type="hidden" name="id" value={p.id} />
                  <div className="w-96 shrink-0">
                    <Link href={`/people?id=${p.id}`} className="text-sand underline">
                      {p.name}
                    </Link>
                    <span className="text-fg-muted">
                      {" "}
                      №{p.id} → №{p.mergedInto} · {имяПо(p.mergedInto!)}
                    </span>
                    <div className="text-sm text-fg-muted">
                      {p.shifts === 0
                        ? "записей нет"
                        : `смен: ${p.shifts}${p.lastDay ? ` · последняя ${dayLabel(p.lastDay)}` : ""}`}
                    </div>
                  </div>
                  <button
                    disabled={рву}
                    className="rounded-xl border border-line px-3 py-2 disabled:opacity-40"
                  >
                    {рву ? "Снимаю…" : "Снять склейку"}
                  </button>
                </form>
              ))}
            </div>
          </div>
        )}
      </div>

      <p className="mt-4 text-sm text-fg-muted">
        ⚠️ Людей из Quick Resto переименовать нельзя: их имена приезжают
        из кассы и вернулись бы обратно при следующей выгрузке. Такие правки
        делаются в самой кассе.
      </p>

      {убранные.length > 0 && (
        <div className="mt-8 border-t border-line pt-4">
          <h3 className="font-medium">Убраны из списка</h3>
          <p className="mt-1 text-sm text-fg-muted">
            Их не предлагают отметить в смене: стажёра оформили в кассе или он
            ушёл. Из учёта они никуда не делись — прошлые смены, деньги
            и отчёты считаются как раньше.
          </p>

          {возврат && (
            <p className={`mt-3 ${возврат.ok ? "text-fg" : "text-alert"}`}>
              {возврат.текст}
            </p>
          )}

          <div className="mt-4 flex flex-col gap-3">
            {убранные.map((p) => (
              <form key={p.id} action={вернуть} className="flex flex-wrap items-center gap-3">
                <input type="hidden" name="id" value={p.id} />
                <div className="w-56 shrink-0">
                  <Link href={`/people?id=${p.id}`} className="text-sand underline">
                    {p.name}
                  </Link>
                  <div className="text-sm text-fg-muted">
                    {p.shifts === 0
                      ? "записей нет"
                      : `смен: ${p.shifts}${p.lastDay ? ` · последняя ${dayLabel(p.lastDay)}` : ""}`}
                  </div>
                </div>
                <button
                  disabled={возвращаю}
                  className="rounded-xl border border-line px-3 py-2 disabled:opacity-40"
                >
                  {возвращаю ? "Возвращаю…" : "Вернуть в список"}
                </button>
              </form>
            ))}
          </div>

          <p className="mt-4 text-sm text-fg-muted">
            💡 Возвращать отсюда нужно редко: если администратор в зале впишет
            это же имя, человек вернётся сам — тот же самый, со своей историей,
            а не новый однофамилец.
          </p>
        </div>
      )}
    </section>
  );
}
