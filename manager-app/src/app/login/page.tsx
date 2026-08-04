"use client";

import { useActionState } from "react";
import { loginAction } from "@/lib/db/managers";

export default function LoginPage() {
  const [error, submit, busy] = useActionState(loginAction, null);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-medium">Бэк-офис</h1>
      <p className="mt-1 text-fg-muted">Барвиха Невский</p>

      <form action={submit} className="mt-8 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm text-fg-muted">Логин</span>
          <input
            name="login"
            autoComplete="username"
            autoFocus
            className="rounded-xl border border-line bg-surface px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm text-fg-muted">Пароль</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            className="rounded-xl border border-line bg-surface px-3 py-2"
          />
        </label>

        {/* Сообщение стоит над кнопкой, а не всплывает поверх неё: всплывающее
            закрывает собой ровно то, на что просит нажать. На этом уже
            обжигались в приложении смены. */}
        {error && <p className="text-alert">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-2 rounded-xl bg-sand px-3 py-2 font-medium text-ink disabled:opacity-50"
        >
          {busy ? "Проверяю…" : "Войти"}
        </button>
      </form>
    </main>
  );
}
