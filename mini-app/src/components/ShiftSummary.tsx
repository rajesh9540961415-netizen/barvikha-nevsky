"use client";

import { useEffect, useState } from "react";
import { formatBusinessDay, formatMoney } from "@/lib/businessDay";
import { посчитать } from "@/lib/hookahMotivation";
import type { МотивацияСмены } from "@/lib/hookahMotivation";
import { getHookahCrew } from "@/lib/people";
import { hookahMotivation } from "@/lib/storage";
import { HOOKAH_POT_ID, THRESHOLD, adminShares, splitShift } from "@/lib/split";
import type { SideSplit } from "@/lib/split";
import type { Shift } from "@/lib/types";
import type { Employee, Entry } from "@/lib/types";
import { BUILD } from "@/lib/version";

type Props = {
  day: string;
  entries: Entry[];
  crew: Employee[];
  /**
   * Что ещё не доехало до базы, словами: «2 записи и 1 отмена». Пусто —
   * значит всё в базе.
   *
   * В цифры это уже входит — деньги есть деньги. Но знать, что часть смены
   * пока живёт только на этом телефоне, надо: со второго телефона этих сумм
   * не видно, и итоги там будут другими.
   */
  waiting: string;
  onClose: () => void;
  onHistory: () => void;
  /**
   * Выгрузка живёт наверху намеренно: там перед сборкой перечитывается база.
   * Отчёт, собранный из половины записей, — самая тихая из ошибок.
   */
  onExport: () => void;
  /**
   * Когда смену выгружали и кто. Пусто — значит ещё ни разу.
   *
   * Раньше выгрузка не оставляла следа: файл падал в загрузки, а на экране
   * не менялось ничего. Выгрузил или нет, выгрузил ли уже сменщик — узнать
   * было неоткуда, и смену выгружали дважды либо не выгружали вовсе.
   */
  exported: { at: string; by: string } | null;
  /** Идёт сборка отчёта — кнопка занята. */
  exporting: boolean;
  /** Хостес и кальянный бар: считаются рядом, ни с кем не делятся. */
  side: Record<"hostess" | "hookah", SideSplit>;
  /** Состав смены — нужен, чтобы знать, сколько администраторов. */
  shift?: Shift;
};

export default function ShiftSummary({
  day,
  entries,
  crew,
  side,
  shift,
  waiting,
  onClose,
  onHistory,
  onExport,
  exported,
  exporting,
}: Props) {
  const s = splitShift(entries, crew, day, shift?.halfShift ?? []);
  const paying = s.waiters.filter((w) => w.aboveThreshold).length;
  const наПолсмены = s.waiters.filter((w) => w.halfShift).length;
  // Внизу главного экрана стоит сумма ВСЕХ полученных денег, включая хостес
  // и кальянный бар. Если бы здесь она была только зальной, два экрана
  // показывали бы разные итоги за один вечер — и объяснить это было бы нечем.
  const sideTotal = side.hostess.total + side.hookah.total;
  /**
   * Сколько гости оставили за ВЕСЬ вечер и сколько из этого забрал Сбер.
   *
   * ⚠️ Складываем три котла. Пока считался только зал, на экране рядом
   * стояли «гости оставили 1 000 ₽» и «всего за смену 2 760 ₽» — две цифры,
   * которые не сходятся между собой. Владелец 20.08.2026: «цифры
   * не сходятся». Сумма, которая спорит сама с собой, обесценивает
   * и соседние: их перестают проверять.
   */
  const grossAll =
    Math.round((s.totalGross + side.hostess.totalGross + side.hookah.totalGross) * 100) / 100;
  const commissionAll =
    Math.round(
      (s.totalCommission + side.hostess.totalCommission + side.hookah.totalCommission) * 100,
    ) / 100;
  const админов = shift ? [shift.admin, shift.admin2].filter((x) => x !== null).length : 1;

  /**
   * Сходится ли разложенное по блокам с тем, что записали за вечер.
   *
   * Деньги могут потеряться между блоками, и молча: запись, приписанная
   * человеку, которого нет ни в официантах смены, ни в хостес, ни в баре,
   * не попадёт никуда. Так бывает, если состав смены поправили ПОСЛЕ ввода —
   * убрали человека, а его записи остались.
   *
   * Проверено 18.08.2026 на своей базе: 2 000 ₽ исчезли из всех блоков,
   * и ни один экран об этом не сказал. Считаем вторым путём — прямо
   * по записям — и, если не сошлось, говорим вслух. Ноль сюда не пишем:
   * строка, которая висит всегда, перестаёт быть сигналом.
   */
  const recorded = entries
    .filter((e) => e.kind !== "staff")
    .reduce((sum, e) => sum + e.amount, 0);
  const lost = Math.round((recorded - s.totalEarned - sideTotal) * 100) / 100;

  return (
    <div className="flex min-h-dvh flex-col pb-8">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <button
          onClick={onClose}
          aria-label="Назад"
          className="-ml-1 rounded-lg px-2 py-1 text-2xl leading-none text-fg-muted active:bg-surface"
        >
          ‹
        </button>
        <div>
          <div className="text-base">Итоги смены</div>
          <div className="text-xs text-fg-muted">
            {formatBusinessDay(day)} · {s.crewSize}{" "}
            {plural(s.crewSize, "официант", "официанта", "официантов")}
          </div>
        </div>
      </header>

      {waiting && (
        <div className="mx-4 mt-4 rounded-xl border border-alert bg-alert/10 px-3 py-2">
          <div className="text-sm text-fg">Не всё ушло в базу: {waiting}</div>
          <div className="text-xs text-fg-muted">
            в цифрах ниже это учтено, но со второго телефона их пока не видно
          </div>
        </div>
      )}

      <div className="px-4 pt-4">
        <div className="rounded-xl bg-surface p-4">
          {/* «Заработано залом», а не «за смену»: ниже стоит «всего за смену»,
              и два разных числа под похожими подписями читаются как ошибка. */}
          <div className="text-xs text-fg-muted">
            {sideTotal > 0 ? "заработано залом" : "заработано за смену"}
          </div>
          <div className="text-3xl tabular-nums">
            {formatMoney(s.totalEarned)}
          </div>
          {/* Комиссия названа прямо: иначе итог меньше введённого, и непонятно,
              куда делись деньги.
              Пока котёл один, говорим о нём здесь. Когда их три, сумма гостя
              относится ко всему вечеру и стоит внизу, рядом с «всего
              за смену», — иначе она спорит с соседней цифрой. */}
          {s.totalCommission > 0 && sideTotal === 0 && (
            <div className="mt-0.5 text-xs text-fg-muted">
              гости оставили {formatMoney(s.totalGross)} · комиссия −
              {formatMoney(s.totalCommission)}
            </div>
          )}

          <div className="mt-3 flex justify-between border-t border-line pt-2.5 text-sm">
            <span className="text-fg-muted">чаевые</span>
            <span className="tabular-nums">{formatMoney(s.totalTips)}</span>
          </div>
          <div className="text-xs text-fg-muted">
            наличные {formatMoney(s.totalCash)} ·{" "}
            <Terminal net={s.totalTerminal} gross={s.totalTerminalGross} />
            {s.totalQr > 0 && ` · QR ${formatMoney(s.totalQr)}`}
          </div>
          <div className="mt-2 flex justify-between text-sm">
            <span className="text-fg-muted">сервисный сбор</span>
            <span className="tabular-nums">{formatMoney(s.totalService)}</span>
          </div>

          {sideTotal > 0 && (
            <>
              <div className="mt-3 flex justify-between border-t border-line pt-2.5 text-sm">
                <span className="text-fg-muted">хостес и кальянный бар</span>
                <span className="tabular-nums">{formatMoney(sideTotal)}</span>
              </div>
              <div className="text-xs text-fg-muted">
                эти деньги не делятся: ни администратору, ни кассиру
              </div>
              <div className="mt-2 flex justify-between text-base">
                <span className="text-fg-muted">всего за смену</span>
                <span className="tabular-nums">
                  {formatMoney(s.totalEarned + sideTotal)}
                </span>
              </div>
              {commissionAll > 0 && (
                <div className="text-xs text-fg-muted">
                  гости оставили {formatMoney(grossAll)} · комиссия −
                  {formatMoney(commissionAll)}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {lost !== 0 && (
        <div className="mx-4 mt-3 rounded-xl border border-alert bg-alert/10 px-3 py-2">
          <div className="text-sm text-fg">
            Не разложено по блокам: {formatMoney(lost)}
          </div>
          <div className="text-xs text-fg-muted">
            эти деньги записаны, но приписаны тому, кого нет ни в официантах,
            ни в хостес, ни в кальянном баре — проверьте состав смены
          </div>
        </div>
      )}

      <div className="px-4 pt-3">
        {/* Администраторов может быть двое: смену делят надвое, доля —
            пополам. Показываем каждому его половину, а не общую сумму:
            человек смотрит сюда, чтобы узнать СВОИ деньги. */}
        {админов > 1 ? (
          adminShares(s.adminTotal, админов).map((доля, i) => (
            <Row
              key={i}
              label={`Администратору ${i + 1}`}
              value={доля}
              note={i === 0 ? "смену делили надвое, доля пополам" : undefined}
            />
          ))
        ) : (
          <Row label="Администратору" value={s.adminTotal} />
        )}
        <Row
          label="Кассиру"
          value={s.cashierTotal}
          note={
            s.crewSize > 0
              ? // Сумма кассира зависит от дня недели, поэтому показываем
                // её целиком: видно, из чего сложилась доля.
                //
                // ⚠️ Делитель — только те, кто отработал вечер целиком: вышедший
                // на часть смены кассиру не платит и в делителе не стоит
                // (решение владельца 15.09.2026). Поэтому, когда такие есть,
                // говорим об этом прямо — иначе цифра «÷ 3» при четырёх
                // официантах на экране выглядит ошибкой.
                `${formatMoney(s.cashierPool)} ÷ ${s.crewSize} = по ${formatMoney(s.cashierShare)} · платят ${paying}` +
                (наПолсмены > 0
                  ? ` · ${наПолсмены} на полсмены, не платят`
                  : "")
              : undefined
          }
        />
        {/* Питание — единственная строка, которая уменьшает выплату, а не
            распределяет её. Показываем отдельно, иначе «на руки» окажется
            меньше без объяснения. */}
        {s.totalStaff > 0 && (
          <Row
            label="Удержано за питание"
            value={-s.totalStaff}
            note="вычитается из выплаты, на порог не влияет"
          />
        )}
        <Row label="Официантам на руки" value={s.waitersNet} strong />
      </div>

      <div className="px-4 pt-4">
        <button
          onClick={onHistory}
          className="mb-2 w-full rounded-xl border border-line bg-surface py-3.5 text-base text-fg active:bg-surface-2"
        >
          История записей ›
        </button>
        <button
          disabled={entries.length === 0 || exporting}
          onClick={onExport}
          className={`w-full rounded-xl border py-3.5 text-base disabled:border-line disabled:text-fg-muted ${
            exported
              ? "border-line bg-surface text-fg"
              : "border-sand text-sand"
          }`}
        >
          {exporting
            ? "Собираю отчёт…"
            : exported
              ? "Выгрузить заново"
              : "Выгрузить смену для отчёта"}
        </button>
        {/* Отметка держится на экране, а не мигает сообщением на две секунды:
            вопрос «эту смену уже выгружали?» задают и через час, и назавтра,
            и часто не тот, кто нажимал кнопку. */}
        {exported ? (
          <div className="pt-2 text-center text-xs text-sand">
            ✓ выгружена в {clock(exported.at)}
            {exported.by && ` · ${exported.by}`}
          </div>
        ) : (
          <div className="pt-2 text-center text-xs text-fg-muted">
            ещё не выгружена
          </div>
        )}
      </div>

      {sideTotal > 0 && (
        <>
          <SidePart title="хостес" calc={side.hostess} />
          <SidePart title="кальянный бар" calc={side.hookah} />
        </>
      )}

      <МотивацияБара day={day} бар={side.hookah} />

      <div className="px-4 pb-1.5 pt-5 text-xs text-fg-muted">по официантам</div>
      <div className="flex flex-col gap-2 px-4">
        {s.waiters.map((w) => (
          <div key={w.waiterId} className="rounded-xl bg-surface p-3.5">
            <div className="flex items-baseline justify-between">
              <span className="text-base">{w.waiterName}</span>
              <span className="tabular-nums">{formatMoney(w.total)}</span>
            </div>
            <div className="mt-1.5 flex justify-between text-sm">
              <span className="text-fg-muted">чаевые</span>
              <span className="tabular-nums text-fg-muted">
                {formatMoney(w.tips)}
              </span>
            </div>
            <div className="text-xs text-fg-muted">
              наличные {formatMoney(w.cash)} ·{" "}
              <Terminal net={w.terminal} gross={w.terminalGross} />
              {w.qr > 0 && ` · QR ${formatMoney(w.qr)}`}
              {w.commission > 0 && ` · комиссия −${formatMoney(w.commission)}`}
            </div>
            <div className="mt-1 flex justify-between text-sm">
              <span className="text-fg-muted">сервисный сбор</span>
              <span className="tabular-nums text-fg-muted">
                {formatMoney(w.service)}
              </span>
            </div>

            {w.aboveThreshold ? (
              <div className="mt-2.5 border-t border-line pt-2.5 text-sm">
                <Line label="администратору" value={-w.toAdmin} />
                {w.toCashier > 0 ? (
                  <Line label="кассиру" value={-w.toCashier} />
                ) : (
                  <div className="flex justify-between text-fg-muted">
                    <span>кассиру</span>
                    {/* Причина важнее самого нуля: «полсмены» и «только сбор» —
                        разные вещи, и спрашивают о них по-разному. */}
                    <span>
                      {w.halfShift
                        ? "полсмены — не платит"
                        : "только сбор — не делится"}
                    </span>
                  </div>
                )}
                {w.staff > 0 && <Line label="питание" value={-w.staff} />}
                <Payout value={w.net} />
              </div>
            ) : (
              <div className="mt-2.5 border-t border-line pt-2.5 text-sm">
                <div className="text-xs text-fg-muted">
                  меньше {formatMoney(THRESHOLD)} — не делится
                </div>
                {/* Питание вычитается и здесь: оно не зависит от того,
                    перешагнул человек порог или нет. Без этой строки
                    вычет исчез бы с экрана, но остался в деньгах. */}
                {w.staff > 0 && (
                  <div className="mt-1.5">
                    <Line label="питание" value={-w.staff} />
                    <Payout value={w.net} />
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Отметка сборки. Мелко и в самом низу: смене она не нужна, но когда
          спрашивают «а новая версия доехала?» — ответ здесь, а не в панели
          хостинга и не в разборе бандла. */}
      <div className="px-4 pt-6 text-right text-xs text-fg-muted">
        сборка {BUILD}
      </div>
    </div>
  );
}

function Row({
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
    <div className="flex items-baseline justify-between border-b border-line py-2.5 last:border-0">
      <div>
        <div className={strong ? "text-base" : "text-sm"}>{label}</div>
        {note && <div className="text-xs text-fg-muted">{note}</div>}
      </div>
      <span className={`tabular-nums ${strong ? "text-lg" : ""}`}>
        {formatMoney(value)}
      </span>
    </div>
  );
}

/**
 * Терминал двумя цифрами: сколько дошло и, в скобках, сколько оставил гость.
 *
 * Кассиры сверяют смену с лентой терминала, а в ленте пробита полная сумма.
 * Без второй цифры сверка не сходится ровно на комиссию Сбера, и её каждый
 * раз считают в уме. Просьба кассиров 08.08.2026.
 *
 * Скобки появляются только когда комиссию действительно удержали. Совпали
 * суммы — вторая цифра ничего не скажет, а строку удлинит.
 */
function Terminal({ net, gross }: { net: number; gross: number }) {
  return (
    <>
      терминал {formatMoney(net)}
      {gross > net && <span className="text-sand"> ({formatMoney(gross)})</span>}
    </>
  );
}

/**
 * Итог по человеку. Минус подсвечивается: значит он проел больше, чем
 * заработал, и это убыток смены, а не описка.
 */
function Payout({ value }: { value: number }) {
  return (
    <div className="mt-1.5 flex justify-between">
      <span className="text-fg-muted">на руки</span>
      <span className={`tabular-nums ${value < 0 ? "text-alert" : "text-sand"}`}>
        {formatMoney(value)}
      </span>
    </div>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <span className="text-fg-muted">{label}</span>
      <span className="tabular-nums text-fg-muted">{formatMoney(value)}</span>
    </div>
  );
}

/** «06:12» — время по часам того, кто смотрит. */
function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Блок хостес или кальянного бара.
 *
 * Строк меньше, чем у официанта, и намеренно: у этих денег нет ни порога,
 * ни долей — показывать нечего, кроме того, чем оставили. Пустой блок
 * не рисуем вовсе: место на экране дороже симметрии.
 *
 * Комиссия здесь всё же бывает — с 20.08.2026, у доли со стола, которую
 * гость оставил на зальном терминале и попросил поделить. Поэтому у строки
 * терминала показаны обе суммы: дошедшая и полная.
 */
/**
 * Мотивация кальянного бара в итогах смены.
 *
 * 🔴 **Заведено 16.09.2026 по просьбе владельца:** «чтобы администратор,
 * как за смены, видел, какой объём мотивации и по каким позициям нужно
 * будет выплатить сотрудникам». Вид назвала она же — **разбивка
 * по категориям: сколько в каждой продано и на какую сумму.**
 *
 * Экран «Мотивация бара» с теми же цифрами есть с 09.09.2026, но лежит
 * глубоко: главный экран → «Хостес и кальянный бар» → переключить на бар →
 * мелкая кнопка «мотивация» в углу. В конце смены администратор открывает
 * итоги, а мотивации там не было вовсе — и выходило, что общий объём выплат
 * за вечер в одном месте не виден.
 *
 * ⚠️ **Это не чаевые.** Доплату платит заведение за проданные кальяны,
 * в суммы хостес и бара выше она не входит и в отчёт по чаевым не идёт.
 * Поэтому блок стоит отдельно и подписан своим заголовком.
 *
 * ⚠️ **Свой запрос, а не общие данные экрана.** Продажи приезжают не из смены,
 * а из кассы бара, и сеть может подвести. Не вышло — блок молчит: итоги смены
 * это деньги людей, и падать из-за премии они не должны.
 */
function МотивацияБара({ day, бар }: { day: string; бар: SideSplit }) {
  const [данные, setДанные] = useState<МотивацияСмены | null>(null);

  useEffect(() => {
    let живо = true;
    hookahMotivation(day)
      .then((д) => живо && setДанные(д))
      .catch(() => {});
    return () => {
      живо = false;
    };
  }, [day]);

  if (!данные || данные.день === null) return null;

  const { поКатегориям, всего, штукВсего } = посчитать(
    данные.продажи,
    данные.ставки,
  );
  // Категории, которых в эту смену не продали, не показываем: строка с нулём
  // ничего не сообщает. Пустой итог — не показываем и блок целиком.
  const строки = поКатегориям.filter((к) => к.штук > 0);
  if (строки.length === 0) return null;

  const справочник = getHookahCrew();
  const имя = (id: number) =>
    справочник.find((p) => p.id === id)?.short ??
    данные.имена[String(id)] ??
    `№${id}`;

  return (
    <>
      <div className="flex items-baseline justify-between px-4 pb-1.5 pt-5">
        <span className="text-xs text-fg-muted">мотивация бара</span>
        <span className="text-xs tabular-nums text-fg-muted">
          {formatMoney(всего)}
        </span>
      </div>
      <div className="px-4">
        <div className="rounded-xl bg-surface p-3.5">
          {строки.map((к) => (
            <div
              key={к.категория}
              className="flex items-baseline justify-between py-1 text-sm"
            >
              <span>{к.категория}</span>
              <span className="text-fg-muted">
                <span className="tabular-nums">{к.штук.toLocaleString("ru-RU")}</span>{" "}
                шт ·{" "}
                <span className="tabular-nums text-fg">
                  {formatMoney(к.мотивация)}
                </span>
              </span>
            </div>
          ))}
          <div className="mt-1.5 flex items-baseline justify-between border-t border-line pt-2">
            <span>Итого</span>
            <span>
              <span className="tabular-nums text-fg-muted">
                {штукВсего.toLocaleString("ru-RU")}
              </span>{" "}
              <span className="text-fg-muted">шт ·</span>{" "}
              <span className="tabular-nums">{formatMoney(всего)}</span>
            </span>
          </div>

        </div>
      </div>

      <ПоКальянщикам мотивация={всего} состав={данные.бар} имя={имя} бар={бар} />
    </>
  );
}

/**
 * Сколько каждый кальянщик получит за вечер.
 *
 * 🔴 **Вид расчёта назвала владелец 16.09.2026:** «из общей суммы заработанных
 * денег за счёт чаевых и мотивации нужно вычесть конкретное питание человека,
 * тогда и получишь корректную сумму». То есть складываем ему всё, что он
 * заработал, и только потом снимаем ЕГО обед.
 *
 * 🔴 **Питание не трогает общий котёл.** Первым заходом я предложил вычитать
 * обед из общей суммы до деления — владелец: «это в корне неверный подход,
 * питание у каждого индивидуально, они набирают на свою конкретную сумму».
 * Так и есть: раздели мы котёл после вычета, за обед одного платили бы все.
 *
 * 🔴 **Общий котёл «Весь бар» делим ПОРОВНУ между отмеченными** — как
 * и мотивацию. Это не допущение от нехватки данных, а прямое решение
 * владельца 16.09.2026 на прямой вопрос: «и чаевые, и мотивация делятся
 * поровну».
 *
 * 💡 Без деления поровну личной суммы у кальянщика не вышло бы вовсе, а она
 * и нужна — из неё вычитается обед: именных чаевых у бара почти не бывает,
 * за сентябрь 2026 все 55 345 ₽ записаны на «Весь бар» и ни одной строки
 * на человека. Личные чаевые, если их всё-таки записали, идут сверх доли.
 *
 * ⚠️ Человек с обедом, но без отметки в составе, всё равно показывается:
 * иначе вычет исчез бы с экрана, оставшись в деньгах.
 */
function ПоКальянщикам({
  мотивация,
  состав,
  имя,
  бар,
}: {
  мотивация: number;
  состав: number[];
  имя: (id: number) => string;
  бар: SideSplit;
}) {
  if (состав.length === 0) {
    return (
      <div className="px-4 pt-2 text-xs text-fg-muted">
        Состав бара не отмечен — делить не на кого. Кальянщиков отмечают
        в составе смены, там же, где официантов.
      </div>
    );
  }

  const котёл = бар.rows.find((r) => r.payeeId === HOOKAH_POT_ID)?.total ?? 0;
  const доляКотла = котёл / состав.length;
  const доляМотивации = мотивация / состав.length;

  const свои = бар.rows.filter(
    (r) => r.payeeId !== HOOKAH_POT_ID && (r.total > 0 || r.staff > 0),
  );
  const люди = [...new Set([...состав, ...свои.map((r) => r.payeeId)])];

  return (
    <>
      <div className="px-4 pb-1.5 pt-4 text-xs text-fg-muted">
        по кальянщикам — чаевые и мотивация вместе
      </div>
      <div className="flex flex-col gap-2 px-4">
        {люди.map((id) => {
          const своё = бар.rows.find((r) => r.payeeId === id);
          const вСоставе = состав.includes(id);
          const чаевые = (вСоставе ? доляКотла : 0) + (своё?.total ?? 0);
          const доплата = вСоставе ? доляМотивации : 0;
          const питание = своё?.staff ?? 0;
          const наРуки = чаевые + доплата - питание;
          return (
            <div key={id} className="rounded-xl bg-surface p-3.5">
              <div className="flex items-baseline justify-between">
                <span className="text-base">{имя(id)}</span>
                <span className="tabular-nums">{доляДоДесятых(наРуки)}</span>
              </div>
              <div className="pt-1 text-xs text-fg-muted">
                {[
                  доплата > 0 && `мотивация ${доляДоДесятых(доплата)}`,
                  чаевые > 0 && `чаевые ${доляДоДесятых(чаевые)}`,
                  питание > 0 && `питание −${formatMoney(питание)}`,
                  !вСоставе && "в составе смены не отмечен",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          );
        })}
      </div>
      {/* Котёл делится поровну, и сказать об этом надо прямо: бар привык
          делить чаевые между собой сам, и цифра на экране должна быть
          объяснимой, а не просто правдоподобной. */}
      {котёл > 0 && (
        <div className="px-4 pt-1.5 text-xs text-fg-muted">
          чаевые «Весь бар» {formatMoney(котёл)} поделены поровну на{" "}
          {состав.length}{" "}
          {plural(состав.length, "человека", "человека", "человек")}
        </div>
      )}
    </>
  );
}

/**
 * «1 500 ₽», «2 266,7 ₽» — доля, округлённая до десятых рубля.
 *
 * Как на экране мотивации: владелец 08.09.2026 просила именно десятые,
 * а недостачу в пару рублей закрывает из кассы на месте. Копейки беречь
 * надо в долях ЗАЛА — там из них складывается выплата.
 */
function доляДоДесятых(сумма: number): string {
  const текст = (Math.round(сумма * 10) / 10).toLocaleString("ru-RU", {
    maximumFractionDigits: 1,
  });
  return `${текст.replace(/\s/g, "\u00a0")}\u00a0₽`;
}

function SidePart({ title, calc }: { title: string; calc: SideSplit }) {
  if (calc.total === 0) return null;
  return (
    <>
      <div className="flex items-baseline justify-between px-4 pb-1.5 pt-5">
        <span className="text-xs text-fg-muted">{title}</span>
        <span className="text-xs tabular-nums text-fg-muted">
          {formatMoney(calc.total)}
        </span>
      </div>
      <div className="flex flex-col gap-2 px-4">
        {calc.rows
          .filter((r) => r.total > 0)
          .map((r) => (
            <div key={r.payeeId} className="rounded-xl bg-surface p-3.5">
              <div className="flex items-baseline justify-between">
                <span className="text-base">{r.payeeName}</span>
                <span className="tabular-nums">{formatMoney(r.total)}</span>
              </div>
              {/* Показываем только то, что было. «Наличные 0 ₽» рядом
                  с сервисным сбором — не информация, а шум. */}
              <div className="text-xs text-fg-muted">
                {[
                  r.cash > 0 && `наличные ${formatMoney(r.cash)}`,
                  // Терминал бывает у них только вместе со столом: гость
                  // заплатил на зальном терминале и попросил поделить.
                  // Показываем и полную сумму — из неё Сбер взял свои 8 %,
                  // и без этой цифры вечер не сойдётся с лентой терминала.
                  r.terminal > 0 &&
                    `терминал ${formatMoney(r.terminal)} из ${formatMoney(r.terminalGross)}`,
                  r.qr > 0 && `QR ${formatMoney(r.qr)}`,
                  r.service > 0 && `сбор ${formatMoney(r.service)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {/* Питание — единственное, что уменьшает выплату хостес.
                  Показываем отдельной строкой: иначе «на руки» окажется
                  меньше начисленного без единого объяснения. */}
              {r.staff > 0 && (
                <>
                  <div className="mt-1 flex justify-between text-sm">
                    <span className="text-fg-muted">удержано за питание</span>
                    <span className="tabular-nums text-fg-muted">
                      −{formatMoney(r.staff)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-fg-muted">на руки</span>
                    <span className="tabular-nums">{formatMoney(r.net)}</span>
                  </div>
                </>
              )}
            </div>
          ))}
      </div>
    </>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
