"""Связь скриптов с базой приложения.

Строку подключения берём оттуда же, откуда её берёт приложение, —
из `mini-app/.env.local`. Вторую копию доступов не заводим: две копии
рано или поздно разъезжаются, и тогда скрипт пишет не в ту базу.

⚠️ Боевые и тестовые данные разделены схемами одной базы: настоящие деньги
смены — в `public`, проверки — в `test` (см. CLAUDE.md, раздел «Стек»).
Поэтому правило здесь жёсткое: **по умолчанию скрипт работает с той схемой,
что записана в `.env.local`** (а там `test`), и в боевую попадает только
по явному требованию. Забыть флаг безопасно, поставить лишний — нет.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_LOCAL = ROOT / "mini-app" / ".env.local"

PROD_SCHEMA = "public"


def read_env_local() -> dict[str, str]:
    """Читает mini-app/.env.local. Значения могут быть в кавычках — снимаем."""
    if not ENV_LOCAL.exists():
        sys.exit(
            "Нет файла mini-app/.env.local — в нём лежит строка подключения "
            "к базе. Он не в git, поэтому на новой машине его надо создать."
        )
    cfg: dict[str, str] = {}
    for line in ENV_LOCAL.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        cfg[key.strip()] = value
    return cfg


def connect(schema: str | None = None):
    """Открывает соединение с базой. Возвращает (соединение, имя схемы).

    Соединение без autocommit: скрипты сами решают, когда закрепить запись.
    Так частично записанная пачка не останется в базе, если что-то упало
    посередине.
    """
    try:
        import psycopg
        from psycopg import sql
    except ModuleNotFoundError:
        sys.exit(
            "Не установлена psycopg — библиотека связи Python с PostgreSQL.\n"
            "Поставить: python3 -m pip install --user 'psycopg[binary]'"
        )

    cfg = read_env_local()
    url = cfg.get("DATABASE_URL")
    if not url:
        sys.exit("В mini-app/.env.local не заполнено DATABASE_URL")

    target = schema or cfg.get("DATABASE_SCHEMA") or PROD_SCHEMA

    conn = psycopg.connect(url, connect_timeout=10)
    with conn.cursor() as cur:
        # Имя схемы подставляем как идентификатор, а не склейкой строк:
        # склейка — это тот самый способ, которым в базу проникает чужой код.
        cur.execute(sql.SQL("set search_path to {}").format(sql.Identifier(target)))
    conn.commit()
    return conn, target


def describe(schema: str) -> str:
    """Как назвать схему человеку, чтобы боевую было видно сразу."""
    if schema == PROD_SCHEMA:
        return f"{schema} — БОЕВАЯ, здесь настоящие деньги смены"
    return f"{schema} — тестовая, боевые данные не тронуты"
