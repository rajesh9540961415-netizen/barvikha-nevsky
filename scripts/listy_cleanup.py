#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Удаляет старые фото листов смен — правило «месяц плюс месяц».

🔴 **Правило владельца 22.10.2026:** листы месяца удаляются 5-го числа
через месяц после его закрытия. Сентябрь закрыт → сентябрьские листы
удаляются 5 ноября. Значит лист месяца M живёт до 5-го числа месяца M+2.

Запускает cron на VPS 5-го числа в 12:00 МСК (09:00 UTC), журнал —
`~/logs/listy-cleanup.log`. Срок считается от даты в имени файла, а не от
дня запуска, поэтому пропущенный запуск ничего не теряет: следующий удалит
всё, чему вышел срок. Заведено 23.10.2026 по «да» владельца.

⚠️ **Удаляет насовсем.** В git листов нет (и в истории тоже, с 23.10),
других копий на VPS нет — оригиналы только в группе «ЧАЕВЫЕ ОФ».

Запуск:
    python3 scripts/listy_cleanup.py                       # удалить, чему вышел срок
    python3 scripts/listy_cleanup.py --что-там             # только показать
    python3 scripts/listy_cleanup.py --что-там --на 2026-11-05  # как будет в этот день
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ПАПКА = ROOT / "data" / "листы-смен"
ИМЯ = re.compile(r"^лист-(\d{4})-(\d{2})-\d{2}")
ДЕНЬ_ОЧИСТКИ = 5


def срок(год: int, месяц: int) -> dt.date:
    """5-е число через месяц после закрытия: для сентября — 5 ноября."""
    m = месяц + 2
    return dt.date(год + (m - 1) // 12, (m - 1) % 12 + 1, ДЕНЬ_ОЧИСТКИ)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--что-там", dest="показать", action="store_true",
                   help="только показать, ничего не удалять")
    p.add_argument("--на", dest="на", type=dt.date.fromisoformat,
                   help="считать, будто сегодня этот день (ГГГГ-ММ-ДД)")
    a = p.parse_args()
    сегодня = a.на or dt.date.today()

    к_удалению: list[Path] = []
    осталось = 0
    for f in sorted(ПАПКА.iterdir()):
        m = ИМЯ.match(f.name)
        if not f.is_file() or not m:
            continue
        if сегодня >= срок(int(m[1]), int(m[2])):
            к_удалению.append(f)
        else:
            осталось += 1

    print(f"=== {dt.datetime.now(dt.timezone.utc):%Y-%m-%d %H:%M UTC} листы смен, "
          f"на {сегодня}: срок вышел у {len(к_удалению)}, остаётся {осталось}")
    for f in к_удалению:
        if a.показать:
            print(f"  удалил бы {f.name}")
        else:
            f.unlink()
            print(f"  удалён {f.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
