#!/usr/bin/env python3
"""Проверка связи с Quick Resto и разведка полей чека.

Читает доступы из .env, запрашивает чеки за последние дни
и показывает, что реально приходит в ответе.

Пароль нигде не печатается.

Запуск:  python3 scripts/qr_check.py [сколько_дней_назад]
"""

import base64
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"

# Базовый путь API — именно /platform/online, а не корень сайта.
API_PREFIX = "/platform/online"
ORDER_CLASS = "ru.edgex.quickresto.modules.front.orders.OrderInfo"


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
    for key in ("QR_URL", "QR_LOGIN", "QR_PASSWORD"):
        if not cfg.get(key) or cfg[key] == "ЗАМЕНИТЕ_МЕНЯ":
            sys.exit(f"В .env не заполнено: {key}")
    return cfg


def api_get(cfg, path):
    token = base64.b64encode(
        f"{cfg['QR_LOGIN']}:{cfg['QR_PASSWORD']}".encode()
    ).decode()
    req = urllib.request.Request(
        cfg["QR_URL"].rstrip("/") + API_PREFIX + path,
        headers={
            "Authorization": "Basic " + token,
            "Content-Type": "application/json",
            "Connection": "keep-alive",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def orders_for_period(cfg, days_back):
    """Чеки за последние N дней."""
    till = datetime.now()
    since = till - timedelta(days=days_back)
    filters = [
        {
            "field": "localCreateDate",
            "operation": "range",
            "value": {
                "since": str(int(since.timestamp() * 1000)),
                "till": str(int(till.timestamp() * 1000)),
            },
        }
    ]
    query = urllib.parse.urlencode(
        {
            "moduleName": "front.orders",
            "className": ORDER_CLASS,
            "filters": json.dumps(filters, ensure_ascii=False),
        }
    )
    return api_get(cfg, f"/api/list?{query}")


def money(value):
    try:
        return f"{float(value):,.2f}".replace(",", " ")
    except (TypeError, ValueError):
        return "—"


def main():
    days_back = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    cfg = read_env()
    print(f"Сервер: {cfg['QR_URL']}{API_PREFIX}")
    print(f"Логин:  {cfg['QR_LOGIN']}")
    print(f"Период: последние {days_back} дн.\n")

    try:
        orders = orders_for_period(cfg, days_back)
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")[:400]
        sys.exit(f"Ошибка {err.code}: {err.reason}\n{body}")
    except urllib.error.URLError as err:
        sys.exit(f"Не достучались до сервера: {err.reason}")

    if not isinstance(orders, list):
        print(json.dumps(orders, ensure_ascii=False, indent=2)[:2000])
        return

    print(f"Получено чеков: {len(orders)}\n")
    if not orders:
        return

    for order in orders[:6]:
        table = (order.get("table") or {}).get("title")
        waiter = (order.get("waiter") or {}).get("fullName")
        print(f"  чек №{order.get('documentNumber')}  {order.get('localCreateDate')}")
        print(f"    стол:     {table or '— пусто —'}")
        print(f"    официант: {waiter or '— пусто —'}")
        print(f"    итого:    {money(order.get('frontTotalPrice'))} ₽")
        print(f"    наличные: {money(order.get('frontTotalCashMinusDiscount'))} ₽")
        print(f"    карта:    {money(order.get('frontTotalCard'))} ₽")
        print(f"    смена:    {order.get('shiftId') or '— пусто —'}")
        print()

    keys = sorted(orders[0].keys())
    print("--- Все поля чека ---")
    print(", ".join(keys))

    tips = [k for k in keys if "tip" in k.lower() or "чаев" in k.lower()]
    print(f"\n--- Поля, похожие на чаевые: {tips or 'не найдено'}")

    payments = orders[0].get("payments")
    if payments:
        print("\n--- Поля внутри payments[0] ---")
        print(", ".join(sorted(payments[0].keys())))


if __name__ == "__main__":
    main()
