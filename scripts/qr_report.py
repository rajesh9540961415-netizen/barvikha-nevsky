#!/usr/bin/env python3
"""Чтение отчёта из Генератора отчётов Quick Resto.

Обходной путь вместо закрытого `front.orders` — подсказан техподдержкой
Quick Resto 03.08.2026. Смысл: в бэк-офисе создаётся отчёт с нужными
колонками, а API отдаёт его содержимое за любой период.

Запрос — GET **с телом**, это их формат:

    GET /platform/online/api/list?moduleName=report.datasources.<источник>&ownerContextId=<id отчёта>
    тело: {"mode": "dateFilter", "extParams": {"dateFrom": [мс], "dateTo": [мс]}}

Имя источника данных заранее неизвестно: поддержка привела пример
`product_movement` для «Расхода продуктов», а нам нужны «Продажи».
Поэтому если имя не задано, скрипт перебирает правдоподобные варианты
и говорит, какой ответил.

Запуск:
    python3 scripts/qr_report.py --report 1
    python3 scripts/qr_report.py --report 1 --module sales --days 7
"""

import argparse
import base64
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
PREFIX = "/platform/online"

# Имя источника данных «Продажи» в API нигде не названо. Перебираем
# правдоподобные: лишний запрос стоит доли секунды, а угадывать руками долго.
CANDIDATES = [
    "sales",
    "sale",
    "product_sales",
    "order_sales",
    "orders",
    "revenue",
    "checks",
    "receipts",
    "front_orders",
    "product_movement",
]


def read_env():
    if not ENV.exists():
        sys.exit("Нет файла .env рядом с проектом.")
    cfg = {}
    for line in ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            cfg[key.strip()] = value.strip()
    for key in ("QR_URL", "QR_LOGIN", "QR_PASSWORD"):
        if not cfg.get(key):
            sys.exit(f"В .env не заполнено: {key}")
    return cfg


def fetch(cfg, module, report_id, since, till):
    """Один запрос к отчёту. Возвращает (код, данные или текст ошибки)."""
    url = (
        cfg["QR_URL"].rstrip("/")
        + PREFIX
        + f"/api/list?moduleName=report.datasources.{module}"
        + f"&ownerContextId={report_id}"
    )
    body = json.dumps(
        {
            "mode": "dateFilter",
            "extParams": {
                "dateFrom": [int(since.timestamp() * 1000)],
                "dateTo": [int(till.timestamp() * 1000)],
            },
        }
    ).encode("utf-8")
    token = base64.b64encode(
        f"{cfg['QR_LOGIN']}:{cfg['QR_PASSWORD']}".encode()
    ).decode()
    # GET с телом — так написано в ответе поддержки. urllib сам бы поставил
    # POST при наличии data, поэтому метод задаём явно.
    req = urllib.request.Request(
        url,
        data=body,
        method="GET",
        headers={
            "Authorization": "Basic " + token,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--report", required=True, help="ID отчёта из адресной строки")
    p.add_argument("--module", help="имя источника данных, если известно")
    p.add_argument("--days", type=int, default=3, help="за сколько последних дней")
    args = p.parse_args()

    cfg = read_env()
    till = datetime.now()
    since = till - timedelta(days=args.days)
    print(f"Отчёт {args.report}, период {since:%d.%m} — {till:%d.%m}\n")

    modules = [args.module] if args.module else CANDIDATES
    for module in modules:
        code, data = fetch(cfg, module, args.report, since, till)
        if code == 200 and isinstance(data, list):
            print(f"✓ источник данных: report.datasources.{module}")
            print(f"  строк за период: {len(data)}\n")
            if not data:
                print("  Пусто. Проверьте период и фильтры отчёта.")
                return
            print("  колонки:")
            for k in data[0]:
                print(f"    {k}")
            print("\n  первые строки:")
            for row in data[:3]:
                print("   ", json.dumps(row, ensure_ascii=False)[:200])
            return
        mark = "✗" if code else "!"
        print(f"  {mark} {module:<18} {code if code else data}")

    print(
        "\nНи один источник не ответил. Имя видно в адресной строке бэк-офиса,\n"
        "когда открыт сгенерированный отчёт — пришлите его целиком."
    )


if __name__ == "__main__":
    main()
