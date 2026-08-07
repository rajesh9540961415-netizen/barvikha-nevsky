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

    missing = [e["name"] for e in reg["entities"]
               if not any(a["number"] for a in e["accounts"])]
    if missing:
        print(f"\n⚠️  Нет реквизитов счёта: {', '.join(missing)} — операции по ним не попадут в учёт.")


def tax_reserve_report(reg, by_account, out):
    """Депозит — копилка на налоги. Показываем ОСТАТОК, а не операции.

    Механика: с каждого поступления на расчётный счёт 6% автоматически уходит
    на депозит; к сроку налогового платежа деньги возвращаются обратно.
    Поэтому в ДДС движения по депозиту не показываем — это свои же деньги.
    """
    deposits = {num for num, (_, t) in by_account.items() if t == "deposit"}
    if not deposits:
        return
    balances = DATA / "bank_balances.csv"
    if not balances.exists():
        return

    M = lambda v: f"{v:,.0f}".replace(",", " ")
    last = {}
    for b in csv.DictReader(balances.open(encoding="utf-8")):
        if b["account"] in deposits:
            last[b["date"][:7]] = float(b["closing"])

    taxes = defaultdict(float)
    for r in out:
        if r["direction"] == "out" and r["why"] == "налоги":
            taxes[r["date"][:7]] += float(r["amount"])

    print("\nНАКОПЛЕНИЯ НА НАЛОГИ (депозит — только остаток, операции в ДДС не идут)")
    print(f"{'месяц':<10}{'отложено на конец':>20}{'заплачено налогов':>20}")
    print("─" * 50)
    for k in sorted(set(last) | set(taxes)):
        print(f"{k:<10}{M(last.get(k, 0)):>20}{M(taxes.get(k, 0)):>20}")

    total_tax = sum(taxes.values())
    reserve = last[max(last)] if last else 0
    print(f"\n   налогов заплачено за период: {M(total_tax)}")
    print(f"   отложено сейчас:             {M(reserve)}")
    if total_tax:
        months = len(taxes) or 1
        need = total_tax / months
        print(f"   в среднем налогов в месяц:   {M(need)}")
        if reserve < need:
            print(f"   ⚠️  Резерва не хватает на один средний месячный платёж.")


if __name__ == "__main__":
    main()
