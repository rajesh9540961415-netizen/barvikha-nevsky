#!/usr/bin/env python3
"""Расписание робота: что делать по времени и как не сделать это дважды.

Зачем отдельно от службы. До 11.08.2026 всё, что должно случаться само, жило
задачами внутри приложения Claude на компьютере владельца — а они идут, только
пока это приложение открыто. Задача по финансам из-за этого не сработала
10 и 11 августа. Расписание на сервере такой оговорки не имеет.

Почему не cron внутри контейнера и не сторонняя библиотека. У робота уже есть
вечный цикл: раз в минуту он заглядывает в Telegram. Проверить заодно, не пора
ли сделать что-то ещё, — это десяток строк и ни одной новой движущейся части.
Отдельный планировщик пришлось бы отдельно запускать, отдельно чинить
и отдельно замечать, что он молчит.

Отметка о выполнении лежит в базе, а не в памяти: контейнер перезапускается
при каждой выкладке, и память обнуляется вместе с ним.

⚠️ Таблица `robot_jobs` — собственность робота. Её нет в `schema.sql`
приложения смены намеренно: это не общие данные, в неё никто, кроме робота,
не смотрит. Общая схема на всех — там, где данные действительно общие.
"""

# Как и в qr_reader.py: на компьютере владельца Python 3.9, на сервере 3.12,
# а запись `int | None` до 3.10 не понимается. Эта строка откладывает разбор
# подписей до того момента, когда они кому-то понадобятся, — то есть никогда.
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Callable

# Сколько ждать, прежде чем взяться за дело не в свой день недели. Робот мог
# простоять весь понедельник — выкладка, обрыв связи, что угодно. Без этого
# копия молча пропустила бы неделю, а заметили бы через месяц.
CATCH_UP = timedelta(days=8)

# Через сколько повторять после неудачи. Неудача — это оборванная связь или
# отказ Telegram: само пройдёт, но не через минуту. Час — чтобы и повторить
# в тот же день, и не забить журнал одной строкой.
#
# ⚠️ Неудача НЕ закрывает день. Иначе одна оборванная связь в понедельник утром
# отложила бы копию базы на неделю — а копия и нужна ровно на случай беды.
RETRY_AFTER = timedelta(hours=1)


@dataclass(frozen=True)
class Job:
    """Одно дело в расписании."""

    name: str  # ключ в базе и подпись в журнале
    weekday: int | None  # день недели, 0 — понедельник; None — каждый день
    hour: int  # с какого часа по Москве можно браться
    do: Callable[[], str]  # что сделать; возвращает строку для журнала


def setup(conn) -> None:
    """Завести таблицу отметок, если её ещё нет."""
    with conn.cursor() as cur:
        cur.execute(
            """
            create table if not exists robot_jobs (
                job      text primary key,
                last_day date,
                last_at  timestamptz,
                ok       boolean,
                note     text
            )
            """
        )
        # Разовая уборка за собственной ошибкой от 11.08.2026. Та версия
        # засчитывала «пропущено: не задан …» за выполненное дело, и день
        # оказывался закрыт, хотя копии не было. Такие отметки — ложные,
        # снимаем их, чтобы дело взялось заново.
        #
        # Новый код подобных заметок не пишет вовсе: нехватка настроек теперь
        # возвращает None и отметку не ставит. Значит уборка сработает один раз
        # и дальше будет вхолостую — оставить её дешевле, чем ходить в боевую
        # базу руками, куда с компьютера владельца хода всё равно нет.
        cur.execute("delete from robot_jobs where ok and note like 'пропущено:%'")
    conn.commit()


def last_run(conn, name: str):
    """Что известно о прошлом заходе: (день удачи, когда пробовали, вышло ли)."""
    with conn.cursor() as cur:
        cur.execute(
            "select last_day, last_at, ok from robot_jobs where job = %s", (name,)
        )
        row = cur.fetchone()
    return row if row else (None, None, None)


def mark(conn, name: str, ok: bool, note: str, now: datetime) -> None:
    """Записать, чем кончилось.

    ⚠️ **День закрывает только удача.** При неудаче `last_day` не двигаем —
    двигаем лишь время попытки, чтобы повторить через час. Иначе одна
    оборванная связь откладывала бы недельное дело на неделю.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into robot_jobs (job, last_day, last_at, ok, note)
                 values (%s, %s, %s, %s, %s)
            on conflict (job) do update
                    set last_day = case when excluded.ok
                                        then excluded.last_day
                                        else robot_jobs.last_day end,
                        last_at  = excluded.last_at,
                        ok       = excluded.ok,
                        note     = excluded.note
            """,
            (name, now.date() if ok else None, now, ok, note[:500]),
        )
    conn.commit()


def due(job: Job, now: datetime, state) -> bool:
    """Настало ли время. `now` приходит уже по Москве."""
    last, tried_at, ok = state

    if last == now.date():
        return False  # сегодня уже сделали

    # Только что не вышло — подождём час, а не будем биться каждую минуту.
    if ok is False and tried_at is not None and now - tried_at < RETRY_AFTER:
        return False

    overdue = last is None or (now.date() - last) >= CATCH_UP

    if job.weekday is not None and now.weekday() != job.weekday and not overdue:
        return False

    return now.hour >= job.hour


def tick(conn, schedule, now: datetime, log) -> None:
    """Пройти по расписанию и сделать то, чему настал срок.

    Ошибка в одном деле не должна ронять службу целиком: робот прежде всего
    читает чаевые по QR, и неудачная копия базы — не повод перестать это делать.
    """
    for job in schedule:
        try:
            if not due(job, now, last_run(conn, job.name)):
                continue
        except Exception as error:
            log.error("расписание «%s»: не смог свериться с базой: %s", job.name, error)
            continue

        log.info("расписание: берусь за «%s»", job.name)
        try:
            note = job.do()

            # Дело вернуло None — оно не сделано, а отложено: чего-то
            # не хватает в настройках. Отметку НЕ ставим, иначе несделанное
            # засчиталось бы за сделанное и следующая попытка была бы только
            # через неделю. 11.08.2026 так и вышло: копия не ушла, потому что
            # ключа бота ещё не было, и робот записал день как отработанный.
            if note is None:
                continue

            log.info("расписание: «%s» — %s", job.name, note)
            mark(conn, job.name, True, note, now)
        except Exception as error:
            trouble = f"{type(error).__name__}: {error}"
            log.error("расписание: «%s» не вышло — %s", job.name, trouble)
            try:
                mark(conn, job.name, False, trouble, now)
            except Exception:
                # База отвалилась вместе с делом — попробуем в следующий заход.
                pass
