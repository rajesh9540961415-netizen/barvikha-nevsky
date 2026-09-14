import Link from "next/link";
import Nav from "@/components/Nav";
import { требоватьСмену } from "@/lib/db/managers";
import { listShifts } from "@/lib/db/shifts";
import { dayLabel, moneyOrDash as money } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Чаевые: список смен.
 *
 * ⚠️ Жила на «/» до 16.08.2026 и переехала сюда по просьбе владельца: при входе
 * в бэк-офис первыми вываливались чаевые, а нужны финансы. Корень освобождён
 * под дашборд, которого пока нет, — сейчас он просто перенаправляет.
 */
export default async function TipsPage() {
  await требоватьСмену();

  const shifts = await listShifts();

  // Комиссия Сбера за показанные смены: сколько оставили гости минус сколько
  // дошло. Поле guestsGave до сих пор считалось и никуда не показывалось —
  // вот оно и пригодилось.
  const guestsGave = shifts.reduce((sum, s) => sum + s.guestsGave, 0);
  const received = shifts.reduce((sum, s) => sum + s.tips + s.service, 0);
  const commission = Math.round((guestsGave - received) * 100) / 100;

  return (
    <>
      <Nav раздел="tips" />
      <main className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="text-2xl font-medium">Чаевые по сменам</h1>

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
                  <th className="py-2 font-normal">
                    терминал<span className="text-sand">*</span>
                  </th>
                  <th className="py-2 font-normal">QR</th>
                  <th className="py-2 font-normal">сбор</th>
                  <th className="py-2 font-normal">чаевые</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((s) => (
                  <tr key={s.businessDay} className="border-b border-line/50">
                    <td className="py-2 text-left">
                      <Link
                        href={`/shift/${s.businessDay}`}
                        className="underline decoration-line underline-offset-4 hover:decoration-sand"
                      >
                        {dayLabel(s.businessDay)}
                      </Link>
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
                    <td className="py-2 font-medium tabular-nums">{money(s.tips)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Сноска про комиссию — не мелочь. В колонке стоит не та сумма, которую
            гость видел на терминале, и человек, заходящий сюда раз в месяц,
            решит, что цифра неверная. Показываем настоящие рубли за показанный
            период, а не общее «удерживается комиссия». */}
        {commission > 0 && (
          <p className="mt-6 text-sm text-fg-muted">
            <span className="text-sand">*</span> По терминалу показано то, что{" "}
            <b className="font-medium text-fg">дошло до официанта</b>. Сбер
            удерживает 8 % с получателя, поэтому гость оставляет больше, чем
            доходит. За показанные смены гости оставили {money(guestsGave)}, из
            них комиссия — {money(commission)}.
          </p>
        )}

        <p className="mt-3 text-sm text-fg-muted">
          Чаевые — это наличные, терминал и QR вместе. Сервисный сбор считается
          отдельно: он входит в заработок официанта, но чаевыми не является.
        </p>
      </main>
    </>
  );
}
