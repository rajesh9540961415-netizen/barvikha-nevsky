#!/usr/bin/env python3
"""Вход в Telegram и список групп аккаунта.

Запускать этот скрипт должна владелец сама: он спросит номер телефона
и код из Telegram. Код — ключ от всего аккаунта, поэтому вводит его человек.

🔴 СЕССИЙ ДОЛЖНО БЫТЬ ДВЕ, И ПОД РАЗНЫМИ НОМЕРАМИ.

Робот на Amvera, читающий чаевые по QR, работает под аккаунтом «Марина».
Telegram рвёт ключ, работающий с двух адресов сразу, — и робот перестаёт
читать группу МОЛЧА, без единой ошибки на экране. Так пропали чаевые по QR
за 18.08.2026, и 22.08 на этом же чуть не оборвали его снова.

Отсюда правило: **у Мака свой номер телефона и своя сессия.**

    робот на Amvera   аккаунт «Марина»      сессия .tg-session
    Мак               ОТДЕЛЬНЫЙ номер       сессия .tg-mac-session

⚠️ Разный ФАЙЛ сессии этого не решает — Telegram считает по аккаунту,
а не по файлу. Нужен именно другой номер.

⚠️ Свежий аккаунт не видит НИЧЕГО, пока его не позвали в группы. После входа
попросите администратора добавить новый номер в нужные чаты — «ЧАТ КАССЫ!»
и, если нужно, «ЧАЕВЫЕ ОФ». Пустой список групп после входа — это норма,
а не поломка.

💡 TG_API_ID и TG_API_HASH менять не надо: они опознают ПРИЛОЖЕНИЕ, а не
человека, и годятся для любого аккаунта.

Запуск:
    python3 scripts/tg_login.py                 сессия по умолчанию (робот)
    python3 scripts/tg_login.py --мак           отдельная сессия Мака
    python3 scripts/tg_login.py --сессия ИМЯ    любая другая

После входа печатается имя аккаунта и все его группы с номерами. Файл сессии
в git не уходит (.gitignore). Относиться к нему как к паролю: с ним входят
без кода.
"""

import sys
from getpass import getpass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
ПАПКА = Path(__file__).resolve().parent
СЕССИИ = {"робот": ".tg-session", "мак": ".tg-mac-session"}


def выбрать_сессию() -> Path:
    """Какой файл сессии заводим. По умолчанию — прежний, робота."""
    if "--мак" in sys.argv:
        return ПАПКА / СЕССИИ["мак"]
    if "--сессия" in sys.argv:
        return ПАПКА / sys.argv[sys.argv.index("--сессия") + 1]
    return ПАПКА / СЕССИИ["робот"]


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
    SESSION = выбрать_сессию()
    мак = SESSION.name == СЕССИИ["мак"]

    print("=" * 60)
    print("Вход в Telegram" + (" — ОТДЕЛЬНАЯ СЕССИЯ МАКА" if мак else ""))
    print("=" * 60)
    print()
    if мак:
        print("⚠️  Вводите НОВЫЙ, отдельный номер — не тот, под которым")
        print("    работает робот на Amvera. Один номер с двух адресов")
        print("    Telegram отключает, и робот замолкает без предупреждения.")
        print()
    elif (ПАПКА / СЕССИИ["робот"]).exists():
        print("⚠️  Файл сессии робота уже есть. Если вам нужна сессия для Мака —")
        print("    выйдите (Ctrl+C) и запустите с ключом --мак.")
        print()
    print("Сейчас будет два вопроса. Отвечать прямо здесь, в этом окне:")
    print()
    print("  1. Номер телефона в международном виде, с плюсом: +79991234567")
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
        #
        # ⚠️ Здесь скрипт искал ОДНУ группу по жёстко вбитому имени
        # «СберЧаевые Невский» и ругался, если не нашёл. Имя устарело: живая
        # группа называется иначе, а мёртвая одноимённая осталась висеть.
        # 22.08.2026 владелец получила «группа не нашлась» после успешного
        # входа и решила, что вход не удался. Ищем теперь не одну группу,
        # а печатаем все — пусть человек выберет.
        print("Группы и каналы, в которых состоит этот аккаунт:\n")
        сколько = 0
        for dialog in client.iter_dialogs():
            if not (dialog.is_group or dialog.is_channel):
                continue
            сколько += 1
            print(f"   {dialog.id:>16}  {dialog.name}")

        print()
        if not сколько:
            print("Групп нет ни одной — для нового номера это НОРМА.")
            print("Попросите администратора добавить его в «ЧАТ КАССЫ!»,")
            print("после чего запустите скрипт снова: список обновится.")
        else:
            print("Номер нужной группы берите отсюда — он со знаком минус.")
    finally:
        client.disconnect()


if __name__ == "__main__":
    main()
