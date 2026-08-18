"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
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
import { HOOKAH_POT, getHookahPeople, getManualPeople, getQuickRestoPeople } from "@/lib/people";
import ShiftHistory from "@/components/ShiftHistory";
import EntryEditor from "@/components/EntryEditor";
import { buildEvents } from "@/lib/events";
import QrTipScreen from "@/components/QrTipScreen";
import SideScreen from "@/components/SideScreen";
import StaffScreen from "@/components/StaffScreen";
import { COMMISSION_RATE, netAmount, shares, splitShift, splitSide } from "@/lib/split";
import {
  flushQueue,
  isStaleDeploy,
  mergeEntries,
  pendingEntries,
  pendingSummary,
  queueState,
  queueStateOnServer,
  subscribeQueue,
} from "@/lib/offline";
import { readSnapshot, saveSnapshot } from "@/lib/snapshot";
import PendingBar from "@/components/PendingBar";
import {
  cancel,
  correct,
  distributeQr,
  exportMark,
  listByDay,
  markShiftExported,
  pendingQrTips,
  save,
} from "@/lib/storage";
import type { ExportMark } from "@/lib/storage";
import type {
  Contour,
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
 * Как часто пробовать дослать то, что ждёт отправки.
 *
 * Браузер сообщает о появлении сети сам, но верить только ему нельзя:
 * «сеть появилась» он говорит и когда телефон подключился к точке доступа,
 * из которой в интернет ещё не выйти. Поэтому кроме события есть таймер.
 * Десять секунд — деньги не должны ждать дольше, а стоит пустая попытка
 * при выключенной сети ровно ничего.
 */
const FLUSH_MS = 10_000;

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
  // Записи, про которые известно от базы. То, что ещё не доехало, лежит
  // в очереди отправки и подмешивается ниже — на экране это одно и то же.
  const [fromDb, setFromDb] = useState<Entry[]>([]);
  /**
   * Когда сняли снимок, на котором сейчас держится экран.
   *
   * Пусто — значит данные только что из базы. Заполнено — значит связи нет
   * и показано то, что было известно на телефоне. Скрывать такое нельзя:
   * второй администратор мог за это время что-то внести.
   */
  const [staleSince, setStaleSince] = useState<string | null>(null);
  /**
   * Записи, отменённые на этом телефоне.
   *
   * Пока отмена в очереди, её видно оттуда. Но как только очередь её отдаст,
   * а перечитать базу не выйдет, запись вернулась бы на экран — уже отменённая
   * в базе, но живая на глаз. Этот список держит её скрытой до конца сеанса;
   * после перезагрузки правду скажет база.
   */
  const [cancelledHere, setCancelledHere] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Поступления по QR, которые пришли, но ещё не разнесены по людям.
  const [qrTips, setQrTips] = useState<QrTip[]>([]);
  const [openQr, setOpenQr] = useState<QrTip | null>(null);
  /**
   * Кому раздавать открытое поступление.
   *
   * Обычно это состав текущей смены. Но забытое поступление разносят уже
   * на следующий вечер, а делить его надо между теми, кто работал ТОГДА:
   * иначе деньги гостя достанутся людям, которых в тот вечер в зале не было.
   * Поэтому для поступлений с прошлых дней состав читается отдельно, по их дню.
   */
  const [qrCrew, setQrCrew] = useState<Employee[]>([]);
  /**
   * Чтение упёрлось в то, что страница осталась от прошлой версии.
   *
   * Очередь отправки ловит это сама, но чтения идут мимо неё: экран открылся
   * до выкладки и просто перестал обновляться. Молчать нельзя — человек будет
   * смотреть на устаревшие цифры и не поймёт, почему они не меняются.
   */
  const [staleDeploy, setStaleDeploy] = useState(false);
  /** Когда смену выгружали для отчёта и кто. Пусто — значит ещё ни разу. */
  const [exported, setExported] = useState<ExportMark | null>(null);
  const [exporting, setExporting] = useState(false);
  const [hallId, setHallId] = useState(halls[0].id);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [editingCrew, setEditingCrew] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showStaff, setShowStaff] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  /**
   * Запись, открытая на правку: ключ события — метка группы у поделённых
   * чаевых, номер записи у обычной. Открывается из истории.
   */
  /**
   * Открыт ли экран хостес и кальянного бара, и какой котёл в нём выбран.
   *
   * Один экран на оба: администратор попадает туда одной кнопкой, а котёл
   * переключает внутри. Двумя кнопками в шапке пришлось бы жертвовать
   * местом под имя того, кто вносит записи, — оно и так обрезается.
   */
  const [showSide, setShowSide] = useState<Contour | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  // Очередь отправки: всё, что сделано, но ещё не доехало до базы.
  // Живёт вне экрана, в памяти телефона, поэтому подписываемся на неё,
  // а не храним в состоянии.
  const queue = useSyncExternalStore(
    subscribeQueue,
    queueState,
    queueStateOnServer,
  );

  // Есть ли сеть по мнению браузера. Мнение это неточное: «сети нет» —
  // правда почти всегда, «сеть есть» — далеко не всегда. Поэтому надпись
  // на экране опирается ещё и на то, чем закончилась последняя отправка.
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  /**
   * Перечитывает базу. Возвращает свежие записи или null, если не вышло.
   *
   * Заодно подтягиваем поступления по QR: они приходят сами, без чьего-либо
   * нажатия, и кассир должен увидеть их, ничего не запрашивая.
   */
  const refresh = useCallback(async (): Promise<Entry[] | null> => {
    try {
      const [fresh, qr] = await Promise.all([
        listByDay(day),
        pendingQrTips(),
      ]);
      setFromDb(fresh);
      setQrTips(qr);
      setStaleSince(null);
      return fresh;
    } catch (error) {
      if (isStaleDeploy(error)) setStaleDeploy(true);
      return null;
    }
  }, [day]);

  // Всё, что лежит в хранилище, спрашиваем одним заходом при открытии.
  // attempt меняется при нажатии «Повторить» — этим и перезапускается загрузка.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [today, people, records, last, qr, mark] = await Promise.all([
          getShift(day),
          getManualPeople(),
          listByDay(day),
          getLastShift(),
          pendingQrTips(),
          exportMark(day),
        ]);
        if (!alive) return;
        setShiftState(today);
        setManual(people);
        setFromDb(records);
        setLastShift(last);
        setQrTips(qr);
        setExported(mark);
        setStaleSince(null);
        setLoading("ready");
      } catch (error) {
        if (!alive) return;
        if (isStaleDeploy(error)) setStaleDeploy(true);
        // Связи нет. Поднимаемся на снимке прошлого удачного чтения:
        // без него администратор упёрся бы в отказ и не смог бы внести
        // ни одной записи — то есть ровно то, от чего уходим.
        const saved = readSnapshot(day);
        if (saved) {
          setShiftState(saved.shift);
          setManual(saved.manual);
          setFromDb(saved.entries);
          setLastShift(saved.lastShift);
          // Поступления по QR приходят с сервера и устареть могут сильно —
          // показывать их с телефона не будем, разносить всё равно не выйдет.
          setQrTips([]);
          setStaleSince(saved.savedAt);
          setLoading("ready");
          return;
        }
        // Снимка нет — за этот день на телефоне ничего не известно.
        // Пустой экран вместо ошибки выглядел бы как «за смену ничего нет»,
        // и администратор начал бы вводить всё заново поверх уже записанного.
        setLoading("failed");
      }
    })();
    // Ответ, пришедший после закрытия экрана, игнорируем.
    return () => {
      alive = false;
    };
  }, [day, attempt]);

  // Фоновая работа, пока приложение открыто: подтягивать чужие записи
  // и досылать свои. Об ошибках молчит — это не действие пользователя,
  // а служебная работа, и следующая попытка случится сама.
  useEffect(() => {
    if (loading !== "ready") return;

    const push = async () => {
      if (queueState().items.length === 0) return;
      await flushQueue();
      // Очередь ушла — перечитываем базу, чтобы на экране остались записи
      // из неё, а не их копии с телефона.
      if (queueState().items.length === 0) await refresh();
    };

    const both = () => {
      void push();
      void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") both();
    };

    const pullTimer = setInterval(() => void refresh(), REFRESH_MS);
    const pushTimer = setInterval(() => void push(), FLUSH_MS);
    // Свернули приложение, поговорили с гостем, вернулись — список свежий.
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", both);
    // Сразу при открытии: в очереди могло остаться со вчерашнего вечера.
    void push();

    return () => {
      clearInterval(pullTimer);
      clearInterval(pushTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", both);
    };
  }, [loading, refresh]);

  /**
   * Что видно на экране: записи из базы плюс те, что ещё ждут отправки.
   *
   * Иначе итог смены внизу оказался бы меньше настоящего ровно на
   * неотправленное, и администратор начал бы вводить заново поверх
   * уже введённого.
   */
  const entries = useMemo(
    () =>
      mergeEntries(fromDb, queue.items, day).filter(
        (e) => !cancelledHere.has(e.id),
      ),
    [fromDb, queue.items, day, cancelledHere],
  );

  /**
   * Событие, открытое на правку.
   *
   * Собирается из живых записей смены, а не из истории: править можно только
   * то, что сейчас в деньгах. Если запись успели отменить с другого телефона,
   * здесь окажется пусто — и экран правки просто не откроется.
   */
  const editingEvent = useMemo(() => {
    if (editing === null) return null;
    return buildEvents(entries).find((e) => e.key === editing) ?? null;
  }, [editing, entries]);

  /** Записи, которые ещё ждут отправки — их помечает история. */
  const waitingEntries = useMemo(
    () => pendingEntries(queue.items, day),
    [queue.items, day],
  );
  /** То же словами: «2 записи и 1 отмена». */
  const waitingSummary = useMemo(
    () => pendingSummary(queue.items),
    [queue.items],
  );

  // Снимок для следующего открытия без сети. Пишем при каждом изменении:
  // так на телефоне всегда лежит самое свежее из того, что известно.
  useEffect(() => {
    if (loading !== "ready") return;
    saveSnapshot({ day, shift, lastShift, manual, entries: fromDb });
  }, [loading, day, shift, lastShift, manual, fromDb]);

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
  /** Хостес этого вечера. Отмечаются в составе смены, в зал не входят. */
  const hostessPeople = useMemo(
    () => everyone.filter((p) => shift.hostess.includes(p.id)),
    [everyone, shift.hostess],
  );
  /**
   * Кальянщики смены и общий котёл бара.
   *
   * Котёл стоит первым и есть всегда, даже когда никого не отметили: бывает,
   * что администратор не знает, кто обслуживал, и деньги всё равно должны
   * куда-то лечь. Запасной путь, который видно, лучше записи, которой
   * не случилось.
   */
  const hookahPeople = useMemo(() => {
    const onShift = getHookahPeople().filter((p) => shift.hookah.includes(p.id));
    return [HOOKAH_POT, ...onShift];
  }, [shift.hookah]);

  const sideSplit = useMemo(
    () => ({
      hostess: splitSide(entries, "hostess", hostessPeople),
      hookah: splitSide(entries, "hookah", hookahPeople),
    }),
    [entries, hostessPeople, hookahPeople],
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
      // Имена едут вместе с составом. Иначе смена хранит одни номера, а имя
      // ищется в справочнике — и человек, убранный из дописанных вручную,
      // превращается в безымянные деньги. За август 2026 так выпало
      // 44 998,72 ₽ по девяти сменам.
      const справочник = [...everyone, ...getHookahPeople()];
      const names: Record<string, string> = { ...(next.names ?? {}) };
      const назван = [
        ...next.crew,
        ...next.hostess,
        ...next.hookah,
        next.operator,
        next.admin,
        next.cashier,
      ];
      for (const id of назван) {
        if (id === null) continue;
        const кто = справочник.find((p) => p.id === id);
        if (кто) names[String(id)] = кто.name;
      }
      next = { ...next, names };
      // Уходит через очередь: без сети состав всё равно сохранится на телефоне
      // и доедет позже, а вечер можно начинать сразу.
      await setShift(day, next);
      setShiftState(next);
      setLastShift(next);
      setEditingCrew(false);
    } catch {
      setToast({ text: "Смена не сохранилась — проверьте связь", bad: true });
    }
  }

  /**
   * Показывает записи на экране, не дожидаясь ответа базы.
   *
   * Нужно, чтобы запись не мигнула и не пропала: пока она в очереди,
   * её видно из очереди, но как только очередь её отдала, а перечитать
   * базу не вышло, она исчезла бы с экрана, хотя в базе уже лежит.
   */
  function showLocally(rows: Entry[]) {
    setFromDb((prev) => {
      const known = new Set(prev.map((e) => e.id));
      const added = rows.filter((e) => !known.has(e.id));
      return added.length === 0 ? prev : [...added, ...prev];
    });
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
    showLocally(rows);
    // Перечитываем базу в фоне: экран уже показывает запись, ждать нечего.
    void refresh();
    const waiting = queueState().items.length > 0;
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
      // Когда записи ждут отправки, говорим об этом прямо в подтверждении:
      // человек должен понимать, что запись сделана, но в базу ещё не ушла.
      text:
        `${picked.table.title} · ${sum} · ${who} · ${KIND_LABEL[kind]}` +
        (waiting ? " · ждёт отправки" : ""),
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
  /**
   * Открывает поступление на разнос.
   *
   * Для сегодняшнего берём состав текущей смены. Для забытого с прошлых дней
   * читаем состав того вечера: делить его между сегодняшними — значит отдать
   * деньги гостя людям, которых тогда в зале не было.
   */
  async function openQrTip(tip: QrTip) {
    if (tip.businessDay === day) {
      setQrCrew(crew);
      setOpenQr(tip);
      return;
    }
    try {
      const past = await getShift(tip.businessDay);
      const people = everyone.filter((p) => past.crew.includes(p.id));
      if (people.length === 0) {
        // Состава за тот день нет — разделить не на кого, и придумывать
        // получателей нельзя. Такое чинится в бэк-офисе, где видно всю смену.
        setToast({
          text: `Смена за ${formatBusinessDay(tip.businessDay)} не заполнена — разнести не на кого`,
          bad: true,
        });
        return;
      }
      setQrCrew(people);
      setOpenQr(tip);
    } catch {
      setToast({ text: "Не удалось прочитать ту смену — проверьте связь", bad: true });
    }
  }

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
      // День берём у самого поступления, а не текущий. Забытое вчера
      // принадлежит вчерашней смене: там его заработали, там оно должно
      // войти в итоги и в отчёт. Записать его сегодняшним числом значило бы
      // занизить вчерашний вечер и на столько же завысить сегодняшний.
      businessDay: tip.businessDay,
      splitGroup: group,
    }));

    // Единственное действие, которое без сети не работает и в очередь
    // не кладётся: поступление приходит с сервера, и разнести его дважды
    // с разных телефонов нельзя. Без связи экран честно откажет.
    await distributeQr(tip.messageId, rows, operator.name);
    // На экране показываем только то, что относится к открытой смене.
    // Записи прошлого дня подмешивать сюда нельзя: они не входят
    // ни в сегодняшние итоги, ни в сегодняшнюю историю.
    if (tip.businessDay === day) showLocally(rows);
    await refresh();
    setToast({
      text:
        tip.businessDay === day
          ? `QR ${formatMoney(tip.amount)} · ${waiters.map((w) => w.short).join(", ")}`
          : `QR ${formatMoney(tip.amount)} за ${formatBusinessDay(tip.businessDay)} · ${waiters.map((w) => w.short).join(", ")}`,
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
    // Обед хостес принадлежит её котлу, а не залу: иначе он вычелся бы
    // из зальных денег, где этого человека нет вовсе, и просто пропал.
    const contour: Contour = shift.hostess.includes(waiter.id)
      ? "hostess"
      : "hall";
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
      contour,
      operatorId: operator.id,
      operatorName: operator.name,
      createdAt: new Date().toISOString(),
      businessDay: day,
      splitGroup: null,
    };
    await save([entry]);
    showLocally([entry]);
    void refresh();
    setToast({
      text:
        `Питание: −${formatMoney(amount)} · ${waiter.short}` +
        (queueState().items.length > 0 ? " · ждёт отправки" : ""),
      bad: false,
    });
    setShowStaff(false);
  }

  /**
   * Записывает чаевые хостес или кальянного бара.
   *
   * Ложится обычной записью — тот же автор, та же отмена, то же место
   * в истории, — но с пометкой котла. Стола нет: хостес чаевые оставляют
   * на выходе, а кальянному бару за стол зала не платят.
   *
   * Комиссии здесь взяться неоткуда. Наличные и сервисный сбор идут мимо
   * Сбера, а по QR он удерживает своё до нас — в приложение приходит уже
   * чистая сумма. Терминала у этих двоих нет вовсе.
   */
  async function addSide(input: {
    amount: number;
    kind: Kind;
    payee: Employee;
    contour: Contour;
  }) {
    if (!operator) return;
    const entry: Entry = {
      id: crypto.randomUUID(),
      hallId: null,
      hallTitle: null,
      tableId: null,
      tableTitle: null,
      waiterId: input.payee.id,
      waiterName: input.payee.name,
      amount: input.amount,
      gross: input.amount,
      commissionRate: 0,
      kind: input.kind,
      contour: input.contour,
      operatorId: operator.id,
      operatorName: operator.name,
      createdAt: new Date().toISOString(),
      businessDay: day,
      splitGroup: null,
    };
    await save([entry]);
    showLocally([entry]);
    void refresh();
    setToast({
      text:
        `${input.contour === "hookah" ? "Кальянный бар" : "Хостес"}: ` +
        `${formatMoney(input.amount)} · ${input.payee.short}` +
        (queueState().items.length > 0 ? " · ждёт отправки" : ""),
      bad: false,
    });
  }

  /**
   * Итоги открываем только на свежих данных.
   *
   * Именно отсюда выгружается отчёт, и собраться он должен из всех записей
   * смены, а не из тех, что этот телефон успел загрузить.
   */
  async function openSummary() {
    const fresh = await refresh();
    if (fresh === null) {
      setToast({
        text: "Не удалось обновить — цифры могут быть неполными",
        bad: true,
      });
    }
    setShowSummary(true);
  }

  /**
   * Выгрузка отчёта.
   *
   * Порядок жёсткий: сначала досылаем то, что ждёт, потом перечитываем базу,
   * и только потом собираем. Неполный отчёт — самая тихая из возможных ошибок,
   * её никто не заметит. Поэтому при сбое связи отчёт не собираем вовсе:
   * без базы нельзя знать, что внесли с другого телефона.
   */
  async function exportShift() {
    if (exporting) return;
    // Имя файла собирается так же, как в downloadExport. Называем его прямо:
    // «файл скачан» без имени не помогает — в загрузках их десятки.
    const fileName = `смена-${day}.json`;
    setExporting(true);
    try {
      await flushQueue().catch(() => undefined);
      const fresh = await refresh();
      if (fresh === null) {
        setToast({
          text: "Отчёт не собран: нет связи, данные могли быть неполными",
          bad: true,
        });
        return;
      }
      const waiting = queueState().items;
      const rows = mergeEntries(fresh, waiting, day);
      downloadExport(buildExport(day, rows, crew, shift, everyone));

      // Отмечаем в базе, а не в памяти телефона: вопрос «эту смену уже
      // выгружали?» задают позже и часто не с того телефона, где нажимали.
      // Не вышло — файл всё равно скачан, и говорить «не выгрузилось» нельзя.
      try {
        setExported(await markShiftExported(day, operator?.short ?? ""));
      } catch {
        setToast({
          text: `Файл ${fileName} скачан, но отметку в базе поставить не удалось`,
          bad: true,
        });
        return;
      }

      if (waiting.length > 0) {
        // Ждущие записи в отчёт включены — деньги есть деньги. Но в базе их
        // ещё нет, и сказать об этом надо: иначе отчёт и база разойдутся.
        setToast({
          text: `Отчёт собран, но в базу ещё не ушли: ${pendingSummary(waiting)}`,
          bad: true,
        });
        return;
      }
      // Раньше при успехе не показывалось ничего: файл падал в загрузки молча,
      // и администратор не знал, получилось или нет. Замечание владельца
      // 10.08.2026.
      setToast({ text: `Смена выгружена · файл ${fileName}`, bad: false });
    } finally {
      setExporting(false);
    }
  }

  /**
   * Отменяет событие целиком: и обычную запись, и обе доли поделённых чаевых.
   *
   * Запись не стирается, а помечается отменённой — след остаётся в истории.
   * Кто отменил, тоже пишем: в смене работают двое. Без сети отмена ложится
   * в очередь следом за самой записью и уйдёт после неё — порядок строгий.
   *
   * Ошибку наружу отдаём: кто позвал, тот и решает, что сказать. С главного
   * экрана это всплывающее сообщение, с экрана правки — строка над кнопками.
   */
  async function cancelEvent(group: Entry[]) {
    if (!operator || group.length === 0) return;
    const sum = group.reduce((acc, e) => acc + e.amount, 0);
    await cancel(group[0].id, operator.id, operator.name);
    // Прячем с экрана сразу — и держим спрятанным до конца сеанса.
    setCancelledHere((prev) => {
      const next = new Set(prev);
      for (const e of group) next.add(e.id);
      return next;
    });
    void refresh();
    setToast({
      // Показываем сумму события, а не долю одного официанта, иначе отмена
      // выглядела бы как половинчатая.
      text: `Отменено: ${group[0].tableTitle ?? "по QR"} · ${formatMoney(sum)}`,
      bad: false,
    });
  }

  async function undoLast() {
    const last = entries[0];
    if (!last) return;
    // Поделённые чаевые в списке лежат отдельными строками, но событие было
    // одно — и отменяется оно целиком.
    const group = last.splitGroup
      ? entries.filter((e) => e.splitGroup === last.splitGroup)
      : [last];
    try {
      await cancelEvent(group);
    } catch {
      setToast({ text: "Не отменилось — проверьте связь", bad: true });
    }
  }

  /**
   * Сохраняет правку записи текущей смены.
   *
   * Строки уже собраны экраном правки — там же, где считался предпросмотр
   * «было / стало»: показать одно, а записать другое денежный экран не должен.
   * Здесь остаётся отправить их и убрать с экрана то, что они заменяют.
   */
  async function saveCorrection(rows: Entry[]) {
    if (!operator || !editingEvent || rows.length === 0) return;
    const replaced = editingEvent.rows.map((e) => e.id);
    await correct({
      businessDay: day,
      key: editingEvent.key,
      entries: rows,
      operatorId: operator.id,
      operatorName: operator.name,
    });
    // Новые строки показываем сразу, старые прячем до конца сеанса — тем же
    // способом, что и при отмене. Иначе, когда очередь отдаст правку, а
    // перечитать базу не выйдет, на экране вернулось бы старое.
    showLocally(rows);
    setCancelledHere((prev) => {
      const next = new Set(prev);
      for (const id of replaced) next.add(id);
      return next;
    });
    void refresh();
    setEditing(null);
    const gross = rows.reduce((sum, e) => sum + (e.gross ?? e.amount), 0);
    const who = rows.map((e) => e.waiterName).join(" + ");
    const waiting = queueState().items.length > 0;
    setToast({
      text:
        `Поправлено: ${rows[0].tableTitle ?? "по QR"} · ${formatMoney(gross)} · ${who}` +
        (waiting ? " · ждёт отправки" : ""),
      bad: false,
    });
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
          {/* Если что-то ждёт отправки, сказать об этом важнее всего:
              иначе человек решит, что вместе со связью потерялись и деньги. */}
          {queue.items.length > 0 && (
            <p className="text-sm text-alert">
              На телефоне ждут отправки: {waitingSummary}. Они сохранены и уйдут
              сами, как только появится связь.
            </p>
          )}
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

    // Правка открывается поверх истории: закрыв её, возвращаемся туда,
    // откуда пришли. Если событие исчезло — отменили со второго телефона —
    // экран правки не откроется, и человек увидит историю как есть.
    if (editingEvent) {
      return (
        <EntryEditor
          event={editingEvent}
          live={entries}
          crew={crew}
          // Кому можно приписать запись — зависит от котла. Зальную можно
          // переписать на официанта, чаевые хостес — только на хостес,
          // а кальянные — на кальянщика или на бар целиком.
          people={
            editingEvent.contour === "hookah"
              ? hookahPeople
              : editingEvent.contour === "hostess"
                ? hostessPeople
                : crew
          }
          operator={operator}
          halls={halls}
          day={day}
          onClose={() => setEditing(null)}
          onSave={saveCorrection}
          onDrop={async () => {
            await cancelEvent(editingEvent.rows);
            setEditing(null);
          }}
        />
      );
    }

    if (showHistory) {
      return (
        <ShiftHistory
          day={day}
          // История — экран самопроверки, и без сети он нужнее всего:
          // именно там смотрят «прошла моя запись или нет».
          pending={waitingEntries}
          cached={fromDb}
          cancelledHere={cancelledHere}
          onClose={() => setShowHistory(false)}
          onEdit={setEditing}
        />
      );
    }

    if (showSide) {
      return (
        <SideScreen
          contour={showSide}
          onContour={setShowSide}
          hostess={hostessPeople}
          hookah={hookahPeople}
          split={sideSplit}
          onCrew={() => {
            setShowSide(null);
            setEditingCrew(true);
          }}
          onCancel={() => setShowSide(null)}
          onConfirm={addSide}
        />
      );
    }

    if (showStaff) {
      return (
        <StaffScreen
          // Хостес едят так же, как официанты, и вычет у них такой же
          // (решение владельца 18.08.2026). Кальянщиков здесь нет: другое
          // юрлицо, заведение не кормит их за счёт чаевых.
          crew={[...crew, ...hostessPeople]}
          eaten={(id) =>
            splitShift(entries, crew, day).waiters.find((w) => w.waiterId === id)
              ?.staff ??
            sideSplit.hostess.rows.find((r) => r.payeeId === id)?.staff ??
            0
          }
          payout={(id) =>
            splitShift(entries, crew, day).waiters.find((w) => w.waiterId === id)
              ?.net ??
            sideSplit.hostess.rows.find((r) => r.payeeId === id)?.net ??
            0
          }
          onCancel={() => setShowStaff(false)}
          onConfirm={addStaff}
        />
      );
    }

    if (openQr) {
      return (
        <QrTipScreen
          tip={openQr}
          // Состав того вечера, а не обязательно текущего: см. openQrTip.
          crew={qrCrew}
          today={day}
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
          side={sideSplit}
          shift={shift}
          // Итоги считаются вместе с неотправленным — иначе сумма была бы
          // меньше настоящей. Но сказать, что часть ещё не в базе, надо.
          waiting={waitingSummary}
          exported={exported}
          exporting={exporting}
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
              onClick={() => setShowSide("hostess")}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted active:bg-surface"
            >
              хостес · кальян
            </button>
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

        {/* Всё, что ещё не доехало до базы, видно постоянно. Молчаливая
            очередь — худший вариант: человек решит, что всё записалось. */}
        <PendingBar
          waiting={queue.items.length}
          summary={waitingSummary}
          sending={queue.sending}
          online={online}
          durable={queue.durable}
          staleSince={staleSince}
          needsReload={queue.needsReload || staleDeploy}
          onFlush={() => {
            void flushQueue().then(() => refresh());
          }}
        />

        {/* Поступления по QR приходят сами, мимо зала и мимо кассира.
            Поэтому о них надо сказать, а не ждать, что кто-то догадается
            их поискать. Пока не разнесены — деньги ничьи. */}
        {qrTips.length > 0 && (
          <button
            onClick={() => void openQrTip(qrTips[0])}
            className={`mx-4 mb-2 rounded-xl border px-3 py-2.5 text-left ${
              // Забытое с прошлых смен подсвечиваем тревожным цветом: это уже
              // не «пришли деньги, разнеси», а «деньги висят ничьи со вчера».
              qrTips[0].businessDay === day
                ? "border-sand bg-sand/10 active:bg-sand/20"
                : "border-alert bg-alert/10 active:bg-alert/20"
            }`}
          >
            <div className="text-sm text-fg">
              Чаевые по QR: {formatMoney(qrTips[0].amount)} · {qrTips[0].team}
              {qrTips[0].businessDay !== day &&
                ` · за ${formatBusinessDay(qrTips[0].businessDay)}`}
            </div>
            <div className="text-xs text-fg-muted">
              {qrTips[0].businessDay !== day
                ? qrTips.length > 1
                  ? `не разнесли в ту смену · и ещё ${qrTips.length - 1} ждут`
                  : "не разнесли в ту смену — нажмите, деньги до сих пор ничьи"
                : qrTips.length > 1
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
                {plural(entryCount, "запись", "записи", "записей")}
                {/* Неотправленное входит в сумму: иначе итог был бы меньше
                    настоящего, и администратор начал бы вводить заново
                    поверх уже введённого. Сколько именно ждёт отправки,
                    сказано полосой выше — здесь только пометка. */}
                {queue.items.length > 0 && " · не всё отправлено"} · итоги ›
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
