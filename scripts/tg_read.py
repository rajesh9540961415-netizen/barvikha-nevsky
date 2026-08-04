#!/usr/bin/env python3
"""Чтение поступлений по QR из группы «СберЧаевые Невский».

Читает ТОЛЬКО одну группу — ту, что указана в .env как TG_GROUP_ID.
Из каждого сообщения берёт ТОЛЬКО сумму, команду и время: оценка, отметки
и текстовый отзыв гостя не сохраняются и не печатаются.

Вход не спрашивает: пользуется файлом сессии, созданным scripts/tg_login.py.

Запуск:

    python3 scripts/tg_read.py                 показать, ничего не писать
    python3 scripts/tg_read.py --write         записать в тестовую схему
    python3 scripts/tg_read.py --write --prod  записать в боевую схему

Ключ записи — идентификатор сообщения Telegram, поэтому запускать можно
сколько угодно раз: повторное сообщение второго поступления не создаст.

См. plans/2026-08-03-qr-chaevye.md
"""

import argparse
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db import PROD_SCHEMA, connect, describe  # noqa: E402
from sber_parse import parse  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
SESSION = Path(__file__).resolve().parent / ".tg-session"

# Бизнес-день заведения начинается в 11:00 — как в Quick Resto и в приложении.
# Ночные чаевые принадлежат смене, которая началась накануне.
BUSINESS_DAY_START_HOUR = 11

# Часовой пояс задан явно, а не взят у машины. Приложение считает смену
# в браузере на телефоне, то есть по Москве; скрипт же однажды переедет
# на сервер, а там часы обычно стоят по UTC — и тогда поступления в 01:00
# уехали бы в следующий вечер, разойдясь с записями кассира.
try:
    from zoneinfo import ZoneInfo

    MOSCOW = ZoneInfo("Europe/Moscow")
except Exception:  # pragma: no cover — на macOS база часовых поясов есть всегда
    MOSCOW = timezone(timedelta(hours=3))

# Рассылка Сбера уже обрывалась на неделю (26.07–03.08.2026), и никто этого
# не заметил. Молчание нельзя показывать как ноль: если поступлений нет
# дольше этого срока, скрипт говорит об этом отдельной строкой.
SILENCE_HOURS = 24


def read_env():
    if not ENV.exists():
        sys.exit("Нет файла .env рядом с проектом.")
    cfg = {}
    for line in ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        cfg[key.strip()] = value.strip()
    for key in ("TG_API_ID", "TG_API_HASH", "TG_GROUP_ID"):
        if not cfg.get(key):
            sys.exit(f"В .env не заполнено: {key}")
    return cfg


def business_day(moment):
    """Ключ смены ГГГГ-ММ-ДД: до 11:00 — это ещё вчерашняя смена."""
    local = moment.astimezone(MOSCOW)
    day = local if local.hour >= BUSINESS_DAY_START_HOUR else local - timedelta(days=1)
    return day.strftime("%Y-%m-%d"), local


def known_state(conn):
    """Что о поступлениях уже знает база: последнее сообщение и его время.

    Идентификатор нужен, чтобы не перечитывать всю историю: следующий запуск
    возьмёт только то, что пришло после. Время — чтобы заметить молчание,
    даже когда новых сообщений нет вовсе.
    """
    import psycopg

    try:
        with conn.cursor() as cur:
            cur.execute("select max(message_id), max(received_at) from qr_tips")
            last_id, last_at = cur.fetchone()
    except psycopg.errors.UndefinedTable:
        conn.rollback()
        sys.exit(
            "В этой схеме нет таблицы qr_tips.\n"
            "Применить схему: cd mini-app && npm run db:setup"
        )
    return last_id, last_at


def store(conn, records):
    """Кладёт разобранное в qr_tips. Возвращает, сколько записей появилось.

    Повторы отсекает сама база: message_id — первичный ключ. Поэтому скрипт
    можно запускать хоть каждые пять минут, не разбираясь, что уже записано.
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


def report_silence(newest):
    """Говорит вслух, если поступлений давно нет.

    Пустой экран и «рассылка сломалась» выглядят одинаково — разница только
    в том, что во втором случае деньги идут, а учёт их не видит.
    """
    if newest is None:
        print("\n⚠️  Ни одного поступления по QR не найдено.")
        print("   Это не обязательно ноль: рассылка Сбера уже обрывалась.")
        print("   Проверьте, приходят ли уведомления в группу.")
        return

    gap = datetime.now(timezone.utc) - newest.astimezone(timezone.utc)
    hours = gap.total_seconds() / 3600
    when = newest.astimezone(MOSCOW).strftime("%d.%m в %H:%M")
    if hours >= SILENCE_HOURS:
        print(f"\n⚠️  Последнее поступление было {when} — это {hours / 24:.1f} суток назад.")
        print("   Рассылка Сбера уже обрывалась на неделю и никто не заметил.")
        print("   Проверьте группу: молчание — это не ноль.")
    else:
        print(f"\nПоследнее поступление: {when} ({hours:.1f} ч назад) — рассылка жива.")


def main():
    parser = argparse.ArgumentParser(
        description="Читает поступления по QR из группы Telegram.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "limit",
        nargs="?",
        type=int,
        default=200,
        help="сколько последних сообщений смотреть (по умолчанию 200)",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="записать разобранное в базу, а не только показать",
    )
    parser.add_argument(
        "--prod",
        action="store_true",
        help="писать в БОЕВУЮ схему public — там настоящие деньги смены",
    )
    parser.add_argument(
        "--since",
        metavar="ГГГГ-ММ-ДД",
        help="брать только смены с этой даты и позже "
        "(в группе есть история с апреля, и она уже учтена в старой таблице)",
    )
    args = parser.parse_args()

    if args.prod and not args.write:
        sys.exit("--prod без --write ничего не делает: писать-то нечего.")

    if args.since:
        try:
            datetime.strptime(args.since, "%Y-%m-%d")
        except ValueError:
            sys.exit(f"--since ждёт дату вида 2026-08-04, а не «{args.since}»")

    try:
        from telethon.sync import TelegramClient
    except ModuleNotFoundError:
        sys.exit("Не установлена telethon: python3 -m pip install --user telethon")

    cfg = read_env()

    conn = None
    schema = None
    since_id = None
    known_newest = None
    if args.write:
        conn, schema = connect(PROD_SCHEMA if args.prod else None)
        print(f"Пишу в схему {describe(schema)}\n")
        since_id, known_newest = known_state(conn)

    client = TelegramClient(str(SESSION), int(cfg["TG_API_ID"]), cfg["TG_API_HASH"])
    client.connect()
    if not client.is_user_authorized():
        client.disconnect()
        if conn:
            conn.close()
        sys.exit("Сессия не годится. Запустите заново: python3 scripts/tg_login.py")

    try:
        # Группу могут пересоздать, а аккаунт из старой вывести — так и вышло
        # 04.08.2026. Telegram отвечает на это ошибкой доступа, и без разбора
        # она вываливалась простынёй на английском. Объясняем по-человечески.
        try:
            group = client.get_entity(int(cfg["TG_GROUP_ID"]))
        except Exception as error:
            name = type(error).__name__
            if "Private" in name or "Invalid" in name or "NotFound" in name:
                sys.exit(
                    f"Группа {cfg['TG_GROUP_ID']} недоступна ({name}).\n"
                    "Обычно это значит, что группу пересоздали, а служебный\n"
                    "аккаунт в новую не добавили — либо вывели из старой.\n\n"
                    "Что делать:\n"
                    "  1. Добавить служебный аккаунт в новую группу.\n"
                    "  2. Посмотреть её id:  python3 scripts/tg_groups.py\n"
                    "  3. Вписать этот id в .env как TG_GROUP_ID.\n\n"
                    "Важно: молчание — это не ноль. Пока группа недоступна,\n"
                    "чаевые по QR продолжают приходить, но учёт их не видит."
                )
            raise
        print(f"Группа: {getattr(group, 'title', '—')}")
        if since_id:
            print(f"Беру только то, что пришло после сообщения {since_id}\n")
        else:
            print(f"Смотрю последние {args.limit} сообщений\n")

        # min_id — «строго после этого сообщения». Когда база уже что-то знает,
        # перечитывать всю историю незачем: повторы всё равно отсеются, но
        # каждый запуск тянул бы лишние сотни сообщений.
        messages = client.iter_messages(
            group,
            limit=None if since_id else args.limit,
            min_id=since_id or 0,
        )

        found, skipped, too_old = [], 0, 0
        for message in messages:
            notice = parse(message.message or "")
            if notice is None:
                skipped += 1
                continue
            day, local = business_day(message.date)
            # Отбор по смене, а не по времени сообщения: поступление в 01:00
            # принадлежит вчерашнему вечеру, и отсечь его по календарной дате
            # значило бы потерять половину ночи.
            if args.since and day < args.since:
                too_old += 1
                continue
            found.append((message.id, message.date, day, notice, local))

        if too_old:
            print(f"Пропущено как старое (раньше {args.since}): {too_old}\n")

        if not found:
            print("Новых поступлений по QR нет.")
            report_silence(known_newest)
            return

        print(f"{'смена':<12} {'время':<6} {'сумма':>12}  команда")
        print("-" * 50)
        by_day = defaultdict(float)
        by_team = defaultdict(float)
        for _, _, day, notice, local in reversed(found):
            by_day[day] += notice.amount
            by_team[notice.team] += notice.amount
            print(
                f"{day:<12} {local.strftime('%H:%M'):<6} "
                f"{notice.amount:>10,.2f} ₽  {notice.team}"
            )

        total = sum(n.amount for _, _, _, n, _ in found)
        print("-" * 50)
        print(f"разобрано {len(found)}, пропущено {skipped}, всего {total:,.2f} ₽\n")

        print("по сменам:")
        for day in sorted(by_day):
            print(f"  {day}  {by_day[day]:>10,.2f} ₽")

        print("\nпо командам:")
        for team in sorted(by_team, key=lambda t: -by_team[t]):
            print(f"  {team:<16} {by_team[team]:>10,.2f} ₽")

        if args.write:
            records = [(mid, moment, day, notice) for mid, moment, day, notice, _ in found]
            added = store(conn, records)
            print(f"\nЗаписано в базу: {added}")
            if added < len(found):
                print(f"Уже было: {len(found) - added} — повторов не создали")

        newest = max(moment for _, moment, _, _, _ in found)
        if known_newest and known_newest > newest:
            newest = known_newest
        report_silence(newest)
    finally:
        client.disconnect()
        if conn:
            conn.close()


if __name__ == "__main__":
    main()
