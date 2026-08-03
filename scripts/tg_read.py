#!/usr/bin/env python3
"""Чтение поступлений по QR из группы «СберЧаевые Невский».

Читает ТОЛЬКО одну группу — ту, что указана в .env как TG_GROUP_ID.
Из каждого сообщения берёт ТОЛЬКО сумму, команду и время: оценка, отметки
и текстовый отзыв гостя не сохраняются и не печатаются.

Вход не спрашивает: пользуется файлом сессии, созданным scripts/tg_login.py.

Запуск:  python3 scripts/tg_read.py [сколько_последних_сообщений]

Пока это разведка: скрипт ничего никуда не записывает, только показывает,
что удалось разобрать. Запись в базу — следующая фаза, см.
plans/2026-08-03-qr-chaevye.md
"""

import sys
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sber_parse import parse  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
SESSION = Path(__file__).resolve().parent / ".tg-session"

# Бизнес-день заведения начинается в 11:00 — как в Quick Resto и в приложении.
# Ночные чаевые принадлежат смене, которая началась накануне.
BUSINESS_DAY_START_HOUR = 11


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
    local = moment.astimezone()
    if local.hour < BUSINESS_DAY_START_HOUR:
        local = local - timedelta(days=1)
    return local.strftime("%Y-%m-%d"), local


def main():
    try:
        from telethon.sync import TelegramClient
    except ModuleNotFoundError:
        sys.exit("Не установлена telethon: python3 -m pip install --user telethon")

    cfg = read_env()
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 200

    client = TelegramClient(str(SESSION), int(cfg["TG_API_ID"]), cfg["TG_API_HASH"])
    client.connect()
    if not client.is_user_authorized():
        client.disconnect()
        sys.exit("Сессия не годится. Запустите заново: python3 scripts/tg_login.py")

    try:
        group = client.get_entity(int(cfg["TG_GROUP_ID"]))
        print(f"Группа: {getattr(group, 'title', '—')}")
        print(f"Смотрю последние {limit} сообщений\n")

        found, skipped = [], 0
        for message in client.iter_messages(group, limit=limit):
            notice = parse(message.message or "")
            if notice is None:
                skipped += 1
                continue
            day, local = business_day(message.date)
            found.append((day, local, notice))

        if not found:
            print("Поступлений по QR не найдено.")
            return

        print(f"{'смена':<12} {'время':<6} {'сумма':>12}  команда")
        print("-" * 50)
        by_day = defaultdict(float)
        by_team = defaultdict(float)
        for day, local, notice in reversed(found):
            by_day[day] += notice.amount
            by_team[notice.team] += notice.amount
            print(
                f"{day:<12} {local.strftime('%H:%M'):<6} "
                f"{notice.amount:>10,.2f} ₽  {notice.team}"
            )

        total = sum(n.amount for _, _, n in found)
        print("-" * 50)
        print(f"разобрано {len(found)}, пропущено {skipped}, всего {total:,.2f} ₽\n")

        print("по сменам:")
        for day in sorted(by_day):
            print(f"  {day}  {by_day[day]:>10,.2f} ₽")

        print("\nпо командам:")
        for team in sorted(by_team, key=lambda t: -by_team[t]):
            print(f"  {team:<16} {by_team[team]:>10,.2f} ₽")
    finally:
        client.disconnect()


if __name__ == "__main__":
    main()
