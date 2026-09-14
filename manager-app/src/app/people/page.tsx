import Link from "next/link";
import Nav from "@/components/Nav";
import quickResto from "@/data/employees.json";
import { Suspense } from "react";
import PersonPicker from "@/components/PersonPicker";
import PersonStatsView from "@/components/PersonStats";
import ManualPeople from "./ManualPeople";
import { listPeople, listManualPeople, readPerson, склейки } from "@/lib/db/people";
import { требоватьСмену } from "@/lib/db/managers";
import { dayLabel } from "@/lib/format";
import type { Employee } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Границы периода в ключах бизнес-дня.
 *
 * День считаем по границе 11:00, как в Quick Resto: смена, идущая до трёх
 * ночи, относится ко вчерашнему дню. Без этой поправки утром 1 августа
 * «текущий месяц» начинался бы с пустого места, а вчерашняя смена
 * оказывалась бы в прошлом месяце.
 */
function range(period: string): { from: string; to: string } {
  const now = new Date();
  if (now.getHours() < 11) now.setDate(now.getDate() - 1);
  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const to = key(now);

  if (period === "month") {
    return { from: key(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  }
  if (period === "prev") {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: key(first), to: key(last) };
  }
  if (period === "all") {
    // Приложение записывает с 31.07.2026 — раньше этой даты данных нет
    // и быть не может. Верхнюю границу оставляем сегодняшней.
    return { from: "2026-01-01", to };
  }

  const days = period === "90" ? 90 : 30;
  const start = new Date(now);
  start.setDate(start.getDate() - days + 1);
  return { from: key(start), to };
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; period?: string }>;
}) {
  const manager = await требоватьСмену();

  const params = await searchParams;
  const period = params.period ?? "30";
  const { from, to } = range(period);

  const people = await listPeople();
  const склеено = await склейки();
  // Склеенных в выборе не показываем: после склейки у них имя главной записи,
  // и в списке стояли бы две одинаковые строки — ровно то, ради избавления
  // от чего склейка и делалась. Из `people` их не убираем: по этому списку
  // ищут имя по номеру, и без них состав прошлой смены показал бы «№-5».
  const дляВыбора = people.filter((p) => !склеено.has(p.id));
  // Переименовывать может только владелец, поэтому и список ему одному:
  // показать кнопку тому, кто не может ею воспользоваться, — обман.
  const manual = manager.role === "owner" ? await listManualPeople() : [];

  // Кого можно назначить главной записью при склейке.
  //
  // ⚠️ Не `listPeople()`. Тот список — «кто хоть раз стоял в смене или получал
  // деньги», и для склейки он не годится дважды. Во-первых, стажёра оформляют
  // в кассе ДО первой смены под новым номером, и в списке его ещё нет — то есть
  // склеить нельзя ровно в тот день, когда это и нужно. Во-вторых, вписанные
  // руками тоже бывают главной записью: двух вписанных одного человека
  // склеивают друг с другом, кассы у него может не быть вовсе.
  //
  // Поэтому берём справочник целиком: касса Quick Resto плюс вписанные руками.
  const дляСклейки: Employee[] = [
    ...(quickResto as Employee[]),
    ...manual.map((m) => ({ id: m.id, name: m.name, short: m.short })),
  ].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const id = params.id ? Number(params.id) : null;
  const stats = id !== null ? await readPerson(id, from, to) : null;

  return (
    <>
      <Nav раздел="people" />
      <main className="mx-auto max-w-5xl px-6 py-8">
      <header>
        <h1 className="text-2xl font-medium">Сотрудники</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {dayLabel(from)} — {dayLabel(to)}
        </p>
      </header>

      <div className="mt-6">
        <Suspense fallback={<div className="h-16" />}>
          <PersonPicker people={дляВыбора} personId={id} period={period} />
        </Suspense>
      </div>

      {stats === null ? (
        <p className="mt-8 text-fg-muted">
          {people.length === 0
            ? "Пока некого показывать: в базе нет ни одной смены."
            : "Выберите сотрудника, чтобы увидеть его смены за период."}
        </p>
      ) : stats.days.length === 0 ? (
        <p className="mt-8 text-fg-muted">
          За этот период у заведения не было ни одной смены. Попробуйте
          выбрать период пошире.
        </p>
      ) : (
        <PersonStatsView stats={stats} />
      )}

      {/* Весь блок — владельцу. Переименование, склейка и заведение людей
          доступны только ему, и показывать управляющему кнопки, которыми он
          не может воспользоваться, — обман. Раньше блок прятался сам, потому
          что список приходил пустым; теперь в нём есть кнопка «вписать»,
          и пустой список больше не значит «показывать нечего». */}
      {manager.role === "owner" && (
        <ManualPeople people={manual} все={дляСклейки} />
      )}
    </main>
    </>
  );
}
