import Nav from "@/components/Nav";
import { notFound } from "next/navigation";
import ShiftScreen from "@/components/ShiftScreen";
import { readDay } from "@/lib/db/corrections";
import { requireManager } from "@/lib/db/managers";
import { dayLabel, weekday } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ShiftPage({
  params,
}: {
  params: Promise<{ day: string }>;
}) {
  await requireManager();

  const { day } = await params;
  const data = await readDay(day);
  if (!data) notFound();

  return (
    <>
      <Nav раздел="tips" />
      <main className="mx-auto max-w-5xl px-6 py-8">
      <header>
        <h1 className="text-2xl font-medium">
          {dayLabel(day)}
          <span className="ml-2 text-base font-normal text-fg-muted">
            {weekday(day)}
          </span>
        </h1>
      </header>

      <ShiftScreen data={data} />

      <p className="mt-8 text-sm text-fg-muted">
        Правка не переписывает запись: старая остаётся видна перечёркнутой,
        новая встаёт рядом. Удалять не может никто — ни смена, ни управляющий,
        ни владелец.
      </p>
    </main>
    </>
  );
}
