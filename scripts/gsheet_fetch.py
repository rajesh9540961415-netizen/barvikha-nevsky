#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Скачивает таблицу «Выручка Невский 2026» служебным ключом Google.

Зачем. До 22.08.2026 таблицу забирали коннектором Google Диска — то есть
руками, из разговора. Поэтому её копия в `data/dds/gsheet_raw.json` замерла
19.08 в 11:55, а сама таблица менялась 21-го. Наличные расходы (включая
такси и мотивацию бара) две недели считались по устаревшему снимку, и в
бэк-офисе их не было. Ручной шаг посреди ежедневной цепочки — это не шаг,
а место, где цепочка рвётся.

Пишет в тот же файл и в том же виде, что отдавал коннектор: строки таблицы,
склеенные вертикальной чертой. Так `cash_import.py` менять не пришлось —
он этот вид уже разбирает.

⚠️ ДОСТУП. Таблицу нужно ОДИН РАЗ открыть служебному роботу:
    robot-otchyoty@nevskiy-reports.iam.gserviceaccount.com
Достаточно права «Просмотр». Без этого Google отвечает 403, и скрипт
говорит об этом прямо, а не пишет пустой файл.

⚠️ Пустую таблицу НЕ сохраняем. Затереть рабочую копию пустышкой — значит
обнулить наличные расходы во всём учёте и не заметить этого до конца месяца.

Запуск:  python3 scripts/gsheet_fetch.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
КЛЮЧ = ROOT / "data" / "certs" / "google-robot.json"
КУДА = ROOT / "data" / "dds" / "gsheet_raw.json"
ТАБЛИЦА = "1bvnxNodVld0d6lPRgd4QWZtMUCK_Bi2Or7_osoKM5lM"
ОБЛАСТЬ = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# Меньше этого — почти наверняка сбой, а не опустевшая таблица.
МИНИМУМ_ЗНАКОВ = 20_000


def главное() -> None:
    if not КЛЮЧ.exists():
        sys.exit(f"Нет ключа {КЛЮЧ}")
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(
        str(КЛЮЧ), scopes=ОБЛАСТЬ)
    api = build("sheets", "v4", credentials=creds, cache_discovery=False)

    try:
        мета = api.spreadsheets().get(
            spreadsheetId=ТАБЛИЦА, fields="properties.title,sheets.properties.title"
        ).execute()
    except Exception as e:
        if "403" in str(e) or "does not have permission" in str(e):
            sys.exit(
                "✗ Google не пускает в таблицу «Выручка Невский 2026».\n"
                "  Откройте её роботу ОДИН раз, права «Просмотр»:\n"
                "      robot-otchyoty@nevskiy-reports.iam.gserviceaccount.com\n"
                "  До этого наличные расходы будут считаться по старой копии."
            )
        raise

    листы = [s["properties"]["title"] for s in мета["sheets"]]
    print(f"таблица: {мета['properties']['title']}, листов {len(листы)}")

    куски = []
    ответ = api.spreadsheets().values().batchGet(
        spreadsheetId=ТАБЛИЦА,
        ranges=[f"'{имя}'" for имя in листы],
        valueRenderOption="FORMATTED_VALUE",
    ).execute()
    for имя, диапазон in zip(листы, ответ.get("valueRanges", [])):
        строки = диапазон.get("values") or []
        куски.append(f"## {имя}")
        ширина = max((len(r) for r in строки), default=0)
        for r in строки:
            r = list(r) + [""] * (ширина - len(r))
            куски.append("| " + " | ".join(str(c) for c in r) + " |")
        print(f"  {имя:22} строк {len(строки)}")

    текст = "\n".join(куски)
    if len(текст) < МИНИМУМ_ЗНАКОВ:
        sys.exit(
            f"✗ Ответ подозрительно мал: {len(текст):,} знаков (ждём хотя бы "
            f"{МИНИМУМ_ЗНАКОВ:,}).\n  Прежний файл ОСТАВЛЕН как есть — "
            "затирать рабочую копию пустышкой нельзя."
        )

    КУДА.write_text(json.dumps({"fileContent": текст}, ensure_ascii=False),
                    encoding="utf-8")
    print(f"\nЗаписано: {КУДА.relative_to(ROOT)} — {len(текст):,} знаков")


if __name__ == "__main__":
    главное()
