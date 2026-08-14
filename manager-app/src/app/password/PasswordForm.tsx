"use client";

import { useActionState } from "react";
import Link from "next/link";
import { changeOwnPassword } from "@/lib/db/managers";

/**
 * Смена своего пароля.
 *
 * Экран один на два случая, и они выглядят по-разному:
 *   • обычный заход «хочу сменить» — есть ссылка назад;
 *   • первый вход по выданному паролю — назад ходу нет, и объяснено почему.
 */
export default function PasswordForm({ mustChange }: { mustChange: boolean }) {
  const [итог, submit, busy] = useActionState(changeOwnPassword, null);
  const сменён = итог?.ok === true;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-medium">
        {mustChange ? "Придумайте свой пароль" : "Смена пароля"}
      </h1>

      {mustChange && !сменён && (
        <p className="mt-2 text-fg-muted">
          Пароль, которым вы вошли, выдан вам и где-то записан. Пока он не заменён
          на ваш собственный, дальше не пускаем.
        </p>
      )}

      {сменён ? (
        <>
          <p className="mt-4 text-fg">{итог.текст}</p>
          <Link
            href="/"
            className="mt-6 rounded-xl bg-sand px-3 py-2 text-center font-medium text-ink"
          >
            К сменам
          </Link>
        </>
      ) : (
        <form action={submit} className="mt-8 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-fg-muted">Пароль, которым вошли</span>
            <input
              name="current"
              type="password"
              autoComplete="current-password"
              autoFocus
              className="rounded-xl border border-line bg-surface px-3 py-2"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm text-fg-muted">Новый пароль</span>
            <input
              name="next"
              type="password"
              autoComplete="new-password"
              className="rounded-xl border border-line bg-surface px-3 py-2"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm text-fg-muted">Он же ещё раз</span>
            <input
              name="repeat"
              type="password"
              autoComplete="new-password"
              className="rounded-xl border border-line bg-surface px-3 py-2"
            />
          </label>

          {/* Сообщение над кнопкой, а не поверх неё: всплывающее закрывает
              собой ровно то, на что просит нажать. */}
          {итог?.ok === false && <p className="text-alert">{итог.текст}</p>}

          <button
            type="submit"
            disabled={busy}
            className="mt-2 rounded-xl bg-sand px-3 py-2 font-medium text-ink disabled:opacity-50"
          >
            {busy ? "Меняю…" : "Сменить пароль"}
          </button>

          <p className="mt-1 text-sm text-fg-muted">
            Пароль восстановить нельзя — в базе лежит не он, а его необратимый
            отпечаток. Запишите новый сразу.
          </p>

          {!mustChange && (
            <Link href="/" className="mt-2 text-center text-fg-muted underline">
              назад к сменам
            </Link>
          )}
        </form>
      )}
    </main>
  );
}
