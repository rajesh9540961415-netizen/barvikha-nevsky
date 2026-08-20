"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { DayData } from "@/lib/db/corrections";
import { cancelEvent } from "@/lib/db/corrections";
import { clock, money, moneyOrDash, moment, plural } from "@/lib/format";
import {
  KIND_TITLE,
  eventKey,
  splitOffice,
  splitSideOffice,
  type OfficeEntry,
  type ShiftEvent,
} from "@/lib/office";
import { THRESHOLD, adminShares, cashierPool } from "@/lib/split";
import Compare from "./Compare";
import AddEntry from "./AddEntry";
import CrewEditor from "./CrewEditor";
import EventEditor, { Field, Overlay } from "./EventEditor";

/**
 * Смена целиком: раскладка, состав и все записи.
 *
 * Отменённые записи остаются на экране перечёркнутыми. Удалять их нельзя
 * в принципе — это денежный документ, и через год должно быть видно
 * не только «сколько», но и «почему столько».
 */

export default function ShiftScreen({ data }: { data: DayData }) {
  const { businessDay: day, live, events, shift, crew, people } = data;
  const [editing, setEditing] = useState<ShiftEvent | null>(null);
  const [cancelling, setCancelling] = useState<ShiftEvent | null>(null);
  const [crewOpen, setCrewOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  /**
   * Чья строка раскрыта в его записи. Одна за раз: раскрытые разом четверо
   * превращают таблицу раскладки в тот же список записей, что ниже, —
   * а он и так есть.
   *
   * Ключ с котлом, а не голый номер: один человек может стоять в смене
   * и официантом, и хостес, и тогда по номеру раскрылись бы обе строки.
   */
  const [openWaiter, setOpenWaiter] = useState<string | null>(null);

  const split = useMemo(() => splitOffice(live, crew, day), [live, crew, day]);

  /**
   * Хостес и кальянный бар.
   *
   * ⚠️ До 20.08.2026 бэк-офис их не показывал вовсе: раскладка здесь считала
   * только зал, а деньги этих двух котлов были видны лишь в списке записей
   * внизу. То есть «Заработано за смену» на этом экране и в приложении смены
   * за один и тот же вечер расходились — ровно та беда, которая 19.08 стоила
   * 12 900,96 ₽ и целого дня разбирательств.
   *
   * Получателей НЕ берём из справочника: имя ищем в самой записи. Человека
   * могли убрать из состава после того, как ему записали деньги, — и по
   * справочнику он бы не нашёлся, а деньги настоящие.
   */
  const side = useMemo(
    () => ({
      hostess: splitSideOffice(live, "hostess", people),
      hookah: splitSideOffice(live, "hookah", []),
    }),
    [live, people],
  );
  const sideTotal = side.hostess.total + side.hookah.total;
  /**
   * Сколько гости оставили за ВЕСЬ вечер и сколько забрал Сбер.
   *
   * ⚠️ По трём котлам, а не по одному залу. Владелец 20.08.2026: «цифры
   * не сходятся» — и была права: на экране рядом стояли «гости оставили
   * 1 000 ₽» и «всего за смену 2 760 ₽», потому что первая считалась
   * только по залу. Сумма, спорящая сама с собой, обесценивает соседние:
   * их перестают проверять.
   */
  const grossAll =
    Math.round(
      (split.totalGross + side.hostess.totalGross + side.hookah.totalGross) * 100,
    ) / 100;
  const commissionAll =
    Math.round(
      (split.totalCommission +
        side.hostess.totalCommission +
        side.hookah.totalCommission) *
        100,
    ) / 100;
  const nameOf = (id: number | null) =>
    id === null ? "не указан" : people.find((p) => p.id === id)?.short ?? `№${id}`;

  return (
    <>
      <section className="mt-6 rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3">
          <div className="text-sm text-fg-muted">
            {crew.length} {plural(crew.length, "официант", "официанта", "официантов")}
            {" · вносила "}
            {nameOf(shift.operator)}
            {" · администратор "}
            {nameOf(shift.admin)}
            {shift.admin2 !== null && ` и ${nameOf(shift.admin2)}`}
            {" · кассир "}
            {nameOf(shift.cashier)}
          </div>
          <div className="flex gap-4">
            <button
              onClick={() => setCrewOpen(true)}
              className="text-sm text-sand underline"
            >
              поправить состав
            </button>
            {/* Запись, которой не было вовсе. Стоит рядом с составом, а не
                в списке записей: там правят существующее, а это — другое
                действие, и путать их нельзя. */}
            <button
              onClick={() => setAddOpen(true)}
              className="text-sm text-sand underline"
            >
              завести запись
            </button>
          </div>
        </div>

        <div className="grid gap-x-8 gap-y-1 px-5 py-4 sm:grid-cols-2">
          <Total label="Заработано залом" value={split.totalEarned} strong />
          <Total label="Начислено официантам" value={split.waitersAccrued} strong />
          <Total label="чаевые" value={split.totalTips} />
          {shift.admin2 !== null ? (
            <Total
              label="Администраторам"
              value={split.adminTotal}
              note={adminShares(split.adminTotal, 2)
                .map((доля, i) => `${nameOf(i === 0 ? shift.admin : shift.admin2)} ${money(доля)}`)
                .join(" · ")}
            />
          ) : (
            <Total label="Администратору" value={split.adminTotal} />
          )}
          <Total label="сервисный сбор" value={split.totalService} />
          <Total
            label="Кассиру"
            value={split.cashierTotal}
            note={`${money(cashierPool(day))} ÷ ${crew.length || 1} = по ${money(split.cashierShare)}`}
          />
          <Total
            label="Гости оставили"
            value={grossAll}
            note={
              commissionAll > 0
                ? `комиссия Сбера −${money(commissionAll)}`
                : undefined
            }
          />
          {/* Итог вечера целиком — тот же, что показывает приложение смены.
              Пока его здесь не было, два экрана называли разные суммы
              за один вечер, и объяснить это было нечем. */}
          {sideTotal > 0 && (
            <>
              <Total
                label="Хостес и кальянный бар"
                value={sideTotal}
                note="не делится ни с кем: ни администратору, ни кассиру"
              />
              <Total
                label="Всего за смену"
                value={split.totalEarned + sideTotal}
                strong
              />
            </>
          )}
        </div>

        <div className="overflow-x-auto border-t border-line">
          <table className="w-full border-collapse text-right text-sm">
            <thead className="text-xs text-fg-muted">
              <tr className="border-b border-line">
                <th className="px-5 py-2 text-left font-normal">официант</th>
                <th className="px-2 py-2 font-normal">заработано</th>
                <th className="px-2 py-2 font-normal">админу</th>
                <th className="px-2 py-2 font-normal">кассиру</th>
                <th className="px-5 py-2 font-normal">начислено</th>
              </tr>
            </thead>
            <tbody>
              {split.waiters.map((w) => {
                const ключ = `hall-${w.waiterId}`;
                const открыт = openWaiter === ключ;
                return (
                  <Fragment key={w.waiterId}>
                    {/* Строка нажимается целиком: искать в ней маленькую
                        стрелочку мышью — лишняя работа там, где вопрос
                        задают на бегу. */}
                    <tr
                      onClick={() =>
                        setOpenWaiter(открыт ? null : ключ)
                      }
                      className={`cursor-pointer border-b border-line/40 hover:bg-line/20 ${
                        открыт ? "bg-line/20" : ""
                      }`}
                    >
                      <td className="px-5 py-1.5 text-left">
                        <span className="mr-1.5 inline-block w-3 text-fg-muted">
                          {открыт ? "▾" : "▸"}
                        </span>
                        {w.waiterName}
                        {!w.aboveThreshold && (
                          <span className="ml-2 text-xs text-fg-muted">
                            ниже {money(THRESHOLD)} — не делится
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums">{moneyOrDash(w.total)}</td>
                      <td className="px-2 py-1.5 tabular-nums text-fg-muted">
                        {moneyOrDash(-w.toAdmin)}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums text-fg-muted">
                        {moneyOrDash(-w.toCashier)}
                      </td>
                      <td className="px-5 py-1.5 tabular-nums text-sand">
                        {money(w.accrued)}
                      </td>
                    </tr>
                    {открыт && (
                      <tr className="border-b border-line/40">
                        <td colSpan={5} className="bg-ink/40 px-5 py-3">
                          <WaiterEntries
                            waiterId={w.waiterId}
                            earned={w.total}
                            live={live}
                            events={events}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Хостес и кальянный бар — своей таблицей, а не строками среди
            официантов. У них нет ни порога, ни отчислений, и попади они
            в ту таблицу, колонки «админу» и «кассиру» пришлось бы оставить
            пустыми — а пустая клетка однажды окажется заполненной. */}
        {sideTotal > 0 && (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full border-collapse text-right text-sm">
              <thead className="text-xs text-fg-muted">
                <tr className="border-b border-line">
                  <th className="px-5 py-2 text-left font-normal">
                    хостес и кальянный бар
                  </th>
                  <th className="px-2 py-2 font-normal">наличные</th>
                  <th className="px-2 py-2 font-normal">терминал</th>
                  <th className="px-2 py-2 font-normal">QR</th>
                  <th className="px-2 py-2 font-normal">сбор</th>
                  <th className="px-5 py-2 font-normal">начислено</th>
                </tr>
              </thead>
              <tbody>
                {(["hostess", "hookah"] as const).flatMap((c) =>
                  side[c].rows
                    .filter((r) => r.total > 0)
                    .map((r) => {
                      const ключ = `${c}-${r.payeeId}`;
                      const открыт = openWaiter === ключ;
                      return (
                        <Fragment key={ключ}>
                          <tr
                            onClick={() =>
                              setOpenWaiter(открыт ? null : ключ)
                            }
                            className={`cursor-pointer border-b border-line/40 hover:bg-line/20 ${
                              открыт ? "bg-line/20" : ""
                            }`}
                          >
                            <td className="px-5 py-1.5 text-left">
                              <span className="mr-1.5 inline-block w-3 text-fg-muted">
                                {открыт ? "▾" : "▸"}
                              </span>
                              {r.payeeName}
                              <span className="ml-2 text-xs text-fg-muted">
                                {c === "hookah" ? "кальянный бар" : "хостес"}
                              </span>
                            </td>
                            <td className="px-2 py-1.5 tabular-nums">
                              {moneyOrDash(r.cash)}
                            </td>
                            <td className="px-2 py-1.5 tabular-nums">
                              {moneyOrDash(r.terminal)}
                            </td>
                            <td className="px-2 py-1.5 tabular-nums">
                              {moneyOrDash(r.qr)}
                            </td>
                            <td className="px-2 py-1.5 tabular-nums">
                              {moneyOrDash(r.service)}
                            </td>
                            <td className="px-5 py-1.5 tabular-nums text-sand">
                              {money(r.total)}
                            </td>
                          </tr>
                          {открыт && (
                            <tr className="border-b border-line/40">
                              <td colSpan={6} className="bg-ink/40 px-5 py-3">
                                <WaiterEntries
                                  waiterId={r.payeeId}
                                  earned={r.total}
                                  live={live}
                                  events={events}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    }),
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Та же сноска, что в списке смен и на экране сотрудника: все суммы
            здесь — то, что дошло, а гость оставил больше. Человек, заходящий
            раз в месяц, иначе решит, что цифра неверная. */}
        {commissionAll > 0 && (
          <p className="border-t border-line px-5 py-3 text-sm text-fg-muted">
            Суммы — то, что <b className="font-medium text-fg">дошло</b>. Сбер
            удерживает 8 % с чаевых на терминале: гости оставили{" "}
            {money(grossAll)}, комиссия — {money(commissionAll)}. В списке
            записей ниже обе суммы стоят рядом.
          </p>
        )}
      </section>

      <h2 className="mt-8 text-sm text-fg-muted">
        Записи — {events.filter((e) => !e.deletedAt).length} живых из {events.length}
      </h2>
      {/* Питание видно в записях, но нет в начислениях — и это не забывчивость.
          Бэк-офис показывает, сколько человеку причитается; сколько ему выдали
          на руки за вычетом съеденного, считает смена. Править запись о питании
          при этом больше негде: смена умеет отменять только последнюю. */}
      {events.some((e) => e.kind === "staff" && !e.deletedAt) && (
        <p className="mt-1 text-xs text-fg-muted">
          Питание в записях есть, в начислениях — нет: это вычет при выплате,
          его считает смена.
        </p>
      )}

      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-right text-sm">
          <thead className="text-xs text-fg-muted">
            <tr className="border-b border-line">
              <th className="py-2 pr-3 text-left font-normal">время</th>
              <th className="px-3 py-2 text-left font-normal">вид</th>
              <th className="px-3 py-2 text-left font-normal">стол</th>
              <th className="px-3 py-2 text-left font-normal">кому</th>
              <th className="px-3 py-2 font-normal">гость оставил</th>
              <th className="px-3 py-2 font-normal">дошло</th>
              <th className="py-2 pl-3 font-normal"> </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <EventRow
                key={e.key}
                event={e}
                onEdit={() => setEditing(e)}
                onCancel={() => setCancelling(e)}
              />
            ))}
          </tbody>
        </table>
        {events.length === 0 && (
          <p className="py-6 text-fg-muted">За эту смену записей нет.</p>
        )}
      </div>

      {data.changes.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm text-fg-muted">Правки состава смены</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {data.changes.map((c, i) => (
              <li key={i} className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm">
                <span className="text-fg-muted">{moment(c.at)} · </span>
                {c.managerName}: {describeCrewChange(c, nameOf)}
                {c.note && <div className="text-fg-muted">— {c.note}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing && (
        <EventEditor
          day={day}
          event={editing}
          live={live}
          crew={crew}
          people={people}
          shift={shift}
          onClose={() => setEditing(null)}
        />
      )}
      {cancelling && (
        <CancelDialog
          day={day}
          event={cancelling}
          live={live}
          crew={crew}
          onClose={() => setCancelling(null)}
        />
      )}
      {addOpen && (
        <AddEntry
          day={day}
          live={live}
          crew={crew}
          shift={shift}
          onClose={() => setAddOpen(false)}
        />
      )}

      {crewOpen && (
        <CrewEditor
          day={day}
          shift={shift}
          live={live}
          crew={crew}
          people={people}
          onClose={() => setCrewOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Записи одного официанта за смену — то, из чего сложилось «заработано».
 *
 * ⚠️ Здесь именно ЗАПИСИ, а не итоги по видам денег. Разница дорогая:
 * 20.08.2026 на вопрос «что за терминал 538,20 у Лёши» ушло три круга
 * переписки, и всё потому, что 538,20 выглядело одной записью, а их было
 * три — 155, 220 и 210 ₽ на разных столах. Итог по человеку эту разницу
 * скрывает, а искать концы приходится по ленте терминала, где записи
 * лежат поштучно.
 *
 * 💡 Отсюда правило: экран, к которому приходят с вопросом «откуда эта
 * сумма», обязан отвечать строками, а не суммой поменьше.
 *
 * Поделённые чаевые показываем долей — столько человек и получил, — но
 * рядом говорим, из какой суммы она и с кем делили. Иначе доля 538,20
 * не найдётся ни в ленте, ни на бумаге: там пробита сумма гостя.
 */
function WaiterEntries({
  waiterId,
  earned,
  live,
  events,
}: {
  waiterId: number;
  /** Сколько человек заработал по раскладке — с этим и сверяемся. */
  earned: number;
  live: OfficeEntry[];
  events: ShiftEvent[];
}) {
  const мои = live
    .filter((e) => e.waiterId === waiterId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Питание считаем отдельно: это вычет при выплате, а не заработок,
  // и складывать его с чаевыми в одну сумму нельзя.
  const чаевые = мои.filter((e) => e.kind !== "staff");
  const питание = мои.filter((e) => e.kind === "staff");
  const сложено =
    Math.round(чаевые.reduce((s, e) => s + e.amount, 0) * 100) / 100;

  if (мои.length === 0) {
    return <p className="text-sm text-fg-muted">Записей за смену нет.</p>;
  }

  /** С кем делили эти чаевые. Пусто у обычной записи одному человеку. */
  const скемДелили = (e: OfficeEntry): string | null => {
    if (!e.splitGroup) return null;
    const событие = events.find((ev) => ev.key === e.splitGroup);
    if (!событие) return null;
    const другие = событие.waiters.filter((w) => w.id !== waiterId);
    return другие.length > 0 ? другие.map((w) => w.name).join(", ") : null;
  };

  return (
    <>
      <table className="w-full border-collapse text-right text-sm">
        <thead className="text-xs text-fg-muted">
          <tr>
            <th className="py-1 pr-3 text-left font-normal">время</th>
            <th className="px-3 py-1 text-left font-normal">вид</th>
            <th className="px-3 py-1 text-left font-normal">стол</th>
            <th className="px-3 py-1 font-normal">дошло</th>
            <th className="py-1 pl-3 text-left font-normal"> </th>
          </tr>
        </thead>
        <tbody>
          {чаевые.map((e) => {
            const делили = скемДелили(e);
            return (
              <tr key={e.id} className="border-t border-line/30">
                <td className="py-1 pr-3 text-left tabular-nums text-fg-muted">
                  {clock(e.createdAt)}
                </td>
                <td className="px-3 py-1 text-left">{KIND_TITLE[e.kind]}</td>
                <td className="px-3 py-1 text-left text-fg-muted">
                  {e.tableTitle ? `${e.hallTitle} · ${e.tableTitle}` : "—"}
                </td>
                <td className="px-3 py-1 tabular-nums">{money(e.amount)}</td>
                <td className="py-1 pl-3 text-left text-xs text-fg-muted">
                  {/* Гостя показываем, только когда он оставил не столько,
                      сколько дошло: комиссия или деление. Иначе повтор
                      одной и той же цифры дважды в строке. */}
                  {делили
                    ? `доля из ${money(событиеGross(e, events))} · с ${делили}`
                    : e.gross !== e.amount
                      ? `гость оставил ${money(e.gross)}`
                      : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Сходится ли список с раскладкой. Считаем ВТОРЫМ путём — прямо
          по записям — и говорим вслух, если не сошлось: запись человека,
          которого убрали из состава смены, в раскладку не попадает вовсе
          и пропадает молча. */}
      <p className="mt-2 text-xs text-fg-muted">
        {чаевые.length} {plural(чаевые.length, "запись", "записи", "записей")} на{" "}
        {money(сложено)}
        {Math.abs(сложено - earned) > 0.005 && (
          <b className="text-alert">
            {" "}
            — а в раскладке {money(earned)}. Разница {money(сложено - earned)}
          </b>
        )}
      </p>

      {питание.length > 0 && (
        <p className="mt-1 text-xs text-fg-muted">
          Питание:{" "}
          {питание
            .map((e) => `${clock(e.createdAt)} — ${money(e.amount)}`)
            .join(" · ")}
          . Вычитается при выплате, в заработок не входит.
        </p>
      )}
    </>
  );
}

/** Сколько гость оставил по всему событию — чтобы найти его в ленте. */
function событиеGross(e: OfficeEntry, events: ShiftEvent[]): number {
  const событие = events.find((ev) => ev.key === (e.splitGroup ?? e.id));
  return событие ? событие.gross : e.gross;
}

function EventRow({
  event,
  onEdit,
  onCancel,
}: {
  event: ShiftEvent;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const dead = event.deletedAt !== null;
  const replaced = event.replacedBy !== null;

  return (
    <tr className={`border-b border-line/40 ${dead ? "text-fg-muted" : ""}`}>
      <td className="py-2 pr-3 text-left tabular-nums">{clock(event.createdAt)}</td>
      <td className="px-3 py-2 text-left">{KIND_TITLE[event.kind]}</td>
      <td className="px-3 py-2 text-left">
        {event.tableTitle ? `${event.tableTitle} · ${event.hallTitle}` : "—"}
      </td>
      <td className="px-3 py-2 text-left">
        <span className={dead ? "line-through" : ""}>
          {event.waiters.map((w) => shortName(w.name)).join(" + ")}
        </span>
        {/* След правки. Отмена ради замены и отмена насовсем выглядят в базе
            одинаково, а читаться должны по-разному. */}
        {event.corrects && (
          <div className="text-xs text-sand">
            поправила {event.managerName ?? "бэк-офис"}
            {event.note && ` — ${event.note}`}
          </div>
        )}
        {dead && (
          <div className="text-xs">
            {replaced ? "заменено правкой" : "отменено"}
            {event.deletedByName && ` · ${event.deletedByName}`}
            {event.deletedAt && ` · ${moment(event.deletedAt)}`}
            {event.deletedNote && ` — ${event.deletedNote}`}
          </div>
        )}
      </td>
      <td className={`px-3 py-2 tabular-nums ${dead ? "line-through" : ""}`}>
        {money(event.gross)}
      </td>
      <td className={`px-3 py-2 tabular-nums ${dead ? "line-through" : ""}`}>
        {event.amount === event.gross ? "—" : money(event.amount)}
      </td>
      <td className="py-2 pl-3 text-right whitespace-nowrap">
        {!dead && (
          <>
            <button onClick={onEdit} className="text-sand underline">
              поправить
            </button>
            <button onClick={onCancel} className="ml-3 text-fg-muted underline">
              отменить
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

/**
 * Отмена без замены.
 *
 * Тоже с предпросмотром: убрать запись — это тоже подвинуть всю смену,
 * и человек может провалиться под порог ровно так же, как перешагнуть его.
 */
function CancelDialog({
  day,
  event,
  live,
  crew,
  onClose,
}: {
  day: string;
  event: ShiftEvent;
  live: DayData["live"];
  crew: DayData["crew"];
  onClose: () => void;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const before = useMemo(() => splitOffice(live, crew, day), [live, crew, day]);
  const after = useMemo(
    () => splitOffice(live.filter((r) => eventKey(r) !== event.key), crew, day),
    [live, event.key, crew, day],
  );

  async function run() {
    setBusy(true);
    setFailed(null);
    const answer = await cancelEvent({ businessDay: day, key: event.key, note });
    setBusy(false);
    if ("error" in answer) {
      setFailed(answer.error);
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <Overlay onClose={onClose}>
      <div className="border-b border-line px-5 py-3">
        <div className="text-base">Отменить запись</div>
        <div className="text-sm text-fg-muted">
          {clock(event.createdAt)} · {KIND_TITLE[event.kind]} {money(event.gross)} ·{" "}
          {event.waiters.map((w) => shortName(w.name)).join(" + ")}
        </div>
      </div>

      <div className="flex flex-col gap-5 px-5 py-4">
        <p className="text-sm text-fg-muted">
          Запись не сотрётся: она останется в истории перечёркнутой, с вашим
          именем и временем. Стереть строку нельзя в принципе — это денежный
          документ.
        </p>

        <Field label="Зачем отменяем — по желанию">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="например: гость забрал чаевые обратно"
            className="w-full rounded-xl border border-line bg-ink px-3 py-2"
          />
        </Field>

        <Compare before={before} after={after} />
        {failed && <p className="text-sm text-alert">{failed}</p>}
      </div>

      <div className="sticky bottom-0 flex gap-3 border-t border-line bg-surface px-5 py-3">
        <button
          disabled={busy}
          onClick={run}
          className="rounded-xl border border-alert px-5 py-2.5 font-medium text-alert disabled:opacity-40"
        >
          {busy ? "Отменяю…" : "Отменить запись"}
        </button>
        <button onClick={onClose} className="px-3 text-fg-muted underline">
          не отменять
        </button>
      </div>
    </Overlay>
  );
}

function Total({
  label,
  value,
  note,
  strong,
}: {
  label: string;
  value: number;
  note?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/40 py-1.5">
      <div>
        <span className={strong ? "" : "text-sm text-fg-muted"}>{label}</span>
        {note && <div className="text-xs text-fg-muted">{note}</div>}
      </div>
      <span className={`tabular-nums ${strong ? "text-lg" : "text-sm"}`}>
        {moneyOrDash(value)}
      </span>
    </div>
  );
}

/**
 * Что именно поменяли в составе — словами и только изменившееся.
 *
 * «администратор Анна К. → Анна К.» не говорит ничего, а прочитать мимо него
 * нельзя: строка про деньги, и в ней должно быть видно только то, что поехало.
 */
function describeCrewChange(
  c: DayData["changes"][number],
  nameOf: (id: number | null) => string,
): string {
  const parts: string[] = [];

  const added = c.after.crew.filter((id) => !c.before.crew.includes(id));
  const removed = c.before.crew.filter((id) => !c.after.crew.includes(id));
  if (added.length > 0) parts.push(`добавлены ${added.map(nameOf).join(", ")}`);
  if (removed.length > 0) parts.push(`убраны ${removed.map(nameOf).join(", ")}`);

  const roles: [string, number | null, number | null][] = [
    ["вносил записи", c.before.operator, c.after.operator],
    ["администратор", c.before.admin, c.after.admin],
    // У смен до 19.08.2026 второго администратора в следе нет вовсе:
    // поле появилось позже. `?? null` — чтобы «не указан → не указан»
    // не попало в список изменений и не выглядело правкой.
    ["второй администратор", c.before.admin2 ?? null, c.after.admin2 ?? null],
    ["кассир", c.before.cashier, c.after.cashier],
  ];
  for (const [title, was, now] of roles) {
    if (was !== now) parts.push(`${title}: ${nameOf(was)} → ${nameOf(now)}`);
  }

  return parts.length > 0 ? parts.join("; ") : "состав пересохранён без изменений";
}

/** «Яна Миллес» → «Яна М.»: в таблице важна плотность, а не полнота. */
function shortName(name: string): string {
  const [first, second] = name.split(" ");
  return second ? `${first} ${second[0]}.` : first;
}
