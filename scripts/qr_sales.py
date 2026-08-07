#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Выручка по дням из Quick Resto — через кассовые смены.

Раздел чеков (front.orders) в API закрыт и отдаёт пустой список, но кассовая
смена (front.zreport.Shift) отдаёт всё нужное готовыми полями: наличные,
безнал, количество чеков. Смена открывается вечером и закрывается ночью, так
что день считается по дате ОТКРЫТИЯ — как в ручной таблице.

Запуск:
    python3 scripts/qr_sales.py                 # все смены, свод по месяцам
    python3 scripts/qr_sales.py 2026-04         # один месяц по дням
    python3 scripts/qr_sales.py 2026-04 2026-07 # диапазон месяцев

Доступы берёт из .env: QR_URL / QR_LOGIN / QR_PASSWORD.
Результат: data/dds/qr_sales.csv
"""
import base64
import csv
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "dds"
MODULE = "front.zreport"
CLASS = "ru.edgex.quickresto.modules.front.zreport.Shift"


# Касс в заведении несколько: у каждого юрлица своё облако Quick Resto.
CLOUDS = {
    "mav": ("QR_MAV", "ООО «МАВ»"),
    "shalaeva": ("QR_SHALAEVA", "ИП Шалаева"),
}


def read_env(cloud="mav"):
    cfg = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip()
    prefix, title = CLOUDS[cloud]
    out = {}
    for suffix in ("URL", "LOGIN", "PASSWORD"):
        # свой ключ юрлица, иначе — общий QR_* (так было до появления второй кассы)
        val = cfg.get(f"{prefix}_{suffix}") or cfg.get(f"QR_{suffix}")
        if not val:
            raise SystemExit(f"В .env не заполнено: {prefix}_{suffix}")
        out["QR_" + suffix] = val
    out["_title"] = title
    return out


def fetch_shifts(cfg, limit=5000):
    token = base64.b64encode(f"{cfg['QR_LOGIN']}:{cfg['QR_PASSWORD']}".encode()).decode()
    q = urllib.parse.urlencode({"moduleName": MODULE, "className": CLASS})
    url = cfg["QR_URL"].rstrip("/") + "/platform/online/api/list?" + q
    req = urllib.request.Request(
        url, data=json.dumps({"limit": limit, "offset": 0}).encode(),
        headers={"Authorization": "Basic " + token,
                 "Content-Type": "application/json", "Connection": "keep-alive"},
        method="POST")
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())


def business_day(shift):
    """Дата открытия смены по местному времени."""
    s = shift.get("localOpenedTime") or shift.get("opened")
    if not s:
        return None
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    cloud = next((a[2:] for a in sys.argv[1:] if a.startswith("--")), "mav")
    if cloud not in CLOUDS:
        raise SystemExit(f"Неизвестная касса: {cloud}. Доступны: {', '.join(CLOUDS)}")
    cfg = read_env(cloud)
    print(f"касса: {cfg['_title']} ({cfg['QR_URL']})")
    shifts = fetch_shifts(cfg)
    rows = []
    for s in shifts:
        d = business_day(s)
        if not d or s.get("status") != "CLOSED":
            continue
        cash = (s.get("totalCash") or 0) - (s.get("totalReturnCash") or 0)
        card = (s.get("totalCard") or 0) - (s.get("totalReturnCard") or 0)
        rows.append({"date": d, "shift": s.get("shiftNumber"),
                     "cash": round(cash, 2), "cashless": round(card, 2),
                     "bonuses": round(s.get("totalBonuses") or 0, 2),
                     "checks": s.get("ordersCount") or 0,
                     "returns": s.get("returnOrdersCount") or 0})
    rows.sort(key=lambda r: (r["date"], r["shift"] or 0))

    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / f"qr_sales_{cloud}.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, ["date", "shift", "cash", "cashless", "bonuses", "checks", "returns"])
        w.writeheader(); w.writerows(rows)

    M = lambda v: f"{v:,.0f}".replace(",", " ")
    if args:
        lo, hi = args[0], args[-1]
        sel = [r for r in rows if lo <= r["date"].strftime("%Y-%m") <= hi]
        print(f"{'дата':<12}{'безнал':>13}{'наличные':>12}{'итого':>13}{'чеков':>8}")
        print("─" * 58)
        day = defaultdict(lambda: [0.0, 0.0, 0])
        for r in sel:
            a = day[r["date"]]
            a[0] += r["cashless"]; a[1] += r["cash"]; a[2] += r["checks"]
        for d in sorted(day):
            c, n, k = day[d]
            print(f"{d.strftime('%d.%m.%Y'):<12}{M(c):>13}{M(n):>12}{M(c+n):>13}{k:>8}")
        print("─" * 58)
        tc = sum(v[0] for v in day.values()); tn = sum(v[1] for v in day.values())
        print(f"{'ИТОГО':<12}{M(tc):>13}{M(tn):>12}{M(tc+tn):>13}"
              f"{sum(v[2] for v in day.values()):>8}")
        return

    mon = defaultdict(lambda: [0.0, 0.0, 0, 0])
    for r in rows:
        a = mon[(r["date"].year, r["date"].month)]
        a[0] += r["cashless"]; a[1] += r["cash"]; a[2] += r["checks"]; a[3] += 1
    print(f"смен получено: {len(rows)}   период: {rows[0]['date']} … {rows[-1]['date']}\n")
    print(f"{'месяц':<10}{'безнал':>14}{'наличные':>13}{'итого':>14}{'нал %':>7}{'чеков':>8}{'смен':>6}")
    print("─" * 72)
    for k in sorted(mon):
        c, n, ch, sh = mon[k]
        share = f"{n/(c+n)*100:.0f}%" if (c + n) else "—"
        print(f"{k[1]:02d}.{k[0]:<7}{M(c):>14}{M(n):>13}{M(c+n):>14}{share:>7}{ch:>8}{sh:>6}")


if __name__ == "__main__":
    main()
