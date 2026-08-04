"""Настройки для скриптов, которые запускают на компьютере владельца.

На сервере читатель QR-чаевых берёт всё из переменных окружения — так устроены
любые хостинги, и Amvera не исключение. На компьютере те же значения лежат
файлами: `.env` (Telegram, Quick Resto) и `mini-app/.env.local` (база).

Этот модуль просто переносит их в окружение. Дальше работает ровно тот же код,
что и на сервере, — `tg-reader/qr_reader.py`. Второй ветки «а на компьютере
по-другому» не заводим: именно в таких ветках и живут расхождения, которые
обнаруживаются в бою.

⚠️ Боевые и тестовые данные разделены схемами одной базы. Значение
`DATABASE_SCHEMA` в `.env.local` — `test`, и это защита: скрипт, запущенный
без явного указания, пишет в тестовую схему, а не поверх денег смены.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
ENV_LOCAL = ROOT / "mini-app" / ".env.local"
READER = ROOT / "tg-reader"


def _read(path: Path) -> dict[str, str]:
    """Читает файл вида КЛЮЧ=значение. Значения могут быть в кавычках."""
    if not path.exists():
        return {}
    cfg: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        cfg[key.strip()] = value
    return cfg


def load_env(need: tuple[str, ...] = ()) -> None:
    """Кладёт настройки из файлов проекта в переменные окружения.

    Уже заданные переменные не трогает: заданное руками должно побеждать файл,
    иначе разовую проверку не сделать, не правя файл.
    """
    for path in (ENV, ENV_LOCAL):
        for key, value in _read(path).items():
            os.environ.setdefault(key, value)

    missing = [key for key in need if not os.environ.get(key)]
    if missing:
        where = "`.env`" if missing[0].startswith("TG_") else "`mini-app/.env.local`"
        sys.exit(f"Не заполнено: {', '.join(missing)} — искать в {where}")


def use_reader_code() -> None:
    """Делает доступным общий код читателя из папки tg-reader."""
    if not READER.exists():
        sys.exit(f"Нет папки {READER} — там лежит общий код читателя.")
    sys.path.insert(0, str(READER))
