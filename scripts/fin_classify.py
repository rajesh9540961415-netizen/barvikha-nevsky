#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Разметка банковских операций по справочнику юрлиц.

Главная задача — не посчитать дважды. У группы несколько своих юрлиц, деньги
между ними ходят постоянно (ООО «МАВ» платит ИП по договору услуг). Для
консолидированного ДДС такие переводы — не расход, а перекладывание из кармана
в карман. Скрипт делит все операции на три класса:

    external   — деньги реально ушли из группы (поставщики, налоги, зарплата)
    internal   — перевод между своими юрлицами или на свой же депозит
    withdrawal — вывод собственнику («Вознаграждение», перевод ИП на личный счёт)

Запуск:  python3 scripts/fin_classify.py
Читает:  data/dds/bank_transactions.csv + data/dds/registry.json
Пишет:   data/dds/bank_classified.csv
"""
import csv
import json
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "dds"


def load_registry():
    reg = json.loads((DATA / "registry.json").read_text(encoding="utf-8"))
    by_account, entities = {}, {}
    for e in reg["entities"]:
        entities[e["id"]] = e
        for a in e["accounts"]:
            if a["number"]:
                by_account[a["number"]] = (e["id"], a["type"])
    return reg, entities, by_account


def classify(row, reg, by_account):
    """Возвращает (id юрлица, тип счёта, класс операции, пояснение)."""
    ent, acc_type = by_account.get(row["account"], (None, "unknown"))
    rules = reg["rules"]
    inn = (row.get("inn") or "").strip()
    purpose = (row.get("purpose") or "").lower()

    if inn and inn in rules["internal_inn"]:
        return ent, acc_type, "internal", "контрагент — своё же юрлицо"
    if acc_type == "deposit":
        return ent, acc_type, "internal", "движение по депозиту"
    for marker in rules["withdrawal_purpose"]:
        if marker in purpose:
            return ent, acc_type, "withdrawal", "вывод собственнику"
    if any(m in purpose for m in rules["salary_purpose"]):
        return ent, acc_type, "external", "зарплата"
    if inn in rules["tax_inn"]:
        return ent, acc_type, "external", "налоги"
    return ent, acc_type, "external", ""


def main():
    reg, entities, by_account = load_registry()
    src = DATA / "bank_transactions.csv"
    if not src.exists():
        raise SystemExit("Нет data/dds/bank_transactions.csv — сначала запустите bank_import.py")

    rows = list(csv.DictReader(src.open(encoding="utf-8")))
    out = []
    for r in rows:
        ent, acc_type, cls, why = classify(r, reg, by_account)
        r = dict(r)
        r.update({"entity": ent or "?", "account_type": acc_type, "class": cls, "why": why})
        out.append(r)

    with (DATA / "bank_classified.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, ["date", "entity", "account", "account_type", "doc_no",
                               "direction", "class", "amount", "counterparty", "inn",
                               "why", "purpose"])
        w.writeheader()
        for r in out:
            w.writerow({k: r.get(k, "") for k in w.fieldnames})

    # ── сводка ────────────────────────────────────────────────────────────
    M = lambda v: f"{v:,.0f}".replace(",", " ")
    agg = defaultdict(float)
    n = defaultdict(int)
    for r in out:
        k = (r["entity"], r["direction"], r["class"])
        agg[k] += float(r["amount"])
        n[k] += 1

    print("РАЗМЕТКА ОПЕРАЦИЙ")
    print(f"{'юрлицо':<14}{'напр.':<7}{'класс':<12}{'сумма':>15}{'шт':>6}")
    print("─" * 56)
    for k in sorted(agg, key=lambda x: (x[0], x[1], -agg[x])):
        name = entities.get(k[0], {}).get("short", k[0])
        print(f"{name:<14}{k[1]:<7}{k[2]:<12}{M(agg[k]):>15}{n[k]:>6}")

    print("\nЧТО ИДЁТ В КОНСОЛИДИРОВАННЫЙ ДДС (только external + withdrawal):")
    for ent_id in {r["entity"] for r in out}:
        name = entities.get(ent_id, {}).get("short", ent_id)
        ext = sum(float(r["amount"]) for r in out
                  if r["entity"] == ent_id and r["direction"] == "out" and r["class"] == "external")
        wd = sum(float(r["amount"]) for r in out
                 if r["entity"] == ent_id and r["direction"] == "out" and r["class"] == "withdrawal")
        skip = sum(float(r["amount"]) for r in out
                   if r["entity"] == ent_id and r["direction"] == "out" and r["class"] == "internal")
        print(f"   {name:<14} расходы {M(ext):>13}   вывод {M(wd):>13}   "
              f"отброшено как внутреннее {M(skip):>13}")

    tax_reserve_report(reg, by_account, out)

    report_gaps(reg, out)


def report_gaps(reg, out):
    """Чего в учёте не хватает.

    Три разные беды, и молчаливая из них — вторая. Юрлицо без реквизитов ещё
    заметно, а вот юрлицо, у которого счёт заведён, но не пришло ни одной
    операции, в отчётах просто отсутствует: расходы группы занижены, а выглядит
    это как нормальная картина.
    """
    problems = []

    for e in reg["entities"]:
        if not any(a["number"] for a in e["accounts"]):
            problems.append(f"{e['name']}: не заведён ни один счёт — "
                            f"операции по нему в учёт не попадут")

    seen = {r["entity"] for r in out}
    today = date.today().isoformat()
    for e in reg["entities"]:
        active = e.get("active_to") is None and (e.get("active_from") or "") <= today
        if active and e["id"] not in seen and any(a["number"] for a in e["accounts"]):
            problems.append(f"{e['name']}: счёт заведён, но НИ ОДНОЙ операции — "
                            f"расходы группы занижены на неизвестную величину")

    # Счёт из выписки, которого нет в справочнике. Операции загрузились, но
    # повисли без юрлица и во все итоги по юрлицам не попали.
    unknown = defaultdict(int)
    for r in out:
        if r["entity"] == "?":
            unknown[r["account"]] += 1
    for acc, cnt in sorted(unknown.items(), key=lambda x: -x[1]):
        problems.append(f"счёт {acc}: {cnt} оп. — такого счёта нет в registry.json, "
                        f"эти операции ни в одном итоге по юрлицам не учтены")

    if problems:
        print("\n⚠️  ЧЕГО НЕ ХВАТАЕТ")
        for p in problems:
            print(f"   • {p}")


# Налоги платятся не ровным потоком, а рывками. Усреднять их по месяцам нельзя.
#   • УСН — авансовый платёж раз в квартал, до 28 января / апреля / июля / октября.
#     Плюс годовой расчёт в марте. Это самые крупные транши.
#   • НДС — тоже квартальный, но разбит на три равные доли и платится
#     до 28 числа каждого месяца следующего квартала.
#   • Взносы и НДФЛ — каждый месяц, обычно около 10 числа, суммы небольшие.
QUARTER_MONTHS = (1, 4, 7, 10)      # авансовый УСН за прошедший квартал
ANNUAL_MONTH = 3                    # годовой расчёт по УСН
# Доля квартальной выручки, которая уходит крупным траншем.
# Проверено на факте: июль-25 6.9%, окт-25 8.3%, апр-26 7.9%, июль-26 7.7%.
QUARTER_TAX_RATE = 0.08


def month_kind(m):
    if m in QUARTER_MONTHS:
        return "квартальный"
    if m == ANNUAL_MONTH:
        return "годовой УСН"
    return "обычный"


def revenue_by_month():
    rev = defaultdict(float)
    for f in DATA.glob("qr_sales_*.csv"):
        for r in csv.DictReader(f.open(encoding="utf-8")):
            rev[r["date"][:7]] += float(r["cash"]) + float(r["cashless"])
    return rev


def tax_reserve_report(reg, by_account, out):
    """Депозит — копилка на налоги. Показываем ОСТАТОК и хватит ли его.

    Механика: с каждого поступления на расчётный счёт 6% автоматически уходит
    на депозит; к сроку платежа деньги возвращаются. В ДДС движения по депозиту
    не показываем — это свои же деньги.
    """
    deposits = {num for num, (_, t) in by_account.items() if t == "deposit"}
    if not deposits:
        return
    balances = DATA / "bank_balances.csv"
    if not balances.exists():
        return

    M = lambda v: f"{v:,.0f}".replace(",", " ")
    per_acc = {}
    monthly = defaultdict(dict)
    for b in csv.DictReader(balances.open(encoding="utf-8")):
        if b["account"] not in deposits:
            continue
        cur = per_acc.get(b["account"])
        if cur is None or b["date"] > cur["date"]:
            per_acc[b["account"]] = b
        m = b["date"][:7]
        prev = monthly[m].get(b["account"])
        if prev is None or b["date"] > prev["date"]:
            monthly[m][b["account"]] = b

    taxes = defaultdict(float)
    for r in out:
        if r["direction"] == "out" and r["why"] == "налоги":
            taxes[r["date"][:7]] += float(r["amount"])

    print("\nНАЛОГИ И КОПИЛКА")
    print("(платежи неравномерны: крупный транш раз в квартал, НДС по 1/3 каждый месяц)")
    print(f"{'месяц':<10}{'тип месяца':<14}{'заплачено':>14}{'в копилке на конец':>21}")
    print("─" * 60)
    for k in sorted(set(monthly) | set(taxes)):
        m = int(k[5:7])
        bal = sum(float(b["closing"]) for b in monthly.get(k, {}).values())
        print(f"{k:<10}{month_kind(m):<14}{M(taxes.get(k, 0)):>14}{M(bal):>21}")

    reserve = sum(float(b["closing"]) for b in per_acc.values())

    # ── сколько понадобится к ближайшему 28-му ────────────────────────────
    today = date.today()
    nxt = today if today.day <= 28 else (today.replace(day=1) + timedelta(days=32)).replace(day=1)
    kind = month_kind(nxt.month)
    rev = revenue_by_month()

    print(f"\n   в копилке сейчас: {M(reserve)}")
    print(f"   ближайший срок:   28.{nxt.month:02d}.{nxt.year} — месяц {kind}")

    if kind == "обычный":
        ordinary = [v for k, v in taxes.items() if month_kind(int(k[5:7])) == "обычный" and v > 0]
        need = sum(ordinary) / len(ordinary) if ordinary else 0
        print(f"   ожидаемый платёж: ~{M(need)} (НДС 1/3 + взносы + НДФЛ)")
    else:
        # крупный транш считаем от выручки прошедшего квартала
        q_end = nxt.month - 1
        months = [(nxt.year, q_end - i) for i in range(3)]
        months = [(y + (m - 1) // 12, (m - 1) % 12 + 1) for y, m in months]
        q_rev = sum(rev.get(f"{y}-{m:02d}", 0) for y, m in months)
        need = q_rev * QUARTER_TAX_RATE
        names = ", ".join(f"{m:02d}.{y}" for y, m in reversed(months))
        print(f"   ожидаемый платёж: ~{M(need)} — это {QUARTER_TAX_RATE*100:.0f}% "
              f"от выручки квартала ({names}: {M(q_rev)})")

    if need:
        gap = need - reserve
        months_left = max((date(nxt.year, nxt.month, 28) - today).days, 0) / 30.4
        if gap > 0:
            print(f"   ⚠️  НЕ ХВАТАЕТ {M(gap)}. До срока {int(months_left * 30.4)} дн.")
            print(f"       При нынешней ставке 6% от поступлений копилка растёт "
                  f"примерно на 1 млн ₽ в месяц — этого мало для квартального транша."
                  if kind != "обычный" else
                  f"       Пополнение по ставке 6% обычно перекрывает обычный месяц.")
        else:
            print(f"   ✅ хватает, запас {M(-gap)}")


if __name__ == "__main__":
    main()
