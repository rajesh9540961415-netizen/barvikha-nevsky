"use client";

import { useState } from "react";
import SidePots from "./SidePots";
import { formatMoney } from "@/lib/businessDay";
import { COMMISSION_RATE, netAmount, shares } from "@/lib/split";
import type { Contour, Employee, Hall, Kind, Table } from "@/lib/types";

/**
 * Кому и в какой котёл ложится его доля.
 *
 * Котёл у каждого получателя свой: гость оставляет чаевые за стол целиком
 * и просит поделить их между официантом и кальянным баром. Зальная доля
 * делится с администратором и кассиром, барская не делится ни с кем —
 * и решается это здесь, в момент выбора, а не потом по роли человека.
 */
export type PickedPayee = { person: Employee; contour: Contour };

/**
 * Свежая запись по столу — в том виде, в каком её показывают в вопросе
 * о повторе.
 *
 * Не сама запись из базы: у поделённых чаевых там лежит доля одного
 * официанта, а узнать по ней ту самую запись нельзя — на экране была сумма
 * гостя и двое. Поэтому сюда приходит уже собранное событие.
 */
export type RecentEntry = {
  /** Сумма гостя целиком, а не доля одного. */
  amount: number;
  /** Официант или все, между кем делили: «Анна В. + Иван И.» */
  who: string;
  createdAt: string;
  operatorName: string;
};

type Props = {
  hall: Hall;
  table: Table;
  /** Официанты, отмеченные на смене. */
  crew: Employee[];
  /** Хостес этого вечера. Пусто — значит её не отметили в составе. */
  hostess: Employee[];
  /** Кальянщики смены и общий котёл бара. Котёл есть всегда. */
  hookah: Employee[];
  /** Открыть состав смены — если нужного человека в списке нет. */
  onCrew: () => void;
  /**
   * Кого предложить: обычно те, кто уже обслуживал этот стол сегодня.
   *
   * Список, а не один человек: если по столу в прошлый раз делили на двоих,
   * предлагаем обоих. Большой стол весь вечер обслуживает одна и та же пара,
   * и переотмечать её при каждом заходе — лишняя работа.
   */
  suggestedWaiterIds: number[];
  /**
   * Свежая запись по этому же столу, если она есть.
   *
   * Нужна, чтобы переспросить перед вводом. В смену 01.08.2026 по каждому
   * столу Невского зала чаевые внесли дважды — 33 раза подряд. Такой вопрос
   * поймал бы это на первом же столе.
   */
  recent: RecentEntry | null;
  onCancel: () => void;
  /**
   * Ждёт ответа хранилища. Пока ждём — кнопки заперты, чтобы двойной тап
   * по «Наличные» не записал одни и те же чаевые дважды.
   *
   * Официантов может быть несколько: большой стол обслуживают вдвоём, гость
   * оставляет чаевые за стол целиком, и сумма делится между ними поровну.
   */
  onConfirm: (
    amount: number,
    payees: PickedPayee[],
    kind: Kind,
  ) => Promise<void>;
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"];

/** «2 минуты назад» — чтобы понять, свежая ли это запись или из начала смены. */
function minutesAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "только что";
  if (mins === 1) return "минуту назад";
  if (mins < 5) return `${mins} минуты назад`;
  return `${mins} минут назад`;
}

/** Больше вводить и не нужно: защита от случайного лишнего нуля. */
const MAX_AMOUNT = 200_000;

export default function AmountPad({
  hall,
  table,
  crew,
  hostess,
  hookah,
  onCrew,
  suggestedWaiterIds,
  recent,
  onCancel,
  onConfirm,
}: Props) {
  const [digits, setDigits] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // Вопрос о повторе: способ оплаты, который ждёт подтверждения, и готовая
  // подпись «сколько минут назад». Подпись считается здесь, а не при
  // отрисовке: время меняется, и в рендере его вычислять нельзя.
  const [asking, setAsking] = useState<{ kind: Kind; ago: string } | null>(null);
  // Официантов может быть несколько — тогда сумма делится поровну.
  const [ids, setIds] = useState<number[]>(() => {
    // Подсказка могла остаться от человека, которого сегодня в смене нет.
    const suggested = suggestedWaiterIds.filter((id) =>
      crew.some((w) => w.id === id),
    );
    if (suggested.length > 0) return suggested;
    return crew.length === 1 ? [crew[0].id] : [];
  });
  /**
   * Кто выбран из хостес и кальянного бара — по порядку нажатий.
   *
   * Отдельно от зальных `ids` намеренно: у зала есть переключатель «делить
   * или нет», а сторона добавляется всегда вдобавок. Выбрать бар и при этом
   * никого не выбрать в зале тоже можно — гость мог оставить чаевые только
   * кальянщику.
   */
  const [side, setSide] = useState<{ id: number; contour: Contour }[]>([]);
  /** Какой котёл раскрыт. Раскрытым остаётся и тот, из кого уже выбрали. */
  const [openSide, setOpenSide] = useState<Contour | null>(null);
  // Деление включается отдельной кнопкой, а не вторым тапом по имени.
  // Иначе промах по соседней кнопке молча превратил бы обычные чаевые
  // в поделённые, и официант недосчитался бы половины.
  const [splitting, setSplitting] = useState(ids.length > 1);

  const amount = Number(digits || "0");
  // Порядок здесь тот же, что и в долях ниже: кто выбран первым, тот и первый
  // в раскладке, и ему же достаётся лишняя копейка от нечётной суммы.
  // Зал идёт первым, сторона за ним — так же они лягут в базу.
  const payees: PickedPayee[] = [
    ...ids.map((id) => ({
      person: crew.find((w) => w.id === id),
      contour: "hall" as Contour,
    })),
    ...side.map(({ id, contour }) => ({
      person: (contour === "hookah" ? hookah : hostess).find((p) => p.id === id),
      contour,
    })),
  ].filter((p): p is PickedPayee => p.person !== undefined);
  const parts = shares(amount, payees.length);
  const ready = amount > 0 && payees.length > 0 && !saving;
  /**
   * Есть ли в получателях кто-то со стороны.
   *
   * От этого зависит подпись под кнопками: у зальной доли будут вычтены
   * 20 % администратору и доля кассира, у барской и хостес — ничего.
   * Администратор должен видеть это до нажатия, а не узнавать из итогов.
   */
  const mixed = side.length > 0;
  // Сколько дойдёт, если нажать «Терминал». Показываем до нажатия: сумма
  // записывается не та, что набрана, и узнать об этом администратор должен
  // заранее, а не из сообщения постфактум.
  const terminalFee = Math.round(COMMISSION_RATE.terminal * 100);
  const terminalNet = netAmount(amount, "terminal");

  function press(key: string) {
    setFailed(false);
    if (key === "⌫") {
      setDigits((d) => d.slice(0, -1));
      return;
    }
    const next = (digits + key).replace(/^0+/, "");
    if (Number(next || "0") <= MAX_AMOUNT) setDigits(next);
  }

  function pickWaiter(id: number) {
    setFailed(false);
    setIds((current) => {
      if (!splitting) return [id];
      return current.includes(id)
        ? current.filter((x) => x !== id)
        : [...current, id];
    });
  }

  /**
   * Отмечает получателя из хостес или кальянного бара.
   *
   * Всегда добавлением, без переключателя «делить»: сторону выбирают именно
   * тогда, когда делят, — иначе её деньги вводят своим экраном.
   */
  function pickSide(id: number, contour: Contour) {
    setFailed(false);
    setSide((current) =>
      current.some((p) => p.id === id)
        ? current.filter((p) => p.id !== id)
        : [...current, { id, contour }],
    );
  }

  function toggleSplitting() {
    setFailed(false);
    if (splitting) {
      // Возврат к одному: оставляем первого выбранного, чтобы не отмечать
      // человека заново.
      setIds((current) => current.slice(0, 1));
      setSplitting(false);
      return;
    }
    setSplitting(true);
  }

  async function confirm(kind: Kind) {
    if (!ready || payees.length === 0) return;
    // По этому столу недавно уже вносили — переспрашиваем один раз.
    if (recent && asking === null) {
      setAsking({ kind, ago: minutesAgo(recent.createdAt) });
      return;
    }
    setAsking(null);
    setSaving(true);
    setFailed(false);
    try {
      await onConfirm(amount, payees, kind);
      // При успехе экран закрывается сверху.
    } catch {
      // При ошибке остаёмся с набранной суммой и выбранными официантами —
      // повторить можно одним тапом.
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <button
          onClick={onCancel}
          aria-label="Назад"
          className="-ml-1 rounded-lg px-2 py-1 text-2xl leading-none text-fg-muted active:bg-surface"
        >
          ‹
        </button>
        <div className="text-base">
          {hall.title} · {table.title}
        </div>
      </header>

      {/* Растягивается, чтобы клавиатура и кнопки остались внизу — под большой палец. */}
      <div className="flex flex-1 items-center justify-center py-6">
        <span
          className={`text-4xl tabular-nums ${amount > 0 ? "text-fg" : "text-fg-muted"}`}
        >
          {formatMoney(amount)}
        </span>
      </div>

      <div className="px-4 pb-3">
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-xs text-fg-muted">
            {payees.length === 0
              ? "выберите, кому"
              : payees.length === 1
                ? payees[0].contour === "hall"
                  ? "официант"
                  : "получатель"
                : `делим поровну на ${payees.length}`}
          </span>
          {crew.length > 1 && (
            <button
              onClick={toggleSplitting}
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs ${
                splitting
                  ? "border-sand bg-sand/10 text-fg"
                  : "border-line bg-surface text-fg-muted active:bg-surface-2"
              }`}
            >
              {splitting ? "× по одному" : "＋ разделить"}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {crew.map((w) => {
            const on = ids.includes(w.id);
            return (
              <button
                key={w.id}
                onClick={() => pickWaiter(w.id)}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  on
                    ? "border-sand bg-sand/10 text-fg"
                    : "border-line bg-surface text-fg-muted active:bg-surface-2"
                }`}
              >
                {w.short}
              </button>
            );
          })}
        </div>
        {/* Хостес и кальянный бар — общий кусок с экраном разнесения QR:
            вопрос «кому со стороны» у обоих экранов один и тот же. */}
        <SidePots
          hostess={hostess}
          hookah={hookah}
          side={side}
          open={openSide}
          onOpen={(c) => {
            setFailed(false);
            setOpenSide(c);
          }}
          onPick={pickSide}
          onCrew={onCrew}
        />

        {/* Раскладку показываем только когда есть что раскладывать: с нулевой
            суммой строка «Анна 0 ₽ · Иван 0 ₽» только мешала бы. */}
        {payees.length > 1 && amount > 0 && (
          <div className="mt-2 text-xs text-fg-muted">
            {payees
              .map((p, i) => `${p.person.short} — ${formatMoney(parts[i])}`)
              .join(" · ")}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 px-4">
        {KEYS.map((k) => (
          <button
            key={k}
            onClick={() => press(k)}
            className="rounded-xl border border-line bg-surface py-3.5 text-2xl tabular-nums active:bg-surface-2"
          >
            {k}
          </button>
        ))}
      </div>

      <div className="px-4 pb-6 pt-3">
        {asking !== null && recent && (
          <div className="mb-3 rounded-xl border border-alert bg-surface p-3">
            <div className="text-sm text-fg">
              По столу {table.title} уже вносили: {formatMoney(recent.amount)} ·{" "}
              {recent.who}
            </div>
            <div className="mt-0.5 text-xs text-fg-muted">
              {asking.ago} · внёс {recent.operatorName}
            </div>
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              <button
                onClick={() => setAsking(null)}
                className="rounded-lg border border-line py-2.5 text-sm text-fg-muted active:bg-surface-2"
              >
                Не добавлять
              </button>
              <button
                onClick={() => confirm(asking.kind)}
                className="rounded-lg bg-alert py-2.5 text-sm text-ink"
              >
                Всё равно добавить
              </button>
            </div>
          </div>
        )}

        {/* Строка состояния прямо над кнопками: ошибку видно, а кнопки
            остаются открытыми — повторить можно сразу. */}
        <div
          className={`mb-1.5 text-xs ${failed ? "text-alert" : "text-fg-muted"}`}
        >
          {saving
            ? "сохраняю…"
            : failed
              ? "не сохранилось — проверьте связь и повторите"
              : mixed
                ? // Про сторону говорим прямо: у зальной доли будут вычтены
                  // 20 % администратору и доля кассира, у барской и хостес —
                  // ничего. Узнать об этом администратор должен до нажатия.
                  amount > 0 && terminalFee > 0
                  ? `по терминалу дойдёт ${formatMoney(terminalNet)}, комиссия ${terminalFee} % · доля бара и хостес ни с кем не делится`
                  : "доля бара и хостес ни с кем не делится"
                : amount > 0 && terminalFee > 0
                  ? `чаевые · по терминалу дойдёт ${formatMoney(terminalNet)}, комиссия ${terminalFee} %`
                  : "чаевые"}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            disabled={!ready}
            onClick={() => confirm("cash")}
            className="rounded-xl bg-sand py-3.5 text-base text-ink disabled:bg-surface disabled:text-fg-muted"
          >
            Наличные
          </button>
          <button
            disabled={!ready}
            onClick={() => confirm("terminal")}
            className="rounded-xl border border-sand py-3.5 text-base text-sand disabled:border-line disabled:text-fg-muted"
          >
            Терминал
          </button>
        </div>
        <button
          disabled={!ready}
          onClick={() => confirm("service")}
          className="mt-2 w-full rounded-xl border border-line bg-surface py-3.5 text-base text-fg disabled:text-fg-muted"
        >
          Сервисный сбор
        </button>
      </div>
    </div>
  );
}
