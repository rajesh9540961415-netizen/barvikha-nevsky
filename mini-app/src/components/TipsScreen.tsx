"use client";

import { useEffect, useMemo, useState } from "react";
import AmountPad from "@/components/AmountPad";
import type { RecentEntry } from "@/components/AmountPad";
import ShiftCrew from "@/components/ShiftCrew";
import ShiftSummary from "@/components/ShiftSummary";
import TablePicker from "@/components/TablePicker";
import scheme from "@/data/tables.json";
import { businessDayKey, formatBusinessDay, formatMoney } from "@/lib/businessDay";
import { buildExport, downloadExport } from "@/lib/exportShift";
import type { Shift } from "@/lib/crew";
import { EMPTY_SHIFT, getLastShift, getShift, isReady, setShift } from "@/lib/crew";
import { getManualPeople, getQuickRestoPeople } from "@/lib/people";
import ShiftHistory from "@/components/ShiftHistory";
import QrTipScreen from "@/components/QrTipScreen";
import StaffScreen from "@/components/StaffScreen";
import { COMMISSION_RATE, netAmount, shares, splitShift } from "@/lib/split";
import {
  cancel,
  distributeQr,
  listByDay,
  pendingQrTips,
  save,
} from "@/lib/storage";
import type {
  Employee,
  Entry,
  Hall,
  Kind,
  QrTip,
  Scheme,
  Table,
} from "@/lib/types";

const { halls } = scheme as Scheme;

const KIND_LABEL: Record<Kind, string> = {
  cash: "наличные",
  terminal: "терминал",
  service: "сервисный сбор",
  qr: "QR",
  staff: "питание",
};

/**
 * Выбранный стол вместе со свежей записью по нему, если такая есть.
 *
 * Свежесть считается в момент выбора стола, а не при отрисовке: время —
 * величина изменчивая, и вычислять её во время рендера нельзя, иначе
 * результат будет прыгать при каждой перерисовке.
 */
type Picked = { hall: Hall; table: Table; recent: RecentEntry | null };
type Toast = { text: string; bad: boolean };
type Loading = "loading" | "ready" | "failed";

/**
 * Как часто перечитывать записи, пока приложение открыто.
 *
 * В смене работают двое — администратор и кассир, — и каждый видит только
 * то, что загрузил при открытии. Без обновления у них расходятся и точки
 * на столах, и итог внизу. 25 секунд — чтобы чужая запись появлялась
 * быстрее, чем успеешь дойти до следующего стола.
 */
const REFRESH_MS = 25_000;

/**
 * В пределах этого времени повторный ввод по тому же столу считается
 * подозрительным и вызывает вопрос.
 *
 * 15 минут: вчерашние задвоения шли с разницей в 10–15 секунд, а вторая
 * посадка за тот же стол случается заметно позже. Такое окно ловит ошибку
 * и не пристаёт с вопросами весь вечер.
 */
const RECENT_MS = 15 * 60_000;

export default function TipsScreen() {
  const [day] = useState(businessDayKey);
  const [loading, setLoading] = useState<Loading>("loading");
  const [attempt, setAttempt] = useState(0);
  const [shift, setShiftState] = useState<Shift>(EMPTY_SHIFT);
  const [lastShift, setLastShift] = useState<Shift>(EMPTY_SHIFT);
  const [manual, setManual] = useState<Employee[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  // Поступления по QR, которые пришли, но ещё не разнесены по людям.
  const [qrTips, setQrTips] = useState<QrTip[]>([]);
  const [openQr, setOpenQr] = useState<QrTip | null>(null);
  const [hallId, setHallId] = useState(halls[0].id);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [editingCrew, setEditingCrew] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showStaff, setShowStaff] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  // Всё, что лежит в хранилище, спрашиваем одним заходом при открытии.
  // attempt меняется при нажатии «Повторить» — этим и перезапускается загрузка.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [today, people, records, last, qr] = await Promise.all([
          getShift(day),
          getManualPeople(),
          listByDay(day),
          getLastShift(),
          pendingQrTips(day),
        ]);
        if (!alive) return;
        setShiftState(today);
        setManual(people);
        setEntries(records);
        setLastShift(last);
        setQrTips(qr);
        setLoading("ready");
      } catch {
        // Пустой экран вместо ошибки выглядел бы как «за смену ничего нет»,
        // и администратор начал бы вводить всё заново поверх уже записанного.
        if (alive) setLoading("failed");
      }
    })();
    // Ответ, пришедший после закрытия экрана, игнорируем.
    return () => {
      alive = false;
    };
  }, [day, attempt]);

  // Фоновое обновление: подтягивает записи, внесённые со второго телефона.
  // Экрана загрузки не показывает и об ошибках молчит — это не действие
  // пользователя, а служебная работа. Если связи нет, следующая попытка
  // случится через REFRESH_MS.
  useEffect(() => {
    if (loading !== "ready") return;
    let alive = true;

    const pull = async () => {
      try {
        // Заодно подтягиваем поступления по QR: они приходят сами, без чьего
        // либо нажатия, и кассир должен увидеть их, ничего не запрашивая.
        const [fresh, qr] = await Promise.all([
          listByDay(day),
          pendingQrTips(day),
        ]);
        if (!alive) return;
        setEntries(fresh);
        setQrTips(qr);
      } catch {
        // тихо: фоновое обновление не должно пугать сообщениями
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") pull();
    };

    const timer = setInterval(pull, REFRESH_MS);
    // Свернули приложение, поговорили с гостем, вернулись — список свежий.
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", pull);

    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", pull);
    };
  }, [day, loading]);

  const everyone = useMemo(
    () => [...getQuickRestoPeople(), ...manual],
    [manual],
  );
  const crew = useMemo(
    () => everyone.filter((p) => shift.crew.includes(p.id)),
    [everyone, shift.crew],
  );
  const operator = useMemo(
    () => everyone.find((p) => p.id === shift.operator) ?? null,
    [everyone, shift.operator],
  );
  // Внизу показываем полученные деньги. Питание — вычет, а не доход,
  // и складывать его с чаевыми в одну сумму нельзя.
  const total = useMemo(
    () =>
      entries
        .filter((e) => e.kind !== "staff")
        .reduce((sum, e) => sum + e.amount, 0),
    [entries],
  );
  // У QR-чаевых стола нет, поэтому точку на схеме зала им ставить не на чем.
  const usedTableIds = useMemo(
    () =>
      new Set(
        entries
          .map((e) => e.tableId)
          .filter((id): id is number => id !== null),
      ),
    [entries],
  );
  // Поделённые чаевые лежат отдельными строками, но для администратора это
  // одна запись за вечер. Считаем события, чтобы число внизу совпадало
  // с числом строк в истории — иначе они выглядели бы как расхождение.
  const entryCount = useMemo(() => {
    const groups = new Set<string>();
    let count = 0;
    for (const e of entries) {
      if (e.kind === "staff") continue;
      if (!e.splitGroup) {
        count += 1;
      } else if (!groups.has(e.splitGroup)) {
        groups.add(e.splitGroup);
        count += 1;
      }
    }
    return count;
  }, [entries]);

  useEffect(() => {
    if (!toast) return;
    // Сообщение об ошибке висит дольше: его надо успеть прочитать и понять,
    // что запись не прошла.
    const timer = setTimeout(() => setToast(null), toast.bad ? 5000 : 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  async function saveShift(next: Shift) {
    try {
      await setShift(day, next);
      setShiftState(next);
      setLastShift(next);
      setEditingCrew(false);
    } catch {
      setToast({ text: "Смена не сохранилась — проверьте связь", bad: true });
    }
  }

  /**
   * Записывает чаевые. Официантов может быть несколько: большой стол
   * обслуживают вдвоём, гость оставляет чаевые за стол целиком.
   *
   * В базу такие чаевые ложатся по строке на каждого, каждому своя доля.
   * Так доля попадает в заработок своего человека, а порог 1300 ₽, итоги
   * смены и отчёт продолжают работать без единой правки: для них это просто
   * обычные записи. Общая метка связывает строки, чтобы история показывала
   * их одним событием, а отмена убирала обе.
   */
  async function addEntry(amount: number, waiters: Employee[], kind: Kind) {
    if (!picked || !operator || waiters.length === 0) return;
    const split = waiters.length > 1;
    const group = split ? crypto.randomUUID() : null;
    // Комиссия удерживается со всей суммы сразу, и делится уже то, что дошло:
    // тогда доли складываются ровно в дошедшее, без копейки расхождения.
    const net = netAmount(amount, kind);
    const parts = shares(net, waiters.length);
    const grossParts = shares(amount, waiters.length);
    const now = new Date().toISOString();
    const rows: Entry[] = waiters.map((waiter, i) => ({
      id: crypto.randomUUID(),
      hallId: picked.hall.id,
      hallTitle: picked.hall.title,
      tableId: picked.table.id,
      tableTitle: picked.table.title,
      waiterId: waiter.id,
      waiterName: waiter.name,
      amount: parts[i],
      gross: grossParts[i],
      commissionRate: COMMISSION_RATE[kind],
      kind,
      operatorId: operator.id,
      operatorName: operator.name,
      // Время одно на всю группу: это одно событие, а не два подряд.
      createdAt: now,
      businessDay: day,
      splitGroup: group,
    }));
    // Ошибку не перехватываем: её ловит экран суммы и пишет прямо над своими
    // кнопками. Всплывающее сообщение легло бы поверх них — поверх тех самых,
    // на которые оно просит нажать ещё раз.
    await save(rows);
    setEntries(await listByDay(day));
    const who = split
      ? `${waiters.length === 2 ? "пополам" : "поровну"}: ${waiters.map((w) => w.short).join(", ")}`
      : waiters[0].short;
    // Когда часть суммы забрала комиссия, показываем обе цифры: администратор
    // ввёл одно, а записалось другое — про это он должен узнать сразу, а не
    // через месяц при сверке отчёта.
    const sum =
      net === amount
        ? formatMoney(amount)
        : `${formatMoney(amount)} → ${formatMoney(net)}`;
    setToast({
      text: `${picked.table.title} · ${sum} · ${who} · ${KIND_LABEL[kind]}`,
      bad: false,
    });
    // Экран суммы закрываем только после успеха: иначе на ошибке
    // введённое пропало бы и набирать пришлось бы заново.
    setPicked(null);
  }

  /**
   * Разносит поступление по QR на выбранных официантов.
   *
   * Записи ложатся обычными строками с видом «qr» — тогда порог 1300 ₽,
   * итоги смены и отчёт работают без правок. Стола и зала у них нет:
   * гость платил по чеку, а не за столом.
   *
   * Ошибку наружу не глотаем: её ловит экран распределения. Второй кассир
   * мог разнести это же поступление секундой раньше, и об этом надо сказать.
   */
  async function distributeQrTip(tip: QrTip, waiters: Employee[]) {
    if (!operator || waiters.length === 0) return;
    const group = waiters.length > 1 ? crypto.randomUUID() : null;
    const parts = shares(tip.amount, waiters.length);
    const now = new Date().toISOString();
    const rows: Entry[] = waiters.map((waiter, i) => ({
      id: crypto.randomUUID(),
      hallId: null,
      hallTitle: null,
      tableId: null,
      tableTitle: null,
      waiterId: waiter.id,
      waiterName: waiter.name,
      amount: parts[i],
      // Комиссию Сбер удержал до уведомления — пришедшая сумма уже чистая.
      gross: parts[i],
      commissionRate: 0,
      kind: "qr",
      operatorId: operator.id,
      operatorName: operator.name,
      createdAt: now,
      businessDay: day,
      splitGroup: group,
    }));

    await distributeQr(tip.messageId, rows, operator.name);
    const [fresh, qr] = await Promise.all([listByDay(day), pendingQrTips(day)]);
    setEntries(fresh);
    setQrTips(qr);
    setToast({
      text: `QR ${formatMoney(tip.amount)} · ${waiters.map((w) => w.short).join(", ")}`,
      bad: false,
    });
    setOpenQr(null);
  }

  /**
   * Записывает вычет за питание.
   *
   * Ложится обычной записью с видом «staff»: тот же автор, та же отмена,
   * то же место в истории. Стола у неё нет — питание пробивают отдельным
   * чеком, а не за столом в зале.
   */
  async function addStaff(amount: number, waiter: Employee) {
    if (!operator) return;
    const entry: Entry = {
      id: crypto.randomUUID(),
      hallId: null,
      hallTitle: null,
      tableId: null,
      tableTitle: null,
      waiterId: waiter.id,
      waiterName: waiter.name,
      amount,
      gross: amount,
      commissionRate: 0,
      kind: "staff",
      operatorId: operator.id,
      operatorName: operator.name,
      createdAt: new Date().toISOString(),
      businessDay: day,
      splitGroup: null,
    };
    await save([entry]);
    setEntries(await listByDay(day));
    setToast({
      text: `Питание: −${formatMoney(amount)} · ${waiter.short}`,
      bad: false,
    });
    setShowStaff(false);
  }

  /**
   * Итоги открываем только на свежих данных.
   *
   * Именно отсюда выгружается отчёт, и собраться он должен из всех записей
   * смены, а не из тех, что этот телефон успел загрузить.
   */
  async function openSummary() {
    try {
      setEntries(await listByDay(day));
    } catch {
      setToast({ text: "Не удалось обновить — цифры могут быть неполными", bad: true });
    }
    setShowSummary(true);
  }

  /**
   * Выгрузка отчёта. Перечитываем базу непосредственно перед сборкой:
   * неполный отчёт — самая тихая из возможных ошибок, её никто не заметит.
   * Поэтому при сбое связи отчёт не собираем вовсе.
   */
  async function exportShift() {
    try {
      const fresh = await listByDay(day);
      setEntries(fresh);
      downloadExport(buildExport(day, fresh, crew, shift, everyone));
    } catch {
      setToast({
        text: "Отчёт не собран: нет связи, данные могли быть неполными",
        bad: true,
      });
    }
  }

  async function undoLast() {
    const last = entries[0];
    if (!last || !operator) return;
    // Поделённые чаевые в списке лежат отдельными строками, но событие было
    // одно — и отменяется оно целиком. В сообщении показываем сумму гостя,
    // а не долю одного официанта, иначе отмена выглядела бы как половинчатая.
    const group = last.splitGroup
      ? entries.filter((e) => e.splitGroup === last.splitGroup)
      : [last];
    const sum = group.reduce((acc, e) => acc + e.amount, 0);
    try {
      // Запись не стирается, а помечается отменённой — след остаётся
      // в истории. Кто отменил, тоже пишем: в смене работают двое.
      await cancel(last.id, operator.id, operator.name);
      setEntries(await listByDay(day));
      setToast({
        text: `Отменено: ${last.tableTitle} · ${formatMoney(sum)}`,
        bad: false,
      });
    } catch {
      setToast({ text: "Не отменилось — проверьте связь", bad: true });
    }
  }

  function renderScreen() {
    if (loading === "loading") {
      return (
        <div className="flex min-h-dvh items-center justify-center">
          <p className="text-sm text-fg-muted">Загружаю смену…</p>
        </div>
      );
    }

    if (loading === "failed") {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-8 text-center">
          <p className="text-sm text-fg-muted">
            Не удалось загрузить смену. Записи никуда не делись — их просто
            сейчас не видно.
          </p>
          <button
            onClick={() => {
              setLoading("loading");
              setAttempt((n) => n + 1);
            }}
            className="rounded-xl bg-sand px-6 py-3 text-base text-ink"
          >
            Повторить
          </button>
        </div>
      );
    }

    // Смену надо собрать до первого ввода: без официантов запись некому приписать,
    // а без ответственного непонятно, кто её внёс.
    if (editingCrew || !isReady(shift) || !operator) {
      return (
        <ShiftCrew
          day={day}
          initial={isReady(shift) ? shift : lastShift}
          manual={manual}
          onManualChange={setManual}
          onDone={saveShift}
          onCancel={
            isReady(shift) && operator ? () => setEditingCrew(false) : undefined
          }
        />
      );
    }

    if (showHistory) {
      return <ShiftHistory day={day} onClose={() => setShowHistory(false)} />;
    }

    if (showStaff) {
      return (
        <StaffScreen
          crew={crew}
          split={splitShift(entries, crew, day).waiters}
          onCancel={() => setShowStaff(false)}
          onConfirm={addStaff}
        />
      );
    }

    if (openQr) {
      return (
        <QrTipScreen
          tip={openQr}
          crew={crew}
          onCancel={() => setOpenQr(null)}
          onConfirm={(waiters) => distributeQrTip(openQr, waiters)}
        />
      );
    }

    if (showSummary) {
      return (
        <ShiftSummary
          day={day}
          entries={entries}
          crew={crew}
          onClose={() => setShowSummary(false)}
          onExport={exportShift}
          onHistory={() => {
            setShowSummary(false);
            setShowHistory(true);
          }}
        />
      );
    }

    if (picked) {
      // Кто уже обслуживал этот стол сегодня — его и предлагаем. Если в прошлый
      // раз чаевые по столу делили, предлагаем всю группу: большой стол весь
      // вечер обслуживает одна и та же пара.
      const previous = entries.find((e) => e.tableId === picked.table.id);
      const suggested = !previous
        ? []
        : previous.splitGroup
          ? entries
              .filter((e) => e.splitGroup === previous.splitGroup)
              .map((e) => e.waiterId)
          : [previous.waiterId];
      return (
        <AmountPad
          hall={picked.hall}
          table={picked.table}
          crew={crew}
          suggestedWaiterIds={suggested}
          recent={picked.recent}
          onCancel={() => setPicked(null)}
          onConfirm={addEntry}
        />
      );
    }

    return (
      <div className="flex min-h-dvh flex-col">
        <header className="flex items-start justify-between gap-2 px-4 pb-3 pt-4">
          {/* min-w-0 и truncate: с двумя кнопками справа длинное имя
              ответственного переносило подпись на вторую строку. */}
          <div className="min-w-0">
            <h1 className="text-lg">Чаевые</h1>
            {/* Без слова «смена»: дата и так о ней говорит, а место нужно —
                иначе обрезается имя того, кто вносит записи. */}
            <p className="truncate text-xs text-fg-muted">
              {formatBusinessDay(day)} · вносит {operator.short}
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <button
              onClick={() => setShowStaff(true)}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted active:bg-surface"
            >
              питание
            </button>
            <button
              onClick={() => setEditingCrew(true)}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted active:bg-surface"
            >
              смена · {crew.length}
            </button>
          </div>
        </header>

        {/* Поступления по QR приходят сами, мимо зала и мимо кассира.
            Поэтому о них надо сказать, а не ждать, что кто-то догадается
            их поискать. Пока не разнесены — деньги ничьи. */}
        {qrTips.length > 0 && (
          <button
            onClick={() => setOpenQr(qrTips[0])}
            className="mx-4 mb-2 rounded-xl border border-sand bg-sand/10 px-3 py-2.5 text-left active:bg-sand/20"
          >
            <div className="text-sm text-fg">
              Чаевые по QR: {formatMoney(qrTips[0].amount)} · {qrTips[0].team}
            </div>
            <div className="text-xs text-fg-muted">
              {qrTips.length > 1
                ? `и ещё ${qrTips.length - 1} — нажмите, чтобы разнести`
                : "нажмите, чтобы разнести по официантам"}
            </div>
          </button>
        )}

        <TablePicker
          halls={halls}
          activeHallId={hallId}
          onHallChange={setHallId}
          onPick={(hall, table) => {
            // entries отсортированы свежими вперёд, поэтому find даёт последнюю.
            // Переспрашиваем только про свежую: за вечер стол сажают не раз,
            // и вторые чаевые через два часа — обычное дело, не ошибка.
            const last = entries.find((e) => e.tableId === table.id);
            const fresh =
              last && Date.now() - new Date(last.createdAt).getTime() < RECENT_MS
                ? last
                : null;
            // У поделённых чаевых показываем сумму гостя и всех, между кем
            // делили: по половине суммы и одному имени администратор свою же
            // запись не узнает, а вопрос задаётся именно чтобы узнал.
            const group = !fresh
              ? []
              : fresh.splitGroup
                ? entries.filter((e) => e.splitGroup === fresh.splitGroup)
                : [fresh];
            const recent: RecentEntry | null = fresh
              ? {
                  amount: group.reduce((sum, e) => sum + e.amount, 0),
                  who: group.map((e) => e.waiterName).join(" + "),
                  createdAt: fresh.createdAt,
                  operatorName: fresh.operatorName,
                }
              : null;
            setPicked({ hall, table, recent });
          }}
          usedTableIds={usedTableIds}
        />

        <div className="mt-auto border-t border-line px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={openSummary}
              className="-m-2 flex-1 rounded-lg p-2 text-left active:bg-surface"
            >
              <div className="text-lg tabular-nums">{formatMoney(total)}</div>
              <div className="text-xs text-fg-muted">
                за смену · {entryCount}{" "}
                {plural(entryCount, "запись", "записи", "записей")} · итоги ›
              </div>
            </button>
            {entries.length > 0 && (
              <button
                onClick={undoLast}
                className="shrink-0 rounded-lg border border-line px-3 py-2 text-sm text-fg-muted active:bg-surface"
              >
                Отменить
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Сообщение живёт рядом с экраном, а не внутри него: сказать «не сохранилось»
  // нужно и на экране смены, и на экране суммы, а не только на главном.
  return (
    <>
      {renderScreen()}
      {toast && (
        <div
          className={`pointer-events-none fixed inset-x-4 bottom-24 rounded-xl px-4 py-3 text-center text-sm ${
            toast.bad ? "bg-alert text-ink" : "bg-surface-2 text-fg"
          }`}
        >
          {toast.text}
        </div>
      )}
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
