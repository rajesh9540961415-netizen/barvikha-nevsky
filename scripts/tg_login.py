#!/usr/bin/env python3
"""Разовый вход в Telegram служебным аккаунтом и поиск нужной группы.

Запускать этот скрипт должна владелец сама: он спросит номер телефона
и код, который придёт в Telegram. Код — это ключ от всего аккаунта,
поэтому вводит его человек, а не я.

После входа рядом появится файл сессии `.tg-session.session`. Дальше вход
не понадобится: чтение уведомлений будет пользоваться этим файлом.
Он в git не уходит — так задано в .gitignore. Относиться к нему нужно
как к паролю.

Что нужно заранее:

1. Служебный аккаунт Telegram должен состоять в группе «СберЧаевые Невский».
2. На https://my.telegram.org под этим же номером завести приложение
   (раздел «API development tools») и вписать в .env:

       TG_API_ID=12345678
       TG_API_HASH=строка_из_кабинета

Запуск:  python3 scripts/tg_login.py
"""

import sys
from getpass import getpass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
SESSION = Path(__file__).resolve().parent / ".tg-session"

# Ищем именно её. Сверяем по названию, id узнаем и запишем в .env ниже.
GROUP_TITLE = "СберЧаевые Невский"


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
    for key in ("TG_API_ID", "TG_API_HASH"):
        if not cfg.get(key):
            sys.exit(
                f"В .env не заполнено: {key}\n"
                "Значения берутся на https://my.telegram.org → "
                "API development tools, под номером служебного аккаунта."
            )
    return cfg


def main():
    try:
        from telethon.sync import TelegramClient
    except ModuleNotFoundError:
        sys.exit(
            "Не установлена библиотека telethon. Поставить:\n"
            "    python3 -m pip install --user telethon"
        )

    cfg = read_env()

    print("=" * 60)
    print("Вход в Telegram служебным аккаунтом")
    print("=" * 60)
    print()
    print("Сейчас будет два вопроса. Отвечать прямо здесь, в этом окне:")
    print()
    print("  1. Номер телефона — вводите СЛУЖЕБНЫЙ, а не личный.")
    print("     В международном виде, с плюсом: +79991234567")
    print()
    print("  2. Код — придёт в приложение Telegram служебного аккаунта,")
    print("     в служебный чат «Telegram». Не по СМС. Пять цифр.")
    print()
    print("После каждого ответа нажимайте Enter.")
    print("-" * 60)
    print()

    client = TelegramClient(str(SESSION), int(cfg["TG_API_ID"]), cfg["TG_API_HASH"])
    client.start(
        phone=lambda: input("Номер служебного аккаунта: ").strip(),
        code_callback=lambda: input("Код из приложения Telegram: ").strip(),
        # Спрашивается, только если на аккаунте включён облачный пароль.
        # getpass — чтобы пароль не остался в окне терминала.
        password=lambda: getpass("Облачный пароль Telegram: "),
    )

    try:
        me = client.get_me()
        print(f"\n✓ Вход выполнен: {me.first_name or ''} {me.last_name or ''}".rstrip())
        print(f"  файл сессии: {SESSION}.session")
        print("  Относитесь к нему как к паролю: с ним можно войти без кода.\n")

        # Показываем только группы и каналы: личные переписки нас не касаются,
        # и печатать их названия ни к чему.
        print("Группы и каналы, в которых состоит этот аккаунт:\n")
        found = None
        for dialog in client.iter_dialogs():
            if not (dialog.is_group or dialog.is_channel):
                continue
            mark = " "
            if dialog.name and GROUP_TITLE.lower() in dialog.name.lower():
                found = dialog
                mark = "→"
            print(f" {mark} {dialog.id:>16}  {dialog.name}")

        print()
        if found:
            print(f"Нужная группа найдена: «{found.name}»")
            print("Осталось вписать в .env строку:\n")
            print(f"    TG_GROUP_ID={found.id}\n")
        else:
            print(f"Группа «{GROUP_TITLE}» среди них не нашлась.")
            print("Добавьте служебный аккаунт в группу и запустите скрипт снова.")
    finally:
        client.disconnect()


if __name__ == "__main__":
    main()
