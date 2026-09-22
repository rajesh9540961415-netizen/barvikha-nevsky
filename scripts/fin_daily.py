#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Финансовое состояние на текущий момент — ежедневная сводка.

Собирает в одну картинку:
  • выручку за вчера и с начала месяца (обе кассы Quick Resto);
  • расходы с начала месяца (банковские выписки);
  • остатки на счетах и резерв под налоги;
  • ближайшие крупные платежи по историческому календарю.

Запуск:  python3 scripts/fin_daily.py [--no-quickresto]

Выручка тянется из кассы онлайн. Расходы берутся из последней разобранной
выписки — она обновляется скриптом bank_import.py, когда приходит новая.
"""
import csv
import subprocess
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "dds"
M = lambda v: f"{v:,.0f}".replace(",", " ")


def refresh_quickresto():
    """Обновляет выгрузки обеих касс. Молча пропускает недоступную."""
    import os
    # при запуске из-под планировщика локаль может быть не UTF-8,
    # и печать кириллицы в пайп роняет дочерний процесс
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    for cloud in ("mav", "shalaeva"):
        try:
            # ⚠️ 45 минут, а не 10. Внутри qr_sales.py докачка истории
            # рассчитана на срок в 45 минут и сама следит за ним. Пока здесь
            # стояло 600 секунд, мы обрывали её на десятой минуте — и так
            # четыре утра подряд, 18–21.09.2026: хранилище смен росло,
            # но до конца не доходило, а пока история не докачана, qr_sales.py
            # намеренно НЕ переписывает qr_sales_mav.csv. Выручка в сводке
            # четыре дня шла по одной кассе из двух — втрое меньше настоящей,
            # и по цифре это было незаметно.
            #
            # 💡 Внешний срок не должен быть короче внутреннего: иначе скрипт
            # не успевает ни доделать работу, ни сказать, что не успел.
            subprocess.run([sys.executable, str(ROOT / "scripts" / "qr_sales.py"), f"--{cloud}"],
                           capture_output=True, timeout=2700, check=True, env=env)
        except Exception as e:
            detail = getattr(e, "stderr", b"") or b""
            print(f"   ⚠️  касса {cloud}: не обновилась ({type(e).__name__}) "
                  f"{detail.decode('utf-8', 'replace').strip()[-200:]}")


def read_sales():
    """Выручка по дням, обе кассы вместе."""
    day = defaultdict(lambda: {"cash": 0.0, "cashless": 0.0, "checks": 0})
    for f in DATA.glob("qr_sales_*.csv"):
        for r in csv.DictReader(f.open(encoding="utf-8")):
            y, m, d = map(int, r["date"].split("-"))
            a = day[date(y, m, d)]
            a["cash"] += float(r["cash"])
            a["cashless"] += float(r["cashless"])
            a["checks"] += int(r["checks"])
    return day


def gaps_report():
    """Какие дни выписки не загружены.

    Ссылка на выписку в письме живёт сутки. Если день пропустили — операции
    за него просто не попадут в учёт, и заметить это по суммам невозможно.
    Поэтому считаем дни явно: в файле формата 1С на каждый день есть своя
    секция с остатком, так что пропуск виден точно.
    """
    import json
    bal = DATA / "bank_balances.csv"
    if not bal.exists():
        return
    reg = json.loads((DATA / "registry.json").read_text(encoding="utf-8"))
    names, молчать = {}, set()
    for e in reg["entities"]:
        for a in e["accounts"]:
            if a["number"]:
                names[a["number"]] = (e["short"], a.get("role") or a["type"])
                # Счёт с неподтверждённым номером: вопрос не к выписке,
                # а к самому номеру.
                if a.get("статус") == "требует подтверждения":
                    молчать.add(a["number"])
                # Закрытый счёт новых дней не добавит никогда, и «хвост»
                # по нему будет расти вечно. Это не пропуск, а конец истории.
                if a.get("закрыт"):
                    молчать.add(a["number"])
                # Выписка, которой владелец сознательно не берёт. Требовать её
                # каждое утро — врать про пропуск там, где решение принято.
                if a.get("выписка_не_нужна"):
                    молчать.add(a["number"])

    days = defaultdict(set)
    for b in csv.DictReader(bal.open(encoding="utf-8")):
        y, m, d = map(int, b["date"].split("-"))
        days[b["account"]].add(date(y, m, d))

    # Счёт, по которому нет ни одного дня, в разбор ниже не попадёт: у него нет
    # ни первого дня, ни последнего, вычитать не из чего. Пустота при этом
    # выглядит как порядок — поэтому такие счета показываем отдельно.
    # Счета из «молчать» сюда не берём: напоминать о них каждое утро нечестно —
    # там либо вопрос не к выписке, либо решение уже принято.
    empty = sorted(acc for acc in names if acc not in days and acc not in молчать)

    # Дыра бывает двух видов: пропущенный день внутри периода и «хвост» —
    # когда выписку давно не выгружали и данных после какой-то даты просто нет.
    # Второе опаснее: расходы за неделю могут молча отсутствовать.
    yesterday = date.today() - timedelta(days=1)
    problems, tails = [], []
    for acc, ds in days.items():
        if acc in молчать:
            continue
        lo, hi = min(ds), max(ds)
        missing = sorted({lo + timedelta(n) for n in range((hi - lo).days + 1)} - ds)
        if missing:
            problems.append((acc, missing, hi))
        if hi < yesterday:
            tails.append((acc, hi, (yesterday - hi).days))

    if not problems and not tails and not empty:
        print("\nПРОПУСКИ В ВЫПИСКАХ\n   нет, все дни загружены")
        return

    print("\nПРОПУСКИ В ВЫПИСКАХ")
    for acc in empty:
        short, typ = names[acc]
        print(f"   {short} · {typ}: выписки НЕТ СОВСЕМ — ни одного дня. Счёт {acc}")
    for acc, hi, n in sorted(tails, key=lambda x: -x[2]):
        short, typ = names.get(acc, ("?", "?"))
        nxt = hi + timedelta(days=1)
        print(f"   {short} · {typ}: нет данных после {hi:%d.%m} — "
              f"не хватает {n} дн. ({nxt:%d.%m}–{yesterday:%d.%m})")
    for acc, missing, hi in problems:
        short, typ = names.get(acc, ("?", "?"))
        rng, start = [], missing[0]
        prev = start
        for d in missing[1:]:
            if (d - prev).days == 1:
                prev = d
                continue
            rng.append((start, prev)); start = prev = d
        rng.append((start, prev))
        txt = ", ".join(f"{a:%d.%m}" if a == b else f"{a:%d.%m}–{b:%d.%m}" for a, b in rng)
        print(f"   {short} · {typ}: не хватает {len(missing)} дн. — {txt}")
    print("   → выгрузите в СберБизнес выписку за недостающий период "
          "(Счета и выписки → Экспорт выписки, формат 1С)")
    print("   → положите файл в data/dds/выписки/ — повторы отсеются сами, "
          "можно брать период с запасом")


def main():
    if "--no-quickresto" not in sys.argv:
        refresh_quickresto()

    sales = read_sales()
    today = max(sales) if sales else date.today()
    month = (today.year, today.month)
    prev = today - timedelta(days=1)

    print("=" * 62)
    print(f"  ФИНАНСОВОЕ СОСТОЯНИЕ на {today.strftime('%d.%m.%Y')}")
    print("=" * 62)

    # ── выручка ───────────────────────────────────────────────────────────
    d = sales.get(today, {"cash": 0, "cashless": 0, "checks": 0})
    p = sales.get(prev, {"cash": 0, "cashless": 0, "checks": 0})
    mtd = defaultdict(float)
    days_done = 0
    for dt, v in sales.items():
        if (dt.year, dt.month) == month:
            mtd["cash"] += v["cash"]; mtd["cashless"] += v["cashless"]
            mtd["checks"] += v["checks"]; days_done += 1
    tot_day = d["cash"] + d["cashless"]
    tot_prev = p["cash"] + p["cashless"]
    tot_mtd = mtd["cash"] + mtd["cashless"]

    print("\nВЫРУЧКА")
    print(f"   за {today.strftime('%d.%m')}          {M(tot_day):>13}   чеков {d['checks']}")
    print(f"   за {prev.strftime('%d.%m')}          {M(tot_prev):>13}   чеков {p['checks']}")
    print(f"   с начала месяца  {M(tot_mtd):>13}   за {days_done} дн., в среднем "
          f"{M(tot_mtd/days_done if days_done else 0)}/день")
    if tot_mtd:
        print(f"   наличные         {M(mtd['cash']):>13}   {mtd['cash']/tot_mtd*100:.0f}% выручки")

    # ── кассовая дисциплина ───────────────────────────────────────────────
    #
    # Погашенный счёт, который не пробили заново, — единственный канал, где
    # разбор 16.08.2026 нашёл настоящую дыру. До 22.08 проверка жила отдельным
    # скриптом, и её никто не смотрел: сторож 21.08 назвал висяк дословно,
    # и всё равно понадобился человек, который прочтёт. Отсюда — в сводку.
    #
    # ⚠️ Блок обязан РУГАТЬСЯ на отсутствие данных. Пустой блок читался бы
    # как «нарушений нет» — то есть врал бы в самую спокойную сторону,
    # а такие ошибки не находят годами.
    #
    # 🔴 Считаем за ТОТ ЖЕ день, что и вся сводка, — за `today`, а не за
    # `prev`. Здесь стоял `prev`, и дисциплина отставала на два дня от
    # календаря: 08.09.2026 отчёт показал 06.09. Владелец заметила сама:
    # «почему считает кассу за день назад?»
    #
    # Отставание было не опиской, а страховкой: пока ключа ОФД по ИП Шалаевой
    # не было, чеки бара приходили ручными выгрузками владельца, и за вчера
    # их могло не быть. Ключ пришёл 23.08.2026, бар идёт по нему так же, как
    # зал, — страховка пережила свою причину. Проверено на 08.09: за 07.09
    # есть оба, зал 78 чеков и бар 61.
    #
    # ⚠️ Оговорка, из-за которой день всё же может выйти неполным: сутки
    # заведения кончаются в 10:59, а задача ходит в 9:02, то есть последний
    # час торговых суток ещё идёт. На счёт это почти не влияет — за 2026 год
    # между шестью и одиннадцатью утра пробито 13 чеков из 24 тысяч, — но
    # если однажды блок покажет странность именно в утренние часы, причина
    # будет эта.
    try:
        sys.path.insert(0, str(ROOT / "scripts"))
        from ofd_returns import блок_за_день
        print()
        for строка in блок_за_день(today):
            print(строка)
    except Exception as e:
        print(f"\nКАССОВАЯ ДИСЦИПЛИНА\n   ⚠️  посчитать не удалось: "
              f"{type(e).__name__}: {e}")

    # ── расходы ───────────────────────────────────────────────────────────
    cls = DATA / "bank_classified.csv"
    if cls.exists():
        rows = list(csv.DictReader(cls.open(encoding="utf-8")))
        last_bank = max((r["date"] for r in rows), default="—")
        ext = wd = loan = 0.0
        for r in rows:
            if r["direction"] != "out":
                continue
            y, m, _ = map(int, r["date"].split("-"))
            if (y, m) != month:
                continue
            if r["class"] == "external":
                ext += float(r["amount"])
            elif r["class"] == "withdrawal":
                wd += float(r["amount"])
            elif r["class"] == "loan":
                loan += float(r["amount"])
        print("\nРАСХОДЫ С НАЧАЛА МЕСЯЦА (банк)")
        print(f"   операционные     {M(ext):>13}")
        print(f"   вывод собственнику {M(wd):>11}")
        # ⚠️ Строка появилась 16.08.2026 вместе с родом «loan». Без неё займы
        # между площадками исчезали бы и отсюда: этот блок знал только про
        # external и withdrawal, а незнакомый род молча не попадает никуда.
        # Ровно так 1 500 000 ₽ и пропали с экрана — второй раз наступать
        # на это в утренней сводке не будем.
        if loan:
            print(f"   заимствования    {M(loan):>13}  ← между площадками, не расход")
        print(f"   сальдо к выручке {M(tot_mtd - ext):>13}")
        if last_bank != "—" and last_bank < today.isoformat():
            print(f"   ⚠️  выписка загружена по {last_bank}, отстаёт от кассы")

    # ── остатки ───────────────────────────────────────────────────────────
    bal = DATA / "bank_balances.csv"
    if bal.exists():
        last = {}
        for b in csv.DictReader(bal.open(encoding="utf-8")):
            key = b["account"]
            if key not in last or b["date"] > last[key]["date"]:
                last[key] = b
        print("\nДЕНЬГИ НА СЧЕТАХ")
        import json
        reg = json.loads((DATA / "registry.json").read_text(encoding="utf-8"))
        names, закрытые = {}, set()
        for e in reg["entities"]:
            for a in e["accounts"]:
                if a["number"]:
                    names[a["number"]] = (e["short"], a["type"], a.get("role", ""))
                    if a.get("закрыт"):
                        закрытые.add(a["number"])
                    # Учёт по счёту кончился датой — остаток на экране тоже.
                    # Отдельно от `закрыт`: закрытие счёта и конец учёта
                    # по нему это разные события, и совпадать не обязаны.
                    if a.get("в_учёте_до"):
                        закрытые.add(a["number"])
        total_oper = 0.0
        for num, b in sorted(last.items()):
            # Остаток закрытого счёта — история, а не деньги. Показать его
            # среди живых значит завысить оборотные средства на сумму,
            # которой давно нет.
            if num in закрытые:
                continue
            short, typ, role = names.get(num, ("?", "?", ""))
            tag = "резерв на налоги" if role == "tax_reserve" else typ
            print(f"   {short:<12} {tag:<18} {M(float(b['closing'])):>13}   на {b['date']}")
            if role != "tax_reserve":
                total_oper += float(b["closing"])
        print(f"   {'─'*46}")
        print(f"   {'оборотные деньги':<31}{M(total_oper):>13}")

    gaps_report()

    # ── ближайшие платежи ─────────────────────────────────────────────────
    print("\nБЛИЖАЙШИЕ КРУПНЫЕ ПЛАТЕЖИ (по историческому календарю)")
    # ⚠️ Названия — со слов владельца 19.08.2026, а не догадка по суммам.
    # 25-го платится АВАНС, а не зарплата: зарплата за месяц уходит 30-го.
    # Путать их нельзя — это разные деньги и разный размер, и сводка,
    # называющая аванс зарплатой, готовит не к той сумме.
    plan = [(10, "зарплата / аванс"), (15, "аренда"), (25, "аренда, аванс"),
            (28, "налоги"), (30, "зарплата за месяц")]
    for day_no, what in plan:
        if day_no >= today.day:
            print(f"   {day_no}-е — {what}")
    print()


if __name__ == "__main__":
    main()
