"""Ядро читателя QR-чаевых: смена, чтение группы, запись в базу.

Один и тот же код работает в двух местах: на сервере (`service.py`, крутится
сам) и на компьютере владельца (`../scripts/tg_read.py`, запускается руками).
Второй копии не заводим намеренно — две копии расчёта смены рано или поздно
разъедутся, и суммы поедут вслед за ними.

Настройки берутся из переменных окружения:

    DATABASE_URL      строка подключения к базе
    DATABASE_SCHEMA   схема; пусто — боевая public
    TG_API_ID         }  опознают программу,
    TG_API_HASH       }  а не аккаунт
    TG_GROUP_ID       группа «Сберчаевые Нев»
    TG_SESSION        сессия строкой (на сервере)
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

from sber_parse import parse

# Бизнес-день заведения начинается в 11:00 — так настроено в Quick Resto
# и так же считает приложение. Смена идёт примерно с 16:00 до 06:00, то есть
# переваливает за полночь: без этой поправки чаевые, полученные в три часа
# ночи, попали бы в следующие сутки и разошлись бы с записями кассира.
BUSINESS_DAY_START_HOUR = 11

# Часовой пояс задан явно, а не взят у машины. Приложение считает смену
# в браузере на телефоне, то есть по Москве; читатель живёт на сервере,
# где часы обычно стоят по UTC. Возьми мы часы машины — поступление в 01:00
# уехало бы в следующий вечер.
try:
    from zoneinfo import ZoneInfo

    MOSCOW = ZoneInfo("Europe/Moscow")
except Exception:  # pragma: no cover
    MOSCOW = timezone(timedelta(hours=3))

# Рассылка Сбера уже обрывалась на девять суток (26.07–04.08.2026), и никто
# этого не заметил. Молчание нельзя показывать как ноль.
SILENCE_HOURS = 24

PROD_SCHEMA = "public"


def business_day(moment: datetime) -> tuple[str, datetime]:
    """Ключ смены ГГГГ-ММ-ДД и московское время. До 11:00 — ещё вчерашняя."""
    local = moment.astimezone(MOSCOW)
    day = local if local.hour >= BUSINESS_DAY_START_HOUR else local - timedelta(days=1)
    return day.strftime("%Y-%m-%d"), local


def connect(schema: str | None = None):
    """Соединение с базой. Возвращает (соединение, имя схемы).

    Без autocommit: пачку записей закрепляем сами, чтобы при обрыве
    посередине в базе не осталось половины.
    """
    try:
        import psycopg
        from psycopg import sql
    except ModuleNotFoundError:
        sys.exit(
            "Не установлена psycopg — связь Python с PostgreSQL.\n"
            "Поставить: python3 -m pip install --user 'psycopg[binary]'"
        )

    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("Не задан DATABASE_URL")

    target = schema or os.environ.get("DATABASE_SCHEMA") or PROD_SCHEMA

    conn = psycopg.connect(url, connect_timeout=10)
    with conn.cursor() as cur:
        # Имя схемы подставляем идентификатором, а не склейкой строк: склейка —
        # тот самый способ, которым в базу попадает чужой код.
        cur.execute(sql.SQL("set search_path to {}").format(sql.Identifier(target)))
    conn.commit()
    return conn, target


def describe(schema: str) -> str:
    """Как назвать схему человеку, чтобы боевую было видно сразу."""
    if schema == PROD_SCHEMA:
        return f"{schema} — БОЕВАЯ, здесь настоящие деньги смены"
    return f"{schema} — тестовая, боевые данные не тронуты"


def known_state(conn):
    """Что база уже знает: номер последнего сообщения и время последнего.

    Номер — чтобы не перечитывать историю: следующий заход возьмёт только то,
    что пришло после. Время — чтобы заметить молчание, даже когда новых
    сообщений нет вовсе.
    """
    import psycopg

    try:
        with conn.cursor() as cur:
            cur.execute("select max(message_id), max(received_at) from qr_tips")
            return cur.fetchone()
    except psycopg.errors.UndefinedTable:
        conn.rollback()
        sys.exit(
            "В этой схеме нет таблицы qr_tips.\n"
            "Применить схему: cd mini-app && npm run db:setup"
        )


def store(conn, records) -> int:
    """Кладёт разобранное в qr_tips. Возвращает, сколько записей появилось.

    Повторы отсекает сама база: message_id — первичный ключ. Поэтому читать
    можно сколько угодно раз, не разбираясь, что уже записано.
    """
    added = 0
    with conn.cursor() as cur:
        for message_id, moment, day, notice in records:
            cur.execute(
                """
                insert into qr_tips
                       (message_id, received_at, business_day, amount, team)
                values (%s, %s, %s, %s, %s)
                on conflict (message_id) do nothing
                returning message_id
                """,
                (message_id, moment, day, notice.amount, notice.team),
            )
            if cur.fetchone() is not None:
                added += 1
    conn.commit()
    return added


def collect(client, group, limit=None, since_id=None, since_day=None):
    """Читает группу и возвращает разобранные поступления.

    Отдаёт список (номер сообщения, время, смена, поступление) и заодно
    сколько пропущено: чужих сообщений и слишком старых.
    """
    messages = client.iter_messages(group, limit=limit, min_id=since_id or 0)

    found, skipped, too_old = [], 0, 0
    for message in messages:
        notice = parse(message.message or "")
        if notice is None:
            # Молчаливый отказ намеренный: в группе люди и служебные записи,
            # и чужое сообщение не должно ронять чтение.
            skipped += 1
            continue
        day, _ = business_day(message.date)
        # Отбор по смене, а не по календарной дате: поступление в 01:00
        # принадлежит вчерашнему вечеру, и отсечь его по числу значило бы
        # потерять половину ночи.
        if since_day and day < since_day:
            too_old += 1
            continue
        found.append((message.id, message.date, day, notice))
    return found, skipped, too_old


def silence_report(newest: datetime | None) -> tuple[bool, str]:
    """Тревожно ли молчание. Возвращает (тревога, что сказать человеку).

    Пустой экран и «рассылка сломалась» выглядят одинаково — разница в том,
    что во втором случае деньги идут, а учёт их не видит.
    """
    if newest is None:
        return True, (
            "Ни одного поступления по QR. Это не обязательно ноль: "
            "рассылка Сбера уже обрывалась. Проверьте группу."
        )
    gap = datetime.now(timezone.utc) - newest.astimezone(timezone.utc)
    hours = gap.total_seconds() / 3600
    when = newest.astimezone(MOSCOW).strftime("%d.%m в %H:%M")
    if hours >= SILENCE_HOURS:
        return True, (
            f"Последнее поступление было {when} — это {hours / 24:.1f} суток назад. "
            "Рассылка уже обрывалась на девять суток и никто не заметил. "
            "Молчание — это не ноль, проверьте группу."
        )
    return False, f"Последнее поступление: {when} ({hours:.1f} ч назад) — рассылка жива."
