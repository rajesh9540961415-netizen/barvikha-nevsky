"use client";

/**
 * Полоса состояния связи.
 *
 * Самый плохой вариант офлайна — молчаливый: администратор внёс чаевые,
 * приложение ответило «записано», а запись висит на телефоне, и об этом
 * никто не знает. Поэтому всё, что не доехало до базы, видно на главном
 * экране постоянно, а не всплывающим сообщением на две секунды.
 *
 * Нажатие — попытка отправить прямо сейчас. Само по себе оно не нужно,
 * очередь уходит сама, но человеку важно иметь возможность что-то сделать,
 * а не только смотреть.
 */

type Props = {
  /** Сколько пунктов ждёт отправки. */
  waiting: number;
  /** Что именно ждёт, словами: «2 записи и 1 отмена». */
  summary: string;
  /** Прямо сейчас идёт отправка. */
  sending: boolean;
  /**
   * Есть ли сеть по мнению браузера.
   *
   * Отдельно от staleSince намеренно: «сети нет вовсе» и «сеть есть, а база
   * не отвечает» — разные беды, и называть их одинаково нельзя. Первую человек
   * может починить сам, вторую — нет.
   */
  online: boolean;
  /** Сохраняется ли очередь на диск телефона. */
  durable: boolean;
  /** Когда снят снимок, на котором держится экран. Пусто — данные из базы. */
  staleSince: string | null;
  /**
   * Приложение обновилось, а страница осталась от прошлой версии.
   *
   * Единственная беда, которая не проходит сама и требует действия человека.
   * Поэтому она главнее всех прочих и показывается поверх них.
   */
  needsReload: boolean;
  onFlush: () => void;
};

/** «21:47» из ISO. */
function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function PendingBar({
  waiting,
  summary,
  sending,
  online,
  durable,
  staleSince,
  needsReload,
  onFlush,
}: Props) {
  // Приложение обновилось. Говорим об этом вместо всего остального и просим
  // ровно одно действие — нажать. Прочие подписи здесь были бы вредны:
  // «не отправлено, уйдёт само» — неправда, само оно уже не уйдёт.
  if (needsReload) {
    return (
      <button
        onClick={() => window.location.reload()}
        className="mx-4 mb-2 rounded-xl border border-sand bg-sand/10 px-3 py-2 text-left active:bg-sand/20"
      >
        <div className="text-sm text-fg">
          Приложение обновилось — нажмите, чтобы обновить страницу
        </div>
        <div className="text-xs text-fg-muted">
          {waiting > 0
            ? `записи сохранены на телефоне (${summary}) и уйдут сразу после обновления`
            : "ничего не потеряется"}
        </div>
      </button>
    );
  }

  // Всё хорошо и говорить не о чем: полосы нет, экран не засоряется.
  if (waiting === 0 && online && !staleSince) return null;

  const alarming = waiting > 0 || !online;

  // Связь есть и база отвечает — тогда единственная причина полосы
  // в том, что очередь ещё не ушла.
  const connected = online && !staleSince;

  const title = sending
    ? "Отправляю…"
    : !online
      ? "Нет сети"
      : staleSince
        ? "База не отвечает"
        : "Не всё отправлено";

  // Числа и перечисления живут только здесь, в одной строке: иначе фразы
  // вроде «1 запись сохранены» не согласуются по числу и роду.
  const note = !durable
    ? "телефон не сохраняет очередь — не закрывайте приложение"
    : sending
      ? `осталось: ${summary}`
      : waiting > 0
        ? `не отправлено: ${summary} · ${
            connected
              ? "нажмите, чтобы отправить сейчас"
              : "сохранено на телефоне, уйдёт само"
          }`
        : staleSince
          ? `показано то, что было на ${clock(staleSince)} · новые записи сохранятся`
          : "записи сохранятся на телефоне и уйдут сами";

  return (
    <button
      onClick={onFlush}
      className={`mx-4 mb-2 rounded-xl border px-3 py-2 text-left ${
        alarming
          ? "border-alert bg-alert/10 active:bg-alert/20"
          : "border-line bg-surface active:bg-surface-2"
      }`}
    >
      <div className="text-sm text-fg">{title}</div>
      <div className="text-xs text-fg-muted">{note}</div>
    </button>
  );
}
