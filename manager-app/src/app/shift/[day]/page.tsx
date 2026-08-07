import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import ShiftScreen from "@/components/ShiftScreen";
import { readDay } from "@/lib/db/corrections";
import { currentManager, signOut } from "@/lib/db/managers";
import { dayLabel, weekday } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ShiftPage({
  params,
}: {
  params: Promise<{ day: string }>;
}) {
  const manager = await currentManager();
  if (!manager) redirect("/login");

  const { day } = await params;
  const data = await readDay(day);
  if (!data) notFound();

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <Link href="/" className="text-sm text-fg-muted underline">
            ‹ все смены
          </Link>
          <Link href="/people" className="ml-4 text-sm text-sand underline">
            сотрудники
          </Link>
          <h1 className="mt-1 text-2xl font-medium">
            {dayLabel(day)}
            <span className="ml-2 text-base font-normal text-fg-muted">
              {weekday(day)}
            </span>
          </h1>
        </div>
        <form action={signOut} className="text-sm text-fg-muted">
          {manager.name} ·{" "}
          {manager.role === "owner" ? "владелец" : "управляющий"}{" "}
          <button className="underline">выйти</button>
        </form>
      </header>

      <ShiftScreen data={data} />

      <p className="mt-8 text-sm text-fg-muted">
        Правка не переписывает запись: старая остаётся видна перечёркнутой,
        новая встаёт рядом. Удалять не может никто — ни смена, ни управляющий,
        ни владелец.
      </p>
    </main>
  );
}
