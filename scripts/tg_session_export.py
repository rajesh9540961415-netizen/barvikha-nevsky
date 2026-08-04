#!/usr/bin/env python3
"""Обращает файл сессии Telegram в строку — для переменной окружения.

Зачем. На сервере сессия нужна читателю QR-чаевых, но класть её файлом на диск
плохо: файл легко скопировать вместе с кодом и легко забыть про него. Строкой
она живёт переменной окружения в панели Amvera — там же, где пароль от базы.

⚠️ Полученная строка — это КЛЮЧ ОТ АККАУНТА, не хуже пароля. Кто им завладел,
читает всю переписку этого аккаунта. Поэтому:
  • на экран строка не печатается, а кладётся в файл рядом со скриптом;
  • файл в git не уходит;
  • после того как вставите строку в панель Amvera, файл удалите.

Запуск:  python3 scripts/tg_session_export.py
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ENV = ROOT / ".env"
SESSION = HERE / ".tg-session"
OUT = HERE / ".tg-session-string.txt"


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
    return cfg


def main():
    try:
        from telethon.sessions import StringSession
        from telethon.sync import TelegramClient
    except ModuleNotFoundError:
        sys.exit("Не установлена telethon: python3 -m pip install --user telethon")

    cfg = read_env()
    for key in ("TG_API_ID", "TG_API_HASH"):
        if not cfg.get(key):
            sys.exit(f"В .env не заполнено: {key}")

    client = TelegramClient(str(SESSION), int(cfg["TG_API_ID"]), cfg["TG_API_HASH"])
    client.connect()
    if not client.is_user_authorized():
        client.disconnect()
        sys.exit("Сессия не годится. Сначала войдите: python3 scripts/tg_login.py")

    me = client.get_me()
    text = StringSession.save(client.session)
    client.disconnect()

    OUT.write_text(text + "\n", encoding="utf-8")
    OUT.chmod(0o600)

    print(f"Аккаунт: {me.first_name} (id {me.id})")
    print(f"Строка сессии записана в файл: {OUT}")
    print(f"Длина: {len(text)} символов")
    print()
    print("Что дальше:")
    print("  1. Открыть файл и скопировать строку целиком.")
    print("  2. В панели Amvera завести переменную TG_SESSION с этим значением.")
    print("  3. Удалить файл — он больше не нужен:")
    print(f"     rm {OUT}")
    print()
    print("⚠️  Эта строка — ключ от аккаунта. Не пересылать в мессенджерах,")
    print("    не вставлять в переписку, не коммитить.")


if __name__ == "__main__":
    main()
