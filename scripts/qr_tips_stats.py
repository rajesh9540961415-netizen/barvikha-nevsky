#!/usr/bin/env python3
"""Чеки с чаевыми и без — по официантам и по столам.

Сводит два источника:
  • чеки из отчёта Quick Resto «Продажи» (кто, какой стол, сколько, когда);
  • записи о чаевых из базы приложения.

Склейка идёт по номеру сотрудника: в отчёте `waiter.id` — те же номера,
что и в справочнике приложения, поэтому сопоставлять написание имён
не нужно.

Чаевые привязываются к чеку так: запись по столу T официанта W относится
к его ближайшему чеку на этом столе, закрытому не позже. Администратор
вносит чаевые в момент расчёта, поэтому «ближайший назад» — верное правило.

Читает боевую базу ТОЛЬКО на чтение. Ничего не пишет.

Запуск:  python3 scripts/qr_tips_stats.py [дней_назад]
"""

import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qr_report import fetch, read_env  # noqa: E402

REPORT_ID = 824
MODULE = "sales"
MSK = timezone(timedelta(hours=3))


def business_day(moment: datetime) -> str:
    """Ключ смены с границей 11:00 — как в приложении и в Quick Resto."""
    local = moment.astimezone(MSK)
    if local.hour < 11:
        local -= timedelta(days=1)
    return local.strftime("%Y-%m-%d")


def load_checks(days: int):
    cfg = read_env()
    till = datetime.now()
    since = till - timedelta(days=days)
    code, rows = fetch(cfg, MODULE, REPORT_ID, since, till)
    if code != 200 or not isinstance(rows, list):
        sys.exit(f"Отчёт не отдался: {code} {rows}")

    checks = []
    for r in rows:
        created = r.get("createDate")
        if not created:
            continue
        moment = datetime.fromisoformat(created.replace("Z", "+00:00"))
        # Смену берём из отчёта, а не вычисляем сами: Quick Resto знает свою
        # границу бизнес-дня точно, а самодельный расчёт по времени чека
        # расходился с приложением на пограничных сменах.
        raw_day = r.get("businessDate")
        day = (
            datetime.fromisoformat(raw_day.replace("Z", "+00:00"))
            .astimezone(MSK)
            .strftime("%Y-%m-%d")
            if raw_day
            else business_day(moment)
        )
        waiter = r.get("waiter") or {}
        table = r.get("table") or {}
        checks.append(
            {
                "id": r.get("orderId"),
                "at": moment,
                "day": day,
                "waiter_id": waiter.get("id"),
                "waiter": waiter.get("title") or "—",
                "table_id": table.get("id"),
                "table": table.get("title") or "—",
                "hall": (r.get("hall") or {}).get("title") or "—",
                "sum": float(r.get("salesSum") or 0),
            }
        )
    return checks


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    dump = sys.argv[2] if len(sys.argv) > 2 else None
    checks = load_checks(days)
    if not checks:
        sys.exit("Чеков за период нет.")

    days_seen = sorted({c["day"] for c in checks})
    print(f"Чеков за период: {len(checks)}")
    print(f"Смены: {days_seen[0]} — {days_seen[-1]}\n")

    # Драйвера PostgreSQL в Python нет, а ставить его ради одной склейки
    # незачем: выкладываем чеки файлом, дальше их подхватывает Node,
    # где драйвер уже стоит для самого приложения.
    if dump:
        import json

        Path(dump).write_text(
            json.dumps(
                [{**c, "at": c["at"].isoformat()} for c in checks],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        print(f"чеки выложены в {dump}\n")

    # Что даёт сам отчёт, без базы приложения.
    by_waiter = defaultdict(lambda: {"checks": 0, "sum": 0.0, "guests": 0})
    by_table = defaultdict(lambda: {"checks": 0, "sum": 0.0})
    for c in checks:
        w = by_waiter[c["waiter"]]
        w["checks"] += 1
        w["sum"] += c["sum"]
        t = by_table[f'{c["hall"]} · {c["table"]}']
        t["checks"] += 1
        t["sum"] += c["sum"]

    print(f"{'официант':<24} {'чеков':>7} {'выручка':>14} {'ср. чек':>12}")
    print("-" * 60)
    for name, v in sorted(by_waiter.items(), key=lambda kv: -kv[1]["sum"]):
        avg = v["sum"] / v["checks"] if v["checks"] else 0
        print(f"{name:<24} {v['checks']:>7} {v['sum']:>12,.0f} ₽ {avg:>10,.0f} ₽")

    print(f"\n{'стол':<24} {'чеков':>7} {'выручка':>14}")
    print("-" * 48)
    top = sorted(by_table.items(), key=lambda kv: -kv[1]["sum"])[:12]
    for name, v in top:
        print(f"{name:<24} {v['checks']:>7} {v['sum']:>12,.0f} ₽")


if __name__ == "__main__":
    main()
