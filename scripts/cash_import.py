#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Разбор Google-таблицы «Выручка Невский 2026» — наличная касса по дням.

Таблица (id 1bvnxNodVld0d6lPRgd4QWZtMUCK_Bi2Or7_osoKM5lM) — единственный
источник по расходу наличных: в банковскую выписку они не попадают.
Обновляется через коннектор Google Диска в data/dds/gsheet_raw.json.

Три поколения разметки листов, колонки менялись:
  30 колонок — выручка разбита на ООО МАВ и ИП Шалаеву (с августа 2026)
  26–28      — одна пара БН/Нал
  18         — упрощённый шаблон на будущие месяцы, пока пустой
Поэтому колонки читаем по названиям, а не по номерам.

Месяц листа определяем не по подписи даты (там встречается «01.07» на
августовской странице), а сверкой дневной выручки с выгрузкой из кассы.

Запуск:  python3 scripts/cash_import.py
Результат: data/dds/cash_daily.csv
"""
import csv
import json
import re
from collections import defaultdict
from datetime import date
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "dds"
SRC = DATA / "gsheet_raw.json"
M = lambda v: f"{v:,.0f}".replace(",", " ")
MR = ["", "январь", "февраль", "март", "апрель", "май", "июнь",
      "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]

# Служебные колонки: это не расход, а движение денег и остатки.
NOT_EXPENSE = {"Инкассация", "Инкасация", "Приход", "Нал остаток", "Нал. ост",
               "Наличка накопительная", "Забрал из конверта ИТОГО",
               "Дата", "БН", "Нал", "Виртуалка", "Итого"}


def load_catmap():
    """Перевод статей таблицы в статьи ДДС."""
    f = DATA / "cash_categories.json"
    if not f.exists():
        return {}
    return json.loads(f.read_text(encoding="utf-8")).get("map", {})


CATMAP = None


def num(s):
    if not s:
        return None
    s = s.replace("\\", "").replace("\xa0", "").replace(" ", "")
    s = s.replace("р.", "").replace("₽", "")
    neg = s.startswith("-") or s.startswith("−")
    s = s.lstrip("-−").replace(".", "").replace(",", ".")
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def clean(c):
    return re.sub(r"\\?\[merged\\?\]", "", c).strip()


def qr_daily():
    """Выручка по дням из кассы — эталон для определения месяца листа."""
    day = defaultdict(float)
    for f in DATA.glob("qr_sales_*.csv"):
        for r in csv.DictReader(f.open(encoding="utf-8")):
            y, m, d = map(int, r["date"].split("-"))
            day[date(y, m, d)] += float(r["cash"]) + float(r["cashless"])
    return day


def resolve_month(totals, ref):
    """Подбираем месяц: у какого совпадают дневные суммы выручки."""
    best, best_hits = None, 0
    for y in (2025, 2026):
        for m in range(1, 13):
            hits = 0
            for dnum, val in totals.items():
                try:
                    d = date(y, m, dnum)
                except ValueError:
                    continue
                if abs(ref.get(d, -1) - val) < 2:
                    hits += 1
            if hits > best_hits:
                best, best_hits = (y, m), hits
    return best, best_hits


def main():
    if not SRC.exists():
        raise SystemExit(f"Нет {SRC}. Скачайте таблицу через коннектор Google Диска.")
    global CATMAP
    CATMAP = load_catmap()
    text = json.load(SRC.open(encoding="utf-8"))["fileContent"]
    rows = [[clean(c) for c in l.strip().strip("|").split("|")]
            for l in text.split("\n") if l.strip().startswith("|")]

    hdr = [i for i, r in enumerate(rows) if "Дата" in r and any(c in ("БН", "Нал") for c in r)]
    ref = qr_daily()
    out, report = [], []

    for n, hi in enumerate(hdr):
        end = hdr[n + 1] if n + 1 < len(hdr) else len(rows)
        head = rows[hi]
        col, seen = {}, set()
        for j, c in enumerate(head):
            if c and c not in seen:      # при повторе (БН/Нал дважды) берём первый
                col[c] = j
                seen.add(c)
        # повторные БН/Нал — это второе юрлицо
        dup = [j for j, c in enumerate(head) if c in ("БН", "Нал") and j > col.get(c, -1)]

        body = rows[hi + 1:end]
        totals, day_rows = {}, []
        for r in body:
            dnum = None
            for j in (0, 1):
                if len(r) > j and re.fullmatch(r"\d{2}\.\d{2}(\.\d{4})?", r[j] or ""):
                    dnum = int(r[j][:2]); break
            if dnum is None:
                continue
            tot = num(r[col["Итого"]]) if "Итого" in col and len(r) > col["Итого"] else None
            if tot:
                totals[dnum] = tot
            day_rows.append((dnum, r))

        if not day_rows:
            continue
        (ym, hits) = resolve_month(totals, ref) if totals else (None, 0)
        label = f"{MR[ym[1]]} {ym[0]}" if ym else "не определён"

        filled = 0
        for dnum, r in day_rows:
            if not ym:
                continue
            try:
                d = date(ym[0], ym[1], dnum)
            except ValueError:
                continue
            rec = {"date": d, "cash_in": 0.0, "collection": 0.0,
                   "net": None, "balance": None, "expenses": 0.0}
            for name, j in col.items():
                if len(r) <= j:
                    continue
                v = num(r[j])
                if v is None:
                    continue
                if name == "Нал":
                    rec["cash_in"] += v
                elif name in ("Инкассация", "Инкасация"):
                    rec["collection"] += v
                elif name == "Приход":
                    rec["net"] = v
                elif name in ("Нал остаток", "Нал. ост"):
                    # ЛОВУШКА: колонка названа «остаток», но хранит изменение
                    # за день. Накопленный остаток — в «Наличка накопительная».
                    rec["net"] = v if rec["net"] is None else rec["net"]
                elif name == "Наличка накопительная":
                    rec["balance"] = v
                elif name not in NOT_EXPENSE:
                    rec["expenses"] += v
                    out.append({"date": d, "column": name,
                                "category": CATMAP.get(name, "Прочие расходы"),
                                "amount": round(v, 2)})
            for j in dup:                       # наличные второго юрлица
                if len(r) > j and head[j] == "Нал":
                    v = num(r[j])
                    if v:
                        rec["cash_in"] += v
            # пустая строка будущего дня — в учёт не берём
            if not (rec["cash_in"] or rec["expenses"] or rec["collection"]
                    or rec["balance"]):
                continue
            filled += 1
            report.append((d, rec))
        report_line = (label, len(day_rows), filled, hits, len(col))
        print(f"{label:<16} строк {len(day_rows):>3}  с данными {filled:>3}  "
              f"совпало с кассой {hits:>3} дн.  колонок {len(col)}")

    out.sort(key=lambda r: (r["date"], r["category"]))
    with (DATA / "cash_expenses.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, ["date", "column", "category", "amount"])
        w.writeheader(); w.writerows(out)

    daily = {}
    for d, rec in report:
        daily[d] = rec
    with (DATA / "cash_daily.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, ["date", "cash_in", "expenses", "collection", "net", "balance"])
        w.writeheader()
        for d in sorted(daily):
            r = daily[d]
            w.writerow({"date": d, "cash_in": round(r["cash_in"], 2),
                        "expenses": round(r["expenses"], 2),
                        "collection": round(r["collection"], 2),
                        "net": r["net"], "balance": r["balance"]})

    print(f"\nзаписано: {len(out)} строк расходов, {len(daily)} дней")
    if daily:
        last = max(daily)
        print(f"последний день: {last:%d.%m.%Y}   остаток наличных: "
              f"{M(daily[last]['balance']) if daily[last]['balance'] is not None else '—'} ₽")


if __name__ == "__main__":
    main()
