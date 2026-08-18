#!/usr/bin/env python3
"""Чтение поступлений по QR из группы «Сберчаевые Нев» — вручную, с компьютера.

Читает ТОЛЬКО одну группу — ту, что указана в .env как TG_GROUP_ID.
Из каждого сообщения берёт ТОЛЬКО сумму, команду и время: оценка, отметки
и текстовый отзыв гостя не сохраняются и не печатаются.

Вход не спрашивает: пользуется файлом сессии, созданным scripts/tg_login.py.

Запуск:

    python3 scripts/tg_read.py                 показать, ничего не писать
    python3 scripts/tg_read.py --write         записать в тестовую схему
    python3 scripts/tg_read.py --write --prod  записать в боевую схему

⚠️ ЗАПУСКАТЬ ТОЛЬКО ПРИ ОСТАНОВЛЕННОМ РОБОТЕ. Сессия здесь та же самая, что
у варшавского читателя на Amvera: строку для него делает tg_session_export.py
из этого самого файла. Telegram убивает ключ, который в один момент работает
с двух адресов, — и робот замолкает, ничего об этом не сказав. Так и вышло
18.08.2026: чаевые по QR пришли, а робот их не прочитал.

Поэтому скрипт просит подтвердить: --robot-stopped.

Ключ записи — идентификатор сообщения Telegram, поэтому запускать можно
сколько угодно раз: повторное сообщение второго поступления не создаст.

Разбор, расчёт смены и запись живут в tg-reader/qr_reader.py — там же, откуда
их берёт служба на сервере. Здесь только запуск руками и показ на экран.

См. plans/2026-08-03-qr-chaevye.md
"""

import argparse
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db import load_env, use_reader_code  # noqa: E402

load_env(need=("TG_API_ID", "TG_API_HASH", "TG_GROUP_ID"))
use_reader_code()

import os  # noqa: E402

import qr_reader as core  # noqa: E402

SESSION = Path(__file__).resolve().parent / ".tg-session"


def main():
    parser = argparse.ArgumentParser(
        description="Читает поступления по QR из группы Telegram.",
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
        help="брать только смены с этой даты и позже",
    )
    parser.add_argument(
        "--robot-stopped",
        action="store_true",
        help="подтверждаю: читатель на Amvera остановлен, сессию делить не с кем",
    )
    args = parser.parse_args()

    if args.prod and not args.write:
        sys.exit("--prod без --write ничего не делает: писать-то нечего.")
    if args.since:
        try:
            datetime.strptime(args.since, "%Y-%m-%d")
        except ValueError:
            sys.exit(f"--since ждёт дату вида 2026-08-04, а не «{args.since}»")

    if not args.robot_stopped:
        sys.exit(
            "Стоп. Этот скрипт пользуется той же сессией Telegram, что и робот\n"
            "на Amvera. Telegram отключает ключ, работающий с двух адресов сразу,\n"
            "и робот перестаёт читать группу — молча, без единой ошибки на экране.\n"
            "Именно так пропали чаевые по QR за 18.08.2026.\n\n"
            "Если робот сейчас остановлен в панели Amvera — повторите запуск\n"
            "с --robot-stopped. Если нет — не запускайте: то, что вы хотите\n"
            "увидеть, робот и так кладёт в базу."
        )

    try:
        from telethon.sync import TelegramClient
    except ModuleNotFoundError:
        sys.exit("Не установлена telethon: python3 -m pip install --user telethon")

    conn = schema = since_id = known_newest = None
    if args.write:
        conn, schema = core.connect(core.PROD_SCHEMA if args.prod else None)
        print(f"Пишу в схему {core.describe(schema)}\n")
        since_id, known_newest = core.known_state(conn)

    client = TelegramClient(
        str(SESSION), int(os.environ["TG_API_ID"]), os.environ["TG_API_HASH"]
    )
    client.connect()
    if not client.is_user_authorized():
        client.disconnect()
        if conn:
            conn.close()
        sys.exit("Сессия не годится. Запустите заново: python3 scripts/tg_login.py")

    try:
        # Группу могут пересоздать, а аккаунт из старой вывести — так и вышло
        # 04.08.2026. Telegram отвечает на это ошибкой доступа, и без разбора
        # она вываливалась простынёй на английском.
        try:
            group = client.get_entity(int(os.environ["TG_GROUP_ID"]))
        except Exception as error:
            name = type(error).__name__
            if "Private" in name or "Invalid" in name or "NotFound" in name:
                sys.exit(
                    f"Группа {os.environ['TG_GROUP_ID']} недоступна ({name}).\n"
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

        found, skipped, too_old = core.collect(
            client,
            group,
            limit=None if since_id else args.limit,
            since_id=since_id,
            since_day=args.since,
        )

        if too_old:
            print(f"Пропущено как старое (раньше {args.since}): {too_old}\n")

        if found:
            print(f"{'смена':<12} {'время':<6} {'сумма':>12}  команда")
            print("-" * 50)
            by_day = defaultdict(float)
            by_team = defaultdict(float)
            for _, moment, day, notice in reversed(found):
                _, local = core.business_day(moment)
                by_day[day] += notice.amount
                by_team[notice.team] += notice.amount
                print(
                    f"{day:<12} {local.strftime('%H:%M'):<6} "
                    f"{notice.amount:>10,.2f} ₽  {notice.team}"
                )

            total = sum(n.amount for _, _, _, n in found)
            print("-" * 50)
            print(f"разобрано {len(found)}, пропущено {skipped}, всего {total:,.2f} ₽\n")

            print("по сменам:")
            for day in sorted(by_day):
                print(f"  {day}  {by_day[day]:>10,.2f} ₽")

            print("\nпо командам:")
            for team in sorted(by_team, key=lambda t: -by_team[t]):
                print(f"  {team:<16} {by_team[team]:>10,.2f} ₽")

            if args.write:
                added = core.store(conn, found)
                print(f"\nЗаписано в базу: {added}")
                if added < len(found):
                    print(f"Уже было: {len(found) - added} — повторов не создали")
        else:
            print("Новых поступлений по QR нет.")

        newest = max((m for _, m, _, _ in found), default=None)
        if known_newest and (newest is None or known_newest > newest):
            newest = known_newest
        alarm, message = core.silence_report(newest)
        print(f"\n{'⚠️  ' if alarm else ''}{message}")
    finally:
        client.disconnect()
        if conn:
            conn.close()


if __name__ == "__main__":
    main()
