#!/usr/bin/env python3
"""Резервная копия базы: архив под паролем, отправленный в Telegram.

Зачем. Всё живёт на Amvera — и приложение, и база. Пропадёт хостинг, не
останется ничего: его собственные бэкапы обещаны, но восстановление из них
ни разу не проверяли. Копия в Telegram лежит вне Amvera, и это самая дешёвая
страховка из возможных.

Почему под паролем. В базе фамилии сотрудников и все их заработки. Облако
Телеграма — чужое хранилище, класть туда такое открытым нельзя. Пароль
задаётся переменной `BACKUP_PASSWORD`; **не задан — копия не делается вовсе**,
и об этом говорится в журнале. Молча сложить открытые фамилии в чужое облако
хуже, чем не сложить ничего.

Почему CSV, а не `pg_dump`. Его в образе нет, а тянуть его надо ровно той же
версии, что сервер, — иначе он откажется работать в самый неподходящий день.
CSV читается чем угодно и не устаревает. Схема при восстановлении берётся
из `mini-app/scripts/schema.sql`: второй копии схемы в проекте быть не должно.

Почему отправка ботом, а не тем же telethon, которым робот читает группу.
11.08.2026 выяснилось: Amvera не выпускает соединения к дата-центрам Telegram,
и telethon с сервера не работает вовсе. А `api.telegram.org` отвечает за 0,3 с —
это обычный https. Поэтому копия уходит через бота (`tgbot.py`) и не зависит
от того, починится ли чтение чаевых.

Что нужно задать в панели Amvera: `BACKUP_PASSWORD`, `TG_BOT_TOKEN`
и `TG_BACKUP_CHAT` — переписка, куда слать. Не хватает любого — копии не будет,
и робот скажет об этом словами.

Проверить, ничего не отправляя:

    python3 backup.py --file /tmp/копия.zip
"""

# На компьютере владельца Python 3.9, на сервере 3.12 — см. пояснение
# в qr_reader.py. Без этой строки подписи вроде `str | None` не разберутся.
from __future__ import annotations

import io
import os
import sys
from datetime import datetime

import tgbot


def password() -> str | None:
    """Пароль от архива. Пусто и пробелы считаем за «не задан»."""
    value = (os.environ.get("BACKUP_PASSWORD") or "").strip()
    return value or None


def table_names(conn, schema: str) -> list[str]:
    """Все таблицы схемы. Список берём у базы, а не пишем руками: заведут
    новую таблицу — она попадёт в копию сама, без правки этого файла."""
    with conn.cursor() as cur:
        cur.execute(
            "select tablename from pg_tables where schemaname = %s order by tablename",
            (schema,),
        )
        return [row[0] for row in cur.fetchall()]


def table_csv(conn, schema: str, table: str) -> bytes:
    """Одна таблица целиком, в CSV с заголовком."""
    from psycopg import sql

    query = sql.SQL("copy {}.{} to stdout with (format csv, header)").format(
        sql.Identifier(schema), sql.Identifier(table)
    )
    chunks: list[bytes] = []
    with conn.cursor() as cur:
        with cur.copy(query) as copy:
            for chunk in copy:
                chunks.append(bytes(chunk))
    return b"".join(chunks)


def restore_note(schema: str, when: datetime, tables: dict[str, int]) -> str:
    """Записка внутрь архива. Через год никто не вспомнит, что это за файлы."""
    lines = [
        "РЕЗЕРВНАЯ КОПИЯ БАЗЫ «Барвиха Невский»",
        "",
        f"Снята: {when.strftime('%d.%m.%Y в %H:%M')} по Москве",
        f"Схема: {schema}",
        "",
        "Что внутри: по одному CSV-файлу на каждую таблицу базы.",
        "",
        "Таблицы и сколько в них строк:",
    ]
    for name, rows in sorted(tables.items()):
        lines.append(f"  {name} — {rows}")
    lines += [
        "",
        "КАК ВОССТАНОВИТЬ",
        "",
        "1. Поднять пустую базу PostgreSQL.",
        "2. Применить схему из проекта: mini-app/scripts/schema.sql.",
        "   Схемы в этом архиве нет намеренно — она живёт в одном месте,",
        "   в репозитории, и двух расходящихся копий у неё быть не должно.",
        "3. Влить CSV по одному, например через psql:",
        "      \\copy имя_таблицы from 'имя_таблицы.csv' with (format csv, header)",
        "   Порядок важен: сначала entries и shifts, потом остальное.",
        "",
        "Копию делает робот chaevye-reader раз в неделю. Пароль от архива",
        "лежит у владельца и в переменной BACKUP_PASSWORD в панели Amvera.",
    ]
    return "\n".join(lines)


def build(conn, schema: str, secret: str, when: datetime) -> tuple[bytes, str]:
    """Собрать зашифрованный архив в памяти. Вернуть (архив, что сказать людям)."""
    try:
        import pyzipper
    except ModuleNotFoundError:
        raise RuntimeError(
            "Не установлена pyzipper — она делает архив под паролем. "
            "Поставить: pip install pyzipper"
        )

    names = table_names(conn, schema)
    if not names:
        raise RuntimeError(f"В схеме {schema} нет ни одной таблицы — копировать нечего")

    dumps = {name: table_csv(conn, schema, name) for name in names}
    # Строк в таблице — это строки CSV минус заголовок.
    counts = {name: max(data.count(b"\n") - 1, 0) for name, data in dumps.items()}

    buffer = io.BytesIO()
    with pyzipper.AESZipFile(
        buffer, "w", compression=pyzipper.ZIP_DEFLATED, encryption=pyzipper.WZ_AES
    ) as archive:
        archive.setpassword(secret.encode("utf-8"))
        for name, data in dumps.items():
            archive.writestr(f"{name}.csv", data)
        archive.writestr(
            "КАК-ВОССТАНОВИТЬ.txt", restore_note(schema, when, counts).encode("utf-8")
        )

    blob = buffer.getvalue()
    total = sum(counts.values())
    note = f"{len(names)} таблиц, {total} строк, {len(blob) / 1024:.0f} КБ"
    return blob, note


def recipient(log) -> str | None:
    """Кому слать. Задаётся переменной `TG_BACKUP_CHAT`.

    Не задана — спрашиваем у Telegram, кто писал боту, и печатаем номер
    в журнал, чтобы его осталось вписать в панель. Само по себе гадание
    ненадёжно: Telegram помнит эти события около суток.
    """
    fixed = (os.environ.get("TG_BACKUP_CHAT") or "").strip()
    if fixed:
        return fixed

    found = tgbot.find_chat()
    if found:
        log.warning(
            "⚠️  не задан TG_BACKUP_CHAT. Боту писали из переписки %s — впишите "
            "это число в переменные Amvera, иначе через сутки адрес потеряется",
            found,
        )
        return found

    log.error(
        "не задан TG_BACKUP_CHAT, и боту никто не писал. Откройте переписку "
        "с ботом, отправьте любое сообщение и перезапустите контейнер"
    )
    return None


def send(chat: str, blob: bytes, when: datetime, note: str) -> None:
    """Отправить архив обычным https через api.telegram.org."""
    # Имя файла латиницей намеренно. Оно едет в заголовке запроса, а кириллица
    # там кодируется по-разному и читается получателем неоднозначно: в разборе
    # 11.08.2026 «база-невский» превратилась в мусор. Всё человеческое —
    # в подписи к файлу, она идёт отдельным полем и с кодировкой не спорит.
    tgbot.send_document(
        chat,
        f"baza-nevskiy-{when.strftime('%Y-%m-%d')}.zip",
        blob,
        caption=(
            f"Резервная копия базы, {when.strftime('%d.%m.%Y')}. {note}. "
            "Архив под паролем — он в панели Amvera, переменная BACKUP_PASSWORD."
        ),
    )


def run(conn, schema: str, when: datetime, log) -> str:
    """Дело для расписания: собрать и отправить. Вернуть строку для журнала."""
    secret = password()
    if not secret:
        # Это не поломка, а сознательный отказ: см. пояснение в начале файла.
        return "пропущено: не задан BACKUP_PASSWORD, без него копию не делаем"
    if not tgbot.token():
        return "пропущено: не задан TG_BOT_TOKEN, отправлять нечем"

    chat = recipient(log)
    if not chat:
        return "пропущено: некуда слать, см. строку выше"

    blob, note = build(conn, schema, secret, when)
    send(chat, blob, when, note)
    return f"отправлено в Telegram — {note}"


def main() -> None:
    """Ручная проверка: собрать архив и положить файлом, никуда не отправляя."""
    import qr_reader as core

    if "--file" not in sys.argv:
        sys.exit(__doc__)
    target = sys.argv[sys.argv.index("--file") + 1]

    secret = password()
    if not secret:
        sys.exit("Не задан BACKUP_PASSWORD — без пароля архив не собираем")

    conn, schema = core.connect()
    try:
        when = datetime.now(core.MOSCOW)
        blob, note = build(conn, schema, secret, when)
    finally:
        conn.close()

    with open(target, "wb") as file:
        file.write(blob)
    print(f"Готово: {target}\n{note}")


if __name__ == "__main__":
    main()
