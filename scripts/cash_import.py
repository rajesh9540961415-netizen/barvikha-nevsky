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
# ⚠️ Имена колонок в таблице меняются от разметки к разметке, и служебная
# колонка под новым именем молча становится статьёй расхода. 19.08.2026 так
# и вышло: «Нал остаток» в августовской разметке назвали «Остаток в кассе»,
# и остаток наличных поехал в учёт расходом — 12 094 165 ₽ за восемнадцать
# дней. Рядом обнаружилась «Изменения за день» — дневная разница остатка,
# от неё же в расходах брались отрицательные суммы.
#
# Признак служебной колонки простой: это НЕ ТРАТА, а состояние кассы или
# движение денег внутри неё. Появится новое имя — дописать сюда, а увидеть
# его можно так: python3 scripts/cash_import.py и посмотреть, не вылезла ли
# в расходах статья размером с выручку.
NOT_EXPENSE = {"Инкассация", "Инкасация", "Приход", "Нал остаток", "Нал. ост",
               "Остаток в кассе", "Изменения за день",
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
                                # Умолчание «Прочие расходы» — не заглушка,
                                # а решение владельца 19.08.2026: наличные
                                # расходы на ИП Борзову идут в прочее. Оно же
                                # прописано явными строками в разметке — на
                                # случай, если умолчание когда-нибудь поменяют.
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

    # ── Отсечка будущих дней ──────────────────────────────────────────────
    #
    # 19.08.2026: в таблице формула расхода протянута вперёд по пустым
    # строкам, и после 18 августа стояло двенадцать одинаковых дней
    # по 518 613 ₽ — 6 223 356 ₽ расходов, которых не было. Проверка выше
    # их пропускает: она ищет строку, пустую ЦЕЛИКОМ, а у этих заполнен
    # расход.
    #
    # ⚠️ Признак настоящего дня — ПРИХОД. Заведение принимает наличные
    # каждый вечер, который работает; день с нулевым приходом и ненулевым
    # расходом — это не день, а протянутая формула. Отсекаем по последнему
    # дню с приходом, отдельно в каждом месяце: месяцы вперёд лежат в той же
    # таблице пустыми шаблонами.
    #
    # Кричим вслух, а не отсекаем молча: если формулу протянут по-другому,
    # молчаливая отсечка съест настоящие дни и никто не заметит.
    последний_с_приходом = {}
    for d, rec in report:
        if rec["cash_in"]:
            м = (d.year, d.month)
            последний_с_приходом[м] = max(последний_с_приходом.get(м, d), d)

    отсечено = [(d, rec) for d, rec in report
                if (d.year, d.month) in последний_с_приходом
                and d > последний_с_приходом[(d.year, d.month)]]
    if отсечено:
        сумма = sum(r["expenses"] for _, r in отсечено)
        дни_текстом = ", ".join(f"{d:%d.%m}" for d, _ in отсечено[:4])
        ещё = f" и ещё {len(отсечено) - 4}" if len(отсечено) > 4 else ""
        print(f"\n⚠️  Отсечены дни без прихода: {дни_текстом}{ещё} — "
              f"{M(сумма)} ₽ расхода.")
        print("    Это протянутая вперёд формула в таблице, а не расходы.")
    брак = {d for d, _ in отсечено}
    report = [(d, rec) for d, rec in report if d not in брак]
    # В `out` дата лежит тем же типом, что и в `report`, — сравниваем как есть.
    out = [r for r in out if r["date"] not in брак]

    out.sort(key=lambda r: (r["date"], r["category"]))
    with (DATA / "cash_expenses.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, ["date", "column", "category", "amount"])
        w.writeheader(); w.writerows(out)

    # ── Пустой повтор дня не затирает заполненный ─────────────────────────
    #
    # ⚠️ 21.08.2026: 1–3 февраля стояли нулями, хотя в таблице владельца всё
    # заполнено. Внизу февральской страницы лежат три ПУСТЫЕ строки,
    # подписанные «01.03», «02.03», «03.03» — первые дни марта. Разбор берёт
    # из подписи только ЧИСЛО, а месяц определяет по всей странице, — и эти
    # три строки во второй раз стали первым, вторым и третьим февраля.
    # Записывался последний, то есть пустой: 252 974 ₽ прихода и миллион
    # инкассации 3 февраля пропали из учёта, а в остатке образовался разрыв.
    #
    # 💡 Верить подписи нельзя — ради этого месяц и определяется сверкой
    # с кассой: на августовской странице встречается подпись «01.07».
    # Но и «чужой день на странице» бывает, и различить эти два случая можно
    # просто: у настоящего дня есть деньги, у затесавшегося — нет.
    #
    # Кричим вслух: молчаливое склеивание однажды съест настоящий день,
    # и никто не заметит.
    daily = {}
    затёрто = []
    for d, rec in report:
        прежняя = daily.get(d)
        if прежняя is not None:
            было = прежняя["cash_in"] or прежняя["expenses"] or прежняя["collection"]
            стало = rec["cash_in"] or rec["expenses"] or rec["collection"]
            if было and not стало:
                затёрто.append(d)
                continue
        daily[d] = rec
    if затёрто:
        дни = ", ".join(f"{d:%d.%m.%Y}" for d in затёрто[:6])
        ещё = f" и ещё {len(затёрто) - 6}" if len(затёрто) > 6 else ""
        print(f"\n⚠️  Пустые повторы дня не затёрли заполненный: {дни}{ещё}.")
        print("    Ищите на странице лишние строки соседнего месяца.")
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
