"use client";

import { useActionState } from "react";
import Link from "next/link";
import { addPerson, resetPassword, toggleActive, type AccessPerson } from "@/lib/db/managers";

/** Показ выданного пароля. Он приходит один раз, и это надо сказать вслух. */
function Пароль({ логин, пароль, текст }: { логин?: string; пароль: string; текст: string }) {
  return (
    <div className="mt-4 rounded-xl border border-sand bg-sand/10 px-4 py-3">
      <p className="text-fg">{текст}</p>
      <p className="mt-2 font-mono text-lg text-fg">
        {логин ? `${логин} · ` : ""}
        {пароль}
      </p>
      <p className="mt-2 text-sm text-fg-muted">
        Второй раз он не покажется: в базе лежит не пароль, а его необратимый
        отпечаток. Уйдёте со страницы — пароль пропадёт.
      </p>
    </div>
  );
}

function когда(iso: string | null): string {
  if (!iso) return "ни разу";
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AccessScreen({ people }: { people: AccessPerson[] }) {
  const [заведён, завести, заводит] = useActionState(addPerson, null);
  const [сброшен, сбросить, сбрасывает] = useActionState(resetPassword, null);
  const [переключён, переключить, переключает] = useActionState(toggleActive, null);

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-medium">Доступ в бэк-офис</h1>
          <p className="mt-1 text-fg-muted">Кто может заходить и править деньги</p>
        </div>
        <Link href="/" className="text-fg-muted underline">
          к сменам
        </Link>
      </header>

      {/* ── Завести человека ─────────────────────────────────────────── */}
      <section className="mt-8 rounded-xl border border-line p-4">
        <h2 className="font-medium">Завести человека</h2>
        <form action={завести} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-fg-muted">Имя</span>
            <input
              name="name"
              placeholder="Виктория Борзова"
              className="rounded-xl border border-line bg-surface px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-fg-muted">Логин (латиницей)</span>
            <input
              name="login"
              placeholder="vika"
              className="rounded-xl border border-line bg-surface px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-fg-muted">Роль</span>
            <select
              name="role"
              defaultValue="manager"
              className="rounded-xl border border-line bg-surface px-3 py-2"
            >
              <option value="manager">управляющий</option>
              <option value="owner">владелец</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={заводит}
            className="rounded-xl bg-sand px-3 py-2 font-medium text-ink disabled:opacity-50"
          >
            {заводит ? "Завожу…" : "Завести"}
          </button>
        </form>

        <p className="mt-3 text-sm text-fg-muted">
          Управляющий правит факты смены. Владелец вдобавок распоряжается доступом:
          заводит людей, выдаёт пароли, отключает уволившихся.
        </p>

        {заведён?.ok === false && <p className="mt-3 text-alert">{заведён.текст}</p>}
        {заведён?.ok && заведён.пароль && (
          <Пароль логин={заведён.логин} пароль={заведён.пароль} текст={заведён.текст} />
        )}
      </section>

      {/* ── Ответы на действия со строками ───────────────────────────── */}
      {сброшен?.ok === false && <p className="mt-4 text-alert">{сброшен.текст}</p>}
      {сброшен?.ok && сброшен.пароль && (
        <Пароль логин={сброшен.логин} пароль={сброшен.пароль} текст={сброшен.текст} />
      )}
      {переключён && (
        <p className={`mt-4 ${переключён.ok ? "text-fg-muted" : "text-alert"}`}>
          {переключён.текст}
        </p>
      )}

      {/* ── Список ───────────────────────────────────────────────────── */}
      <div className="mt-8 overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead className="text-sm text-fg-muted">
            <tr className="border-b border-line">
              <th className="py-2 font-normal">человек</th>
              <th className="py-2 font-normal">роль</th>
              <th className="py-2 font-normal">последний вход</th>
              <th className="py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id} className="border-b border-line align-baseline">
                <td className="py-3">
                  <span className={p.active ? "text-fg" : "text-fg-muted line-through"}>
                    {p.name}
                  </span>
                  <span className="ml-2 text-sm text-fg-muted">{p.login}</span>
                  {p.mustChangePassword && (
                    <span className="ml-2 text-sm text-sand">пароль не сменён</span>
                  )}
                  {!p.active && <span className="ml-2 text-sm text-fg-muted">отключён</span>}
                </td>
                <td className="py-3 text-fg-muted">
                  {p.role === "owner" ? "владелец" : "управляющий"}
                </td>
                <td className="py-3 text-fg-muted">{когда(p.lastSeen)}</td>
                <td className="py-3">
                  <div className="flex justify-end gap-4">
                    {p.active && (
                      <form action={сбросить}>
                        <input type="hidden" name="id" value={p.id} />
                        <button
                          disabled={сбрасывает}
                          className="text-sand underline disabled:opacity-50"
                        >
                          выдать пароль
                        </button>
                      </form>
                    )}
                    <form action={переключить}>
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="active" value={p.active ? "0" : "1"} />
                      <button
                        disabled={переключает}
                        className="text-fg-muted underline disabled:opacity-50"
                      >
                        {p.active ? "отключить" : "вернуть"}
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-sm text-fg-muted">
        Уволившегося отключаем, а не удаляем: вместе с удалённым ушла бы история
        его правок, а это денежный след.
      </p>
    </main>
  );
}
