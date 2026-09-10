#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Забирает фотографии бумажных «Таблиц чаевых» из группы «ЧАЕВЫЕ ОФ».

🔴 **Зачем.** Смена фотографирует лист и кладёт его в группу каждую ночь,
одной картинкой в 3–7 утра. До 06.09.2026 их никто не забирал: 198 картинок
за июнь–август вынули руками из журналов разговоров, последняя была за
17 августа, и сверка «бумага против приложения» с тех пор молчала — не
потому, что всё сходилось, а потому, что сравнивать было не с чем.

⚠️ **Дата в имени файла — день СМЕНЫ, а не день фотографии.** Лист за
5 сентября лежит в группе утром 6-го: смена закрывается в шесть утра.
Поэтому всё, что снято до 10:00, относится к предыдущему дню.

⚠️ **Сессия отдельная, «маковская».** Общий ключ делит с роботом на Amvera,
и Telegram рвёт тот, что работает с двух адресов сразу, — робот замолкает
молча. Так пропали чаевые по QR за 18.08.2026.

Запуск:
    python3 scripts/listy_pull.py                 # чего нет за последний месяц
    python3 scripts/listy_pull.py --с 2026-08-18  # с этого дня
    python3 scripts/listy_pull.py --что-там       # только показать, не скачивать
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ПАПКА = ROOT / "data" / "листы-смен"
СЕССИЯ = ROOT / "scripts" / ".tg-mac-session"
ГРУППА = -4244984520  # «ЧАЕВЫЕ ОФ»
# Снято до этого часа — значит лист за вчерашнюю смену.
ГРАНИЦА_ЧАСОВ = 10


def из_env(имя: str) -> str:
    for строка in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if строка.startswith(f"{имя}="):
            return строка.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit(f"✗ В .env нет {имя}")


def день_смены(когда: dt.datetime) -> dt.date:
    """Лист, снятый ночью или ранним утром, относится к прошлому дню."""
    местное = когда.astimezone()
    return местное.date() - dt.timedelta(days=1) if местное.hour < ГРАНИЦА_ЧАСОВ else местное.date()


async def работа(с_даты: dt.date, только_показать: bool) -> None:
    try:
        from telethon import TelegramClient
    except ImportError:
        sys.exit("✗ Нет telethon: pip3 install telethon")

    if not Path(f"{СЕССИЯ}.session").exists():
        sys.exit(
            f"✗ Нет файла сессии {СЕССИЯ.name}.session.\n"
            "  Создать её должна владелец, своим номером:\n"
            "      python3 scripts/tg_login.py --мак"
        )

    ПАПКА.mkdir(parents=True, exist_ok=True)
    клиент = TelegramClient(str(СЕССИЯ), int(из_env("TG_API_ID")), из_env("TG_API_HASH"))
    await клиент.start()

    скачано, было, пропущено = 0, 0, 0
    async for сообщение in клиент.iter_messages(ГРУППА, limit=400):
        if not сообщение.photo:
            continue
        день = день_смены(сообщение.date)
        if день < с_даты:
            break
        файл = ПАПКА / f"лист-{день:%Y-%m-%d}.jpeg"
        # Вторая фотография того же дня — бывает, что лист снимают в два кадра.
        if файл.exists():
            запасной = ПАПКА / f"лист-{день:%Y-%m-%d}-2.jpeg"
            if запасной.exists():
                было += 1
                continue
            файл = запасной
        if только_показать:
            print(f"  взял бы: {файл.name}  (снято {сообщение.date.astimezone():%d.%m %H:%M})")
            пропущено += 1
            continue
        await сообщение.download_media(file=str(файл))
        print(f"  ✓ {файл.name}  (снято {сообщение.date.astimezone():%d.%m %H:%M})")
        скачано += 1

    await клиент.disconnect()
    if только_показать:
        print(f"\nновых листов: {пропущено}, уже есть: {было}")
    else:
        print(f"\nскачано: {скачано}, уже было: {было}")
        if скачано:
            print("Дальше их надо прочитать глазами и внести числа "
                  "в scripts/tips_paper.py — только после этого заработает "
                  "сверка «бумага против приложения».")


def main() -> None:
    разбор = argparse.ArgumentParser(description="Фотографии листов смен из Telegram.")
    разбор.add_argument("--с", dest="с", help="с какого дня смены брать, вида 2026-08-18")
    разбор.add_argument("--что-там", action="store_true", help="показать и не скачивать")
    аргументы = разбор.parse_args()

    с_даты = (dt.date.fromisoformat(аргументы.с) if аргументы.с
              else dt.date.today() - dt.timedelta(days=31))
    asyncio.run(работа(с_даты, аргументы.что_там))


if __name__ == "__main__":
    main()
