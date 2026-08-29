#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Читает чат «ЧАТ КАССЫ!» — объяснения администраторов по отменам и возвратам.

Зачем. Решение владельца 21.08.2026: правила у кассы не вводим, в час пик они
не исполняются. Объяснения берём там, где их и так пишут, — в чате. Задача
скрипта одна: достать сообщения, чтобы их можно было положить рядом со
списком счетов из «Возвраты без перебивки — 2026.xlsx» и сверить два готовых
списка. Необъяснённое — это разница.

🔴 ЭТОТ СКРИПТ ДЕЛИТ АККАУНТ С РОБОТОМ НА AMVERA.

Telegram рвёт ключ, работающий с двух адресов сразу, и робот перестаёт читать
группу МОЛЧА. Так пропали чаевые по QR за 18.08.2026. Поэтому запуск требует
`--robot-stopped`: сперва погасить читалку в панели Amvera, потом читать,
потом поднять обратно.

💡 Насовсем это лечится отдельным НОМЕРОМ ТЕЛЕФОНА для Мака (не отдельным
файлом сессии — Telegram считает по аккаунту). Тогда флаг не понадобится:
`python3 scripts/tg_login.py --мак`, и сюда ключ `--мак`.

⚠️ Скрипт ничего не пишет и никуда не отправляет. Только читает и кладёт
рядом файл, чтобы не ходить в Telegram второй раз за тем же самым.

Запуск:
    python3 scripts/tg_kassa.py --robot-stopped              последние 200
    python3 scripts/tg_kassa.py --robot-stopped --с 2026-08-01
    python3 scripts/tg_kassa.py --мак --с 2026-08-01         под своим номером
    python3 scripts/tg_kassa.py --мак --позавчера           дата считается сама
"""

import argparse
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from db import load_env  # noqa: E402

load_env(need=("TG_API_ID", "TG_API_HASH"))

import os  # noqa: E402

ПАПКА = Path(__file__).resolve().parent
КУДА = ПАПКА.parent / "data" / "чат-кассы.json"

# Найден 22.08.2026 через scripts/tg_groups.py. Держим здесь, а не в .env:
# TG_GROUP_ID занят группой чаевых Сбера, и путать их нельзя.
ЧАТ_КАССЫ = -4581053763

# Сутки заведения — с 11:00 до 10:59, как везде в проекте. Сообщение в три
# часа ночи относится к вечеру ВЧЕРАШНЕГО дня, и датировать его календарно
# значило бы развести чат со списком возвратов на ровном месте.
СМЕНА_НАЧИНАЕТСЯ = 11


def торговый_день(момент: datetime) -> str:
    from datetime import timedelta
    return (момент - timedelta(hours=СМЕНА_НАЧИНАЕТСЯ)).strftime("%Y-%m-%d")


def главное() -> None:
    p = argparse.ArgumentParser(description="Читает чат кассы.")
    p.add_argument("--сколько", type=int, default=200, dest="сколько",
                   help="сколько последних сообщений смотреть")
    p.add_argument("--с", dest="с", metavar="ГГГГ-ММ-ДД",
                   help="брать только с этого торгового дня")
    p.add_argument("--позавчера", action="store_true", dest="позавчера",
                   help="то же, что --с с позавчерашним днём: дата считается "
                        "сама, чтобы текст команды не менялся изо дня в день")
    p.add_argument("--мак", action="store_true",
                   help="читать под отдельной сессией Мака (свой номер)")
    p.add_argument("--robot-stopped", action="store_true", dest="робот_стоит",
                   help="подтверждаю: читалка на Amvera остановлена")
    a = p.parse_args()

    # ⚠️ Дата внутри команды ломала утреннюю задачу. Разрешение на запуск
    # хранится СТРОКОЙ КОМАНДЫ ЦЕЛИКОМ: «--с 2026-08-27» — это не то же самое,
    # что «--с 2026-08-26», и каждое утро задача упиралась в новый вопрос
    # и стояла до тех пор, пока владелец его не заметит. 29.08.2026 простояла
    # так пять часов. С ключом --позавчера текст команды один и тот же всегда.
    if a.позавчера and not a.с:
        a.с = (date.today() - timedelta(days=2)).isoformat()
        print(f"Позавчерашний торговый день: {a.с}")

    сессия = ПАПКА / (".tg-mac-session" if a.мак else ".tg-session")

    # ⚠️ Отдельная сессия Мака снимает запрет только если она ДЕЙСТВИТЕЛЬНО
    # заведена под другим номером. Проверить это отсюда нечем, поэтому хотя бы
    # не даём молча читать несуществующим файлом.
    if a.мак and not Path(f"{сессия}.session").exists():
        sys.exit(
            f"Нет файла сессии {сессия.name}.session.\n"
            "Сначала войдите под отдельным номером:\n"
            "    python3 scripts/tg_login.py --мак"
        )
    if not a.мак and not a.робот_стоит:
        sys.exit(
            "Стоп. Без ключа --мак скрипт пойдёт под тем же аккаунтом, что\n"
            "робот на Amvera. Telegram отключает ключ, работающий с двух\n"
            "адресов сразу, и робот замолкает — без единой ошибки на экране.\n"
            "Так пропали чаевые по QR за 18.08.2026.\n\n"
            "Либо остановите читалку в панели Amvera и повторите запуск\n"
            "с --robot-stopped, либо заведите Маку отдельный номер:\n"
            "    python3 scripts/tg_login.py --мак"
        )

    try:
        from telethon.sync import TelegramClient
    except ModuleNotFoundError:
        sys.exit("Не установлена telethon: python3 -m pip install --user telethon")

    клиент = TelegramClient(str(сессия), int(os.environ["TG_API_ID"]),
                            os.environ["TG_API_HASH"])
    клиент.connect()
    if not клиент.is_user_authorized():
        клиент.disconnect()
        sys.exit("Сессия не годится. Войдите заново: python3 scripts/tg_login.py"
                 + (" --мак" if a.мак else ""))

    try:
        try:
            чат = клиент.get_entity(ЧАТ_КАССЫ)
        except Exception as e:
            имя = type(e).__name__
            sys.exit(
                f"Чат {ЧАТ_КАССЫ} недоступен ({имя}).\n"
                "Обычно это значит, что аккаунт в него не добавлен.\n"
                "Список групп аккаунта:  python3 scripts/tg_groups.py\n\n"
                "⚠️ Молчание — это не «замечаний нет». Пока чат недоступен,\n"
                "объяснения по возвратам продолжают писаться, а мы их не видим."
            )

        print(f"Чат: {getattr(чат, 'title', '—')}")
        собрано = []
        for m in клиент.iter_messages(чат, limit=a.сколько):
            if not m.message:
                continue
            момент = m.date.astimezone(timezone.utc).replace(tzinfo=None)
            день = торговый_день(момент)
            if a.с and день < a.с:
                break
            автор = ""
            try:
                о = m.get_sender()
                автор = " ".join(x for x in [getattr(о, "first_name", None),
                                             getattr(о, "last_name", None)] if x) or ""
            except Exception:
                pass
            собрано.append({"id": m.id, "день": день,
                            "время": момент.strftime("%Y-%m-%dT%H:%M:%S"),
                            "автор": автор, "текст": m.message})
        собрано.sort(key=lambda з: з["время"])

        if not собрано:
            print("\n⚠️  Сообщений не найдено. Это НЕ значит «замечаний нет» —")
            print("    проверьте период (--с) и то, что аккаунт в чате состоит.")
            return

        по_дням = {}
        for з in собрано:
            по_дням.setdefault(з["день"], []).append(з)
        print(f"Сообщений: {len(собрано)}, дней: {len(по_дням)}\n")
        for день in sorted(по_дням):
            print(f"── {день} " + "─" * 46)
            for з in по_дням[день]:
                текст = з["текст"].replace("\n", " ⏎ ")
                print(f"   {з['время'][11:16]}  {(з['автор'] or '—')[:18]:<18} {текст[:88]}")

        КУДА.parent.mkdir(parents=True, exist_ok=True)
        КУДА.write_text(json.dumps(собрано, ensure_ascii=False, indent=1),
                        encoding="utf-8")
        print(f"\nСохранено: {КУДА.relative_to(ПАПКА.parent)} — "
              f"чтобы не ходить в Telegram второй раз за тем же самым.")
    finally:
        клиент.disconnect()


if __name__ == "__main__":
    главное()
