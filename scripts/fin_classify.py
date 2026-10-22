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


def other_site_accounts(reg):
    """Счета чужой площадки — те, у кого в справочнике `в_учёт_невского: false`.

    ⚠️ Берём флагом из справочника, а не номером в коде. Номер этого счёта
    уже один раз сочли опечаткой и удалили (08.08.2026), а потом вернули —
    правило, прибитое к цифре, пережило бы такую историю молча и неверно.
    """
    счета = {a["number"] for e in reg["entities"] for a in e["accounts"]
             if a.get("number") and a.get("в_учёт_невского") is False}
    # Тот же счёт назван и в правилах, отдельным ключом с пояснением
    # «молча исчезают из отчёта, требуется отдельная подсветка». Берём оба
    # источника: справочник правится руками, и запись в одном месте
    # без записи в другом — обычное дело.
    названный = (reg.get("rules") or {}).get("moscow_account")
    if названный:
        счета.add(названный)
    return счета


def в_учёте_до(reg):
    """Счета, у которых учёт кончается датой: {номер: последний день}.

    Зачем. ИП Борзовой не стало в январе 2025, но её расчётный счёт дожил
    до июля 2026 с двенадцатью мелочами: плата банку за пакет услуг, счета
    от бухгалтерии и пополнения собственником. Владелец 19.08.2026: расходы
    оставить до конца 2025 года, с 2026-го она нигде не фигурирует.

    ⚠️ Отсечка датой, а не удалением счёта. На нём весь 2024 год работы —
    2 287 операций и почти 67 млн прихода. Убери счёт целиком, и из истории
    пропал бы год, а вопрос был только про 2026-й.

    ⚠️ И не по полю `закрыт`: у этого счёта там стоит 2025-04-01, а операции
    шли по июль 2026. Дата закрытия и дата, до которой мы считаем, — разные
    вещи, и совпадать они не обязаны. Смешать их значит однажды отрезать
    живой счёт по формальной пометке.
    """
    return {a["number"]: a["в_учёте_до"]
            for e in reg["entities"] for a in e["accounts"]
            if a.get("number") and a.get("в_учёте_до")}


def classify(row, reg, by_account, other_sites=frozenset()):
    """Возвращает (id юрлица, тип счёта, класс операции, пояснение)."""
    ent, acc_type = by_account.get(row["account"], (None, "unknown"))
    rules = reg["rules"]

    # Ручная переразметка: платежи, у которых назначение не соответствует сути.
    # Стоит первой — иначе обычные правила разберут платёж по тексту назначения.
    for x in rules.get("reclassify", []):
        if (row["date"] == x["date"] and row["doc_no"] == x["doc_no"]
                and abs(float(row["amount"]) - x["amount"]) < 0.01):
            return ent, acc_type, x["class"], x["why"]

    inn = (row.get("inn") or "").strip()
    purpose = (row.get("purpose") or "").lower()

    # Заимствования между площадками. Решение владельца 15.08.2026: движения
    # между невским и московским счетами ИП Шалаевой — заём и возврат займа,
    # а не расход и не внутренний перевод.
    #
    # ⚠️ Стоит ВЫШЕ проверки на свой ИНН, и в этом весь смысл. Московский счёт
    # принадлежит тому же ИП, поэтому по ИНН он неизбежно попадал во «внутренние
    # переводы», а те экран пропускает целиком — 1 500 000 ₽ от 22.07.2026 просто
    # не было видно нигде. Владелец заметила пропажу 16.08.2026 и была права.
    #
    # 💡 Отдельный класс, а не «external», потому что это и не расход тоже:
    # деньги ушли на свою же вторую площадку и могут вернуться. Но показать
    # их надо — иначе тишина выдаётся за отсутствие движения.
    if (row.get("counter_account") or "") in other_sites:
        return ent, acc_type, "loan", "заимствование между площадками"

    # 🔴 Перевод на ЛИЧНЫЙ счёт физлица (40817…) при своём же ИНН — это вывод
    # собственнику, а не внутренний перевод. Своё юрлицо и свой карман — разные
    # вещи: из юрлица деньги ещё в деле, на личной карте их в деле уже нет.
    #
    # ⚠️ Стоит ВЫШЕ проверки на свой ИНН, как и правило про московский счёт,
    # и ровно по той же причине: ИНН там совпадает всегда, и без этой строки
    # платёж молча уезжал во «внутренние», которые отчёты пропускают целиком.
    #
    # 🔴 Что это стоило: 10 065 250 ₽ за июль–сентябрь 2025 не считались
    # выводом вовсе. Нашлось 12.09.2026 — владелец прислала свою таблицу
    # выводов по месяцам, и за эти три месяца у неё стояло 2 909 250 +
    # 4 256 000 + 2 900 000, а у нас по тем же месяцам был ноль. Сумма
    # совпала с потерянными переводами до рубля.
    #
    # 💡 Почему именно 40817 и свой ИНН вместе. Один 40817 без ИНН — это
    # и зарплата сотрудникам тоже (23 платежа на 1 933 252 ₽ за весь период);
    # один свой ИНН без 40817 — это настоящие переводы между своими юрлицами.
    # Пара сужает правило ровно до тринадцати нужных платежей и не задевает
    # больше ничего — проверено пересчётом до и после.
    if (inn and inn in rules["internal_inn"]
            and (row.get("counter_account") or "").startswith("40817")):
        return ent, acc_type, "withdrawal", "вывод собственнику на личный счёт"

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

    other_sites = other_site_accounts(reg)
    отсечки = в_учёте_до(reg)
    rows = list(csv.DictReader(src.open(encoding="utf-8")))
    out = []
    отсечено = defaultdict(int)
    for r in rows:
        предел = отсечки.get(r["account"])
        if предел and r["date"] > предел:
            # Операция позже отсечки: в учёт не идёт вовсе. Не «прочий расход»
            # и не отдельный класс — иначе она осталась бы видна где-нибудь
            # в итогах, а решение владельца было «нигде не фигурирует».
            отсечено[r["account"]] += 1
            continue
        ent, acc_type, cls, why = classify(r, reg, by_account, other_sites)
        r = dict(r)
        r.update({"entity": ent or "?", "account_type": acc_type, "class": cls, "why": why})
        out.append(r)

    # ⚠️ Говорим вслух, сколько выбросили. Тихая отсечка неотличима
    # от пропавшей выписки, а это ровно тот случай, который в этом проекте
    # уже стоил одиннадцати месяцев с нулевым эквайрингом.
    for номер, сколько in отсечено.items():
        print(f"Вне учёта по отсечке: {сколько} операций по счёту …{номер[-4:]} "
              f"после {отсечки[номер]}")

    with (DATA / "bank_classified.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, ["date", "entity", "account", "counter_account", "account_type", "doc_no",
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
    # Депозит счёта, учёт по которому кончился (`в_учёте_до`), в копилку
    # не входит: 22.10.2026 закрыли ИП Хисамова, а его последний остаток
    # 111 011 ₽ на 05.10 так и считался бы деньгами на налог навсегда.
    отсечки = в_учёте_до(reg)
    deposits = {num for num, (_, t) in by_account.items()
                if t == "deposit" and num not in отсечки}
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
