import { redirect } from "next/navigation";
import { currentManager, signOut } from "@/lib/db/managers";
import { listShifts } from "@/lib/db/shifts";

export const dynamic = "force-dynamic";

function money(value: number): string {
  if (!value) return "—";
  const text = value.toLocaleString("ru-RU", {
    minimumFractionDigits: Math.round(value * 100) % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `${text.replace(/\s/g, " ")} ₽`;
}

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function day(key: string): string {
  const [, month, date] = key.split("-");
  return `${Number(date)} ${MONTHS[Number(month) - 1]}`;
}

export default async function Home() {
  const manager = await currentManager();
  if (!manager) redirect("/login");

  const shifts = await listShifts();

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-medium">Смены</h1>
          <p className="mt-1 text-fg-muted">
            {manager.name} · {manager.role === "owner" ? "владелец" : "управляющий"}
          </p>
        </div>
        <form action={signOut}>
          <button className="text-fg-muted underline">выйти</button>
        </form>
      </header>

      {shifts.length === 0 ? (
        <p className="mt-8 text-fg-muted">Записей пока нет.</p>
      ) : (
        <div className="mt-8 overflow-x-auto">
          <table className="w-full border-collapse text-right">
            <thead className="text-sm text-fg-muted">
              <tr className="border-b border-line">
                <th className="py-2 text-left font-normal">смена</th>
                <th className="py-2 font-normal">записей</th>
                <th className="py-2 font-normal">наличные</th>
                <th className="py-2 font-normal">терминал</th>
                <th className="py-2 font-normal">QR</th>
                <th className="py-2 font-normal">сбор</th>
                <th className="py-2 font-normal">питание</th>
                <th className="py-2 font-normal">чаевые</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((s) => (
                <tr key={s.businessDay} className="border-b border-line/50">
                  <td className="py-2 text-left">
                    {day(s.businessDay)}
                    {/* Смену, тронутую из бэк-офиса, помечаем прямо в списке:
                        иначе правка задним числом становится невидимой, а это
                        ровно то, чего мы избегаем. */}
                    {s.corrected && (
                      <span className="ml-2 text-xs text-sand">правлено</span>
                    )}
                  </td>
                  <td className="py-2 tabular-nums">{s.records}</td>
                  <td className="py-2 tabular-nums">{money(s.cash)}</td>
                  <td className="py-2 tabular-nums">{money(s.terminal)}</td>
                  <td className="py-2 tabular-nums">{money(s.qr)}</td>
                  <td className="py-2 tabular-nums">{money(s.service)}</td>
                  <td className="py-2 tabular-nums">{money(s.staff)}</td>
                  <td className="py-2 font-medium tabular-nums">{money(s.tips)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-6 text-sm text-fg-muted">
        Чаевые — это наличные, терминал и QR вместе. Сервисный сбор считается
        отдельно: он входит в заработок официанта, но чаевыми не является.
        Питание — вычет, а не доход.
      </p>
    </main>
  );
}
