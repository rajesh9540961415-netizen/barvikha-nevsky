#!/usr/bin/env python3
"""Список групп и каналов служебного аккаунта Telegram.

Нужен, когда группа с уведомлениями «СберЧаевые PRO» пересоздана и надо
узнать идентификатор новой. Скрипт показывает ТОЛЬКО название и id.

Чего скрипт не делает намеренно:

  * не открывает и не читает ни одного сообщения;
  * не показывает личные переписки — только группы и каналы;
  * ничего не пишет ни в .env, ни в базу.

Вход не спрашивает: пользуется файлом сессии от scripts/tg_login.py.

Запуск:

    python3 scripts/tg_groups.py            все группы и каналы
    python3 scripts/tg_groups.py чаев       только те, где в названии «чаев»

См. plans/2026-08-03-qr-chaevye.md
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
SESSION = Path(__file__).resolve().parent / ".tg-session"

# Слова, по которым скрипт сам подсвечивает подходящие названия.
# Пишутся в нижнем регистре: сравнение регистр не различает.
HINTS = ("сберчаевые", "чаев", "sbertips", "sber")


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

    needle = sys.argv[1].lower() if len(sys.argv) > 1 else None

    cfg = read_env()
    current = cfg.get("TG_GROUP_ID", "")

    client = TelegramClient(str(SESSION), int(cfg["TG_API_ID"]), cfg["TG_API_HASH"])
    client.connect()
    if not client.is_user_authorized():
        client.disconnect()
        sys.exit("Сессия не годится. Запустите заново: python3 scripts/tg_login.py")

    try:
        me = client.get_me()
        print(f"Аккаунт: {(me.first_name or '').strip()} (id {me.id})")
        print("Показываю только группы и каналы. Сообщения не читаются.\n")

        rows = []
        for dialog in client.iter_dialogs():
            # Личные переписки и переписки с ботами пропускаем целиком:
            # они нас не касаются, и печатать их названия ни к чему.
            if not (dialog.is_group or dialog.is_channel):
                continue
            name = dialog.name or "(без названия)"
            if needle and needle not in name.lower():
                continue
            rows.append((dialog.id, name))

        if not rows:
            print("Ничего не нашлось." if needle else "Групп и каналов нет.")
            return

        print(f"{'id':>16}  название")
        print("-" * 60)
        candidates = []
        for chat_id, name in rows:
            mark = " "
            if any(hint in name.lower() for hint in HINTS):
                mark = "→"
                candidates.append((chat_id, name))
            if str(chat_id) == current:
                mark = "•" if mark == " " else "→"
            print(f"{mark}{chat_id:>15}  {name}")

        print(f"\nВсего групп и каналов: {len(rows)}")
        print("  •  — та, что сейчас записана в .env как TG_GROUP_ID")
        print("  →  — подходит по названию под «Сбер»/«Чаевые»")

        if candidates:
            print("\nКандидаты:")
            for chat_id, name in candidates:
                now = "  ← сейчас в .env" if str(chat_id) == current else ""
                print(f"  TG_GROUP_ID={chat_id}   «{name}»{now}")
    finally:
        client.disconnect()


if __name__ == "__main__":
    main()
