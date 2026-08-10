#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Красные флаги в банковских операциях.

Главное, что ищем — **оплату одного и того же счёта дважды**. Это не техническая
накладка выгрузки (такие повторы отсекает bank_import.py по номеру документа),
а живая ошибка: сотрудник провёл счёт, забыл, провёл ещё раз. Деньги ушли
реально, и по итоговым суммам это никак не видно.

Проверки:
  1. Один номер счёта в назначении платежа оплачен больше одного раза.
  2. Одному контрагенту одинаковая сумма в пределах 14 дней разными документами.
  3. Платёж, резко выбивающийся из обычных сумм этого контрагента.
  4. Новый контрагент с крупным первым платежом.
  5. Перевод на личные нужды, ушедший через зарплатный реестр.

Запуск:
    python3 scripts/fin_redflags.py            # за последние 120 дней
    python3 scripts/fin_redflags.py 30         # за последние 30 дней
    python3 scripts/fin_redflags.py 2026-07    # разбор закрытого месяца

Из проверки исключены переводы собственнику, зарплата, налоги и комиссии
банка: они повторяются круглыми суммами по своей природе и к оплате счетов
отношения не имеют.
"""
import csv
import re
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "dds"
M = lambda v: f"{v:,.0f}".replace(",", " ")

# «Счет от 17.04.26 №ОПГ00018438», «по счету № 1234», «Сч. No 55/1»
INVOICE = re.compile(r"(?:сч[ёе]т|сч\.?|инвойс)[^№#]{0,20}(?:№|#|N[оo]?\s*)\s*([A-ZА-Я0-9][A-ZА-Я0-9\-/\.]{2,})",
                     re.IGNORECASE)


# Платежи, которые повторяются одинаковыми суммами по своей природе и
# задвоением счёта не являются: вывод собственнику, зарплата, налоги,
# комиссии банка. Их из проверки исключаем, иначе она тонет в шуме.
SKIP_PURPOSE = ("перевод средств ип на личный счет", "заработная плата",
                "зарплата", "енп", "единый налоговый", "аванс",
                "комиссия", "плата за", "во вклад", "депозит")


def load(days_back=None, month=None):
    import json
    src = DATA / "bank_classified.csv"
    if not src.exists():
        raise SystemExit("Нет data/dds/bank_classified.csv — запустите fin_classify.py")
    reg = json.loads((DATA / "registry.json").read_text(encoding="utf-8"))
    skip_inn = set(reg["rules"].get("bank_inn", [])) | set(reg["rules"].get("tax_inn", []))

    rows = []
    cutoff = date.today() - timedelta(days=days_back) if days_back else None
    for r in csv.DictReader(src.open(encoding="utf-8")):
        # только реальные расходы наружу: переводы себе и вывод собственнику
        # к оплате счетов отношения не имеют
        if r["direction"] != "out" or r["class"] != "external":
            continue
        if (r["inn"] or "").strip() in skip_inn:
            continue
        if any(s in (r["purpose"] or "").lower() for s in SKIP_PURPOSE):
            continue
        y, m, d = map(int, r["date"].split("-"))
        r["d"] = date(y, m, d)
        if month and r["date"][:7] != month:
            continue
        if cutoff and r["d"] < cutoff:
            continue
        r["amount"] = float(r["amount"])
        rows.append(r)
    return rows


def invoice_no(purpose):
    m = INVOICE.search(purpose or "")
    if not m:
        return None
    num = m.group(1).strip(" .,")
    # отсекаем даты и слишком короткие обрывки
    return num if len(num) >= 3 and not re.fullmatch(r"[\d\.]{1,8}", num) else None


def check_same_invoice(rows, out):
    """Один и тот же номер счёта оплачен дважды — самый сильный признак."""
    groups = defaultdict(list)
    for r in rows:
        num = invoice_no(r["purpose"])
        if num:
            groups[(r["inn"] or r["counterparty"], num.upper())].append(r)
    for (who, num), items in sorted(groups.items(), key=lambda x: -sum(i["amount"] for i in x[1])):
        if len(items) < 2:
            continue
        # тот же документ в двух выписках уже отсеян, здесь только разные платежи
        if len({i["doc_no"] for i in items}) < 2:
            continue
        total = sum(i["amount"] for i in items)
        out.append((total, "СЧЁТ ОПЛАЧЕН ДВАЖДЫ",
                    f"счёт №{num} · {items[0]['counterparty'][:44]}",
                    [f"{i['d']:%d.%m.%Y}  док.{i['doc_no']}  {M(i['amount'])} ₽" for i in items],
                    f"итого по счёту прошло {M(total)} ₽"))


def check_same_amount(rows, out, window=14):
    """Одна и та же сумма одному контрагенту в узком окне."""
    by_cp = defaultdict(list)
    for r in rows:
        by_cp[(r["inn"] or r["counterparty"], round(r["amount"], 2))].append(r)
    for (who, amt), items in by_cp.items():
        if len(items) < 2 or amt < 5000:
            continue
        items.sort(key=lambda r: r["d"])
        for a, b in zip(items, items[1:]):
            if (b["d"] - a["d"]).days > window or a["doc_no"] == b["doc_no"]:
                continue
            # одинаковый номер счёта уже поймали в другой проверке
            if invoice_no(a["purpose"]) and invoice_no(a["purpose"]) == invoice_no(b["purpose"]):
                continue
            out.append((amt * 2, "ОДИНАКОВАЯ СУММА ДВАЖДЫ",
                        f"{a['counterparty'][:44]} · {M(amt)} ₽ дважды за {(b['d']-a['d']).days} дн.",
                        [f"{a['d']:%d.%m.%Y}  док.{a['doc_no']}  {a['purpose'][:70]}",
                         f"{b['d']:%d.%m.%Y}  док.{b['doc_no']}  {b['purpose'][:70]}"],
                        "проверьте, не оплачен ли один счёт дважды"))


def check_outliers(rows, out):
    """Платёж, резко выбивающийся из обычных сумм этого контрагента."""
    by_cp = defaultdict(list)
    for r in rows:
        by_cp[r["inn"] or r["counterparty"]].append(r)
    for who, items in by_cp.items():
        if len(items) < 5:
            continue
        amounts = sorted(i["amount"] for i in items)
        median = amounts[len(amounts) // 2]
        if median <= 0:
            continue
        for r in items:
            if r["amount"] > median * 10 and r["amount"] > 100_000:
                out.append((r["amount"], "НЕТИПИЧНО КРУПНЫЙ ПЛАТЁЖ",
                            f"{r['counterparty'][:44]} · {M(r['amount'])} ₽ "
                            f"при обычных ~{M(median)} ₽",
                            [f"{r['d']:%d.%m.%Y}  док.{r['doc_no']}  {r['purpose'][:70]}"],
                            "в 10+ раз выше обычного платежа этому контрагенту"))


def check_new_big(rows, out, history):
    """Новый контрагент сразу с крупной суммой.

    «Новый» считается по ВСЕЙ истории, а не по проверяемому окну: иначе при
    месячной проверке каждый постоянный поставщик выглядел бы новичком.
    """
    first = {}
    for r in sorted(history, key=lambda r: r["d"]):
        first.setdefault(r["inn"] or r["counterparty"], r["d"])
    checked = {(r["inn"] or r["counterparty"]) for r in rows}
    for r in rows:
        key = r["inn"] or r["counterparty"]
        if first.get(key) == r["d"] and r["amount"] >= 300_000:
            out.append((r["amount"], "НОВЫЙ КОНТРАГЕНТ, КРУПНАЯ СУММА",
                        f"{r['counterparty'][:44]} · {M(r['amount'])} ₽",
                        [f"{r['d']:%d.%m.%Y}  ИНН {r['inn']}  {r['purpose'][:70]}"],
                        "первый платёж этому получателю за всю историю"))


REESTR = re.compile(r"реестру\s*№\s*(\d+)", re.IGNORECASE)


def load_registers(month=None, days_back=None):
    """Зарплатные реестры и переводы на личный счёт — с номерами реестров.

    Отдельная загрузка: основной load() выбрасывает и то, и другое, потому что
    к оплате счетов они отношения не имеют. Здесь они как раз и нужны.
    """
    src = DATA / "bank_classified.csv"
    cutoff = date.today() - timedelta(days=days_back) if days_back else None
    rows = []
    for r in csv.DictReader(src.open(encoding="utf-8")):
        if r["direction"] != "out":
            continue
        low = (r["purpose"] or "").lower()
        is_sal = "заработная плата по реестру" in low
        is_wd = "на личный счет" in low
        if not (is_sal or is_wd):
            continue
        m = REESTR.search(r["purpose"] or "")
        if not m:
            continue
        if month and r["date"][:7] != month:
            continue
        y, mm, d = map(int, r["date"].split("-"))
        if cutoff and date(y, mm, d) < cutoff:
            continue
        r["reestr"] = int(m.group(1))
        r["amount"] = float(r["amount"])
        r["kind"] = "salary" if is_sal else "withdrawal"
        rows.append(r)
    return rows


def check_salary_registers(rows, out):
    """Перевод на личные нужды, отправленный через зарплатный проект.

    Такой платёж выглядит зарплатой и попадает в расходы, хотя расходом не
    является — это вывод собственнику, и прибыль из-за него занижается.

    Признаков нужно два сразу, по одному ловятся ложные.

    Первый — номер реестра. Переводы на личный счёт нумеруются сплошным рядом,
    зарплата своим, отдельным; подменный платёж занимает пропущенное место в
    ряду переводов. Но ряды иногда пересекаются по диапазону, и тогда обычная
    зарплата попадает под подозрение: в феврале так отметился платёж на 42 804 ₽
    с реестром №7, в апреле — 14 268 ₽ с №18.

    Второй — размер и ровность суммы. Настоящая зарплата даёт копейки и держится
    в своём диапазоне; подменный платёж ровный и кратно крупнее. Порог берём от
    данных, а не с потолка: впятеро выше медианной зарплаты этого счёта.

    Проверено на двух случаях 2026 года: апрель (реестр 18 между 17 и 19,
    800 000 ₽) и июнь (реестр 37 между 36 и 38, 900 000 ₽). На остальных
    месяцах года срабатываний нет.
    """
    import statistics
    by = defaultdict(lambda: {"salary": [], "withdrawal": []})
    for r in rows:
        by[(r["date"][:7], r["account"])][r["kind"]].append(r)

    for (month, acc), g in sorted(by.items()):
        wd = {x["reestr"] for x in g["withdrawal"]}
        if len(wd) < 3:          # ряда нет — сравнивать не с чем
            continue
        lo, hi = min(wd), max(wd)
        sal_regs = {x["reestr"] for x in g["salary"]}
        sal_amounts = [x["amount"] for x in g["salary"]]
        if not sal_amounts:
            continue
        med = statistics.median(sal_amounts)
        for x in g["salary"]:
            n, a = x["reestr"], x["amount"]
            if not (lo <= n <= hi) or n in wd:
                continue
            if a % 10000 or a < 5 * med:      # обычная зарплата: не ровная, в своём диапазоне
                continue
            # номер попал внутрь ряда переводов и занял в нём пустое место
            others = sorted(sal_regs - {n})
            lines = [
                f"{x['date']}  {M(x['amount'])} ₽  реестр №{n}  (счёт …{acc[-6:]})",
                f"переводы на личный счёт в этом месяце: реестры "
                f"{lo}–{hi}, и №{n} в этом ряду отсутствует",
                f"настоящие зарплатные реестры месяца: "
                f"{', '.join('№' + str(i) for i in others) if others else 'нет'}",
                f"сумма ровная и в {a / med:.0f} раз крупнее медианной зарплаты "
                f"этого счёта ({M(med)} ₽)",
            ]
            out.append((
                x["amount"], "ПЕРЕВОД НА ЛИЧНЫЕ НУЖДЫ ПОД ВИДОМ ЗАРПЛАТЫ",
                f"{month}: платёж помечен зарплатой, но по номеру реестра "
                f"принадлежит переводам на личный счёт",
                lines,
                "Если это действительно перевод собственнику — впишите платёж в "
                "rules.reclassify в data/dds/registry.json (по дате и номеру документа "
                f"{x['doc_no']}) и перезапустите fin_classify.py. Иначе он останется в "
                "расходах и занизит прибыль."))


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else "120"
    if re.fullmatch(r"\d{4}-\d{2}", arg):        # разовая проверка за месяц
        rows, period = load(month=arg), f"за {arg}"
    else:
        rows, period = load(days_back=int(arg)), f"за последние {arg} дн."

    history = load()          # вся история — нужна, чтобы понять, кто правда новичок
    out = []
    check_same_invoice(rows, out)
    check_same_amount(rows, out)
    check_outliers(rows, out)
    check_new_big(rows, out, history)
    if re.fullmatch(r"\d{4}-\d{2}", arg):
        check_salary_registers(load_registers(month=arg), out)
    else:
        check_salary_registers(load_registers(days_back=int(arg)), out)

    print(f"КРАСНЫЕ ФЛАГИ · проверено {len(rows)} платежей поставщикам {period}")
    print("(переводы собственнику, зарплата, налоги и комиссии из проверки исключены)")
    print("=" * 74)
    if not out:
        print("   Ничего подозрительного не найдено.")
        return

    out.sort(key=lambda x: -x[0])
    for _, kind, title, lines, note in out:
        print(f"\n⚠️  {kind}")
        print(f"    {title}")
        for l in lines:
            print(f"      · {l}")
        print(f"    → {note}")
    print(f"\n{'=' * 74}\nвсего сигналов: {len(out)}")


if __name__ == "__main__":
    main()
