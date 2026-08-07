#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Разбор Google-таблицы «Выручка Невский 2026» (id 1bvnxNodVld0d6lPRgd4QWZtMUCK_Bi2Or7_osoKM5lM).

Исходник обновляется через коннектор Google Диска в data/dds/gsheet_raw.json.
Старое описание:
Разбор Google-таблицы «Выручка Невский 2026» — ежедневный журнал выручки и наличных.

В таблице два формата листов:
  A (январь–май): Дата | день недели | БН | Нал | Виртуалка | Итого | статьи расходов...
  B (июнь–август): (пусто) | Дата | Итого | БН | Нал | статьи расходов...
"""
import json
import re
import csv
from pathlib import Path
from datetime import date

SRC = str(Path(__file__).resolve().parent.parent / "data" / "dds" / "gsheet_raw.json")
OUT = str(Path(__file__).resolve().parent.parent / "data" / "dds")

DATE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{4})$")


def num(s):
    """«р.431 480,00» → 431480.0 ; «\\-р.15 000,00» → -15000.0"""
    if not s:
        return None
    s = s.replace("\\", "").replace("\xa0", "").replace(" ", "")
    s = s.replace("р.", "").replace("₽", "").strip()
    neg = s.startswith("-") or s.startswith("−")
    s = s.lstrip("-−")
    s = s.replace(".", "").replace(",", ".")
    if not re.fullmatch(r"\d*\.?\d*", s) or s in ("", "."):
        return None
    v = float(s)
    return -v if neg else v


def main():
    text = json.load(open(SRC, encoding="utf-8"))["fileContent"]
    rows = [[c.strip() for c in l.strip().strip("|").split("|")]
            for l in text.split("\n") if l.strip().startswith("|")]

    header = None       # актуальная шапка формата B
    daily = []
    for r in rows:
        if any(c == "Дата" for c in r):
            header = r
            continue
        if not r:
            continue

        # формат A: дата в первой колонке
        m = DATE.match(r[0]) if r[0] else None
        if m:
            d = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
            daily.append({"date": d, "fmt": "A",
                          "cashless": num(r[2] if len(r) > 2 else ""),
                          "cash": num(r[3] if len(r) > 3 else ""),
                          "total": num(r[5] if len(r) > 5 else "")})
            continue

        # формат B: дата во второй колонке
        m = DATE.match(r[1]) if len(r) > 1 and r[1] else None
        if m:
            d = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
            daily.append({"date": d, "fmt": "B",
                          "cashless": num(r[3] if len(r) > 3 else ""),
                          "cash": num(r[4] if len(r) > 4 else ""),
                          "total": num(r[2] if len(r) > 2 else "")})

    daily.sort(key=lambda x: x["date"])

    # ── помесячная сводка ────────────────────────────────────────────────
    from collections import defaultdict
    agg = defaultdict(lambda: {"cash": 0.0, "cashless": 0.0, "total": 0.0, "days": 0, "filled": 0})
    for r in daily:
        k = (r["date"].year, r["date"].month)
        a = agg[k]
        a["days"] += 1
        for f in ("cash", "cashless", "total"):
            if r[f]:
                a[f] += r[f]
        if (r["total"] or 0) > 0:
            a["filled"] += 1

    M = lambda v: f"{v:,.0f}".replace(",", " ")
    MR = ["", "январь", "февраль", "март", "апрель", "май", "июнь",
          "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]
    print("GOOGLE-ТАБЛИЦА «ВЫРУЧКА НЕВСКИЙ 2026»")
    print(f"{'месяц':<12}{'безнал':>14}{'наличные':>13}{'итого':>14}{'нал %':>7}"
          f"{'дней':>7}{'заполнено':>11}  формат")
    print("─" * 82)
    for k in sorted(agg):
        a = agg[k]
        tot = a["total"] or (a["cash"] + a["cashless"])
        sh = f"{a['cash']/(a['cash']+a['cashless'])*100:.0f}%" if (a["cash"] + a["cashless"]) else "—"
        fmt = {r["fmt"] for r in daily if (r["date"].year, r["date"].month) == k}
        print(f"{MR[k[1]]+' '+str(k[0]):<12}{M(a['cashless']):>14}{M(a['cash']):>13}"
              f"{M(tot):>14}{sh:>7}{a['days']:>7}{a['filled']:>11}  {'/'.join(sorted(fmt))}")

    with open(f"{OUT}/gsheet_daily.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, ["date", "fmt", "cashless", "cash", "total"])
        w.writeheader()
        w.writerows(daily)
    print(f"\nсохранено {len(daily)} дней → gsheet_daily.csv")


if __name__ == "__main__":
    main()
