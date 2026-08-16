#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Разбор банковской выписки СберБизнес в формате «1С» (kl_to_1c.txt).

Формат — простой текст «Ключ=Значение» с секциями. Кодировка обычно windows-1251.
Скрипт вытаскивает платежи и дневные остатки по счёту.

Запуск:
    python3 scripts/bank_import.py                     — всё из data/dds/выписки/
    python3 scripts/bank_import.py <файл> [ещё файлы...] — только указанные

Результат: data/dds/bank_transactions.csv и data/dds/bank_balances.csv
"""
import csv
import re
import sys
import zipfile
from datetime import datetime
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "dds"


def read_text(path):
    """Читает kl_to_1c.txt — как есть или из zip-архива выписки."""
    path = Path(path)
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".txt")]
            if not names:
                raise SystemExit(f"В архиве {path.name} нет файла .txt с выпиской")
            raw = z.read(names[0])
    else:
        raw = path.read_bytes()
    # ⚠️ ПОРЯДОК ЗДЕСЬ — НЕ МЕЛОЧЬ, а суть проверки.
    #
    # windows-1251 читает ЛЮБЫЕ байты и не спотыкается никогда: у неё занято
    # всё пространство значений. Поставь её первой — и она «подойдёт» к файлу
    # в UTF-8, молча превратив русский текст в «РћС‚РїСЂР°РІРёС‚РµР»СЊ».
    # Ошибки не будет, будет испорченный контрагент и назначение платежа,
    # а по ним размечаются статьи расходов.
    #
    # UTF-8, наоборот, на чужих байтах спотыкается — поэтому её проверка
    # честная, и пробовать надо с неё. Проверка годится только тогда,
    # когда умеет не сойтись.
    #
    # 15.08.2026: выписки приходят в обеих кодировках. Старые — Windows,
    # скачанные по ссылке из письма — UTF-8, и файл сам это объявляет
    # строкой «Кодировка=».
    for enc in ("utf-8-sig", "windows-1251", "cp866"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise SystemExit(f"Не удалось определить кодировку {path.name}")


def d(s):
    return datetime.strptime(s.strip(), "%d.%m.%Y").date() if s.strip() else None


def parse(text):
    """Возвращает (список платежей, список дневных остатков, номера счетов).

    В шапке файла может быть НЕСКОЛЬКО строк РасчСчет: банк отдаёт одной
    выпиской и расчётный счёт, и депозит. Поэтому для каждого платежа счёт
    определяем отдельно — по тому, какой из наших счетов участвует в операции.
    """
    accounts = []
    docs, balances = [], []
    cur, mode = {}, None

    for line in text.replace("\r\n", "\n").split("\n"):
        line = line.strip()
        if not line:
            continue
        if line == "СекцияДокумент" or line.startswith("СекцияДокумент="):
            cur, mode = {}, "doc"
            continue
        if line == "СекцияРасчСчет":
            cur, mode = {}, "bal"
            continue
        if line == "КонецДокумента":
            docs.append(cur); cur, mode = {}, None
            continue
        if line == "КонецРасчСчет":
            balances.append(cur); cur, mode = {}, None
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if mode is None and k == "РасчСчет" and v and v not in accounts:
            accounts.append(v)
        if mode:
            cur[k] = v

    own = set(accounts)
    tx = []
    for x in docs:
        payer = x.get("ПлательщикСчет", "") or x.get("ПлательщикРасчСчет", "")
        recv = x.get("ПолучательСчет", "") or x.get("ПолучательРасчСчет", "")
        # чей это счёт: тот из наших, что участвует в операции
        if payer in own:
            acc, outgoing = payer, True
        elif recv in own:
            acc, outgoing = recv, False
        else:                       # ни один не наш — считаем по первому счёту файла
            acc, outgoing = (accounts[0] if accounts else ""), True
        tx.append({
            "date": d(x.get("ДатаСписано") or x.get("ДатаПоступило") or x.get("Дата", "")),
            "doc_no": x.get("Номер", ""),
            "direction": "out" if outgoing else "in",
            "amount": float((x.get("Сумма") or "0").replace(",", ".")),
            "counterparty": (x.get("Получатель") if outgoing else x.get("Плательщик")) or "",
            "inn": (x.get("ПолучательИНН") if outgoing else x.get("ПлательщикИНН")) or "",
            "account": acc,
            # Счёт второй стороны. Нужен, чтобы отличать переводы внутри группы
            # от переводов на счёт другой площадки: ИНН у них один и тот же,
            # и по нему такие платежи неразличимы.
            "counter_account": (recv if outgoing else payer) or "",
            "purpose": re.sub(r"\s+", " ", x.get("НазначениеПлатежа", "")).strip(),
        })

    bal = []
    for b in balances:
        if not b.get("ДатаНачала"):
            continue
        num = lambda k: float((b.get(k) or "0").replace(",", "."))
        bal.append({"date": d(b["ДатаНачала"]), "account": b.get("РасчСчет", ""),
                    "opening": num("НачальныйОстаток"), "debit": num("ВсегоСписано"),
                    "credit": num("ВсегоПоступило"), "closing": num("КонечныйОстаток")})
    return tx, bal, accounts


def сверить_дни(tx, bal):
    """Сверяет разобранные платежи с итогами, объявленными самим банком.

    В выписке 1С у каждого дня есть четыре числа: остаток на начало, всего
    списано, всего поступило, остаток на конец. Проверяем две вещи.

    **Первая — сходится ли день у самого банка:** начало + поступило − списано
    обязано дать конец. Это арифметика банка, и она почти всегда верна; ловим
    на случай битого файла.

    **Вторая, и ради неё всё затевалось: сходится ли НАШ разбор с итогами
    банка.** Складываем разобранные платежи дня и сравниваем с «всего списано»
    и «всего поступило». Разошлось — значит часть операций не разобралась,
    и вот это молча не увидеть никак: суммы просто станут меньше правды,
    а выглядеть будут нормально.

    ⚠️ Такой проверки не было до 16.08.2026, хотя данные для неё лежали
    в выписках с мая 2024. Владелец спросила, видим ли мы остаток на начало
    дня, — оказалось, что видим, разбираем и нигде не используем.

    Молчит, когда всё сошлось: ежедневный «✅» приучает не читать вывод.
    """
    from collections import defaultdict
    по_дням = defaultdict(lambda: [0.0, 0.0])
    for r in tx:
        по_дням[(r["account"], r["date"])][0 if r["direction"] == "out" else 1] += r["amount"]

    расхождения = []
    for b in bal:
        списано, поступило = по_дням.get((b["account"], b["date"]), [0.0, 0.0])
        свои = b["opening"] + b["credit"] - b["debit"] - b["closing"]
        if abs(свои) > 0.01:
            расхождения.append((b, "у банка не сходится начало с концом", свои))
        if abs(списано - b["debit"]) > 0.01:
            расхождения.append((b, f"списано: мы разобрали {списано:,.2f}, "
                                   f"банк объявил {b['debit']:,.2f}", списано - b["debit"]))
        if abs(поступило - b["credit"]) > 0.01:
            расхождения.append((b, f"поступило: мы разобрали {поступило:,.2f}, "
                                   f"банк объявил {b['credit']:,.2f}", поступило - b["credit"]))

    if not расхождения:
        return
    print(f"\n⚠️  ДЕНЬ НЕ СХОДИТСЯ С ВЫПИСКОЙ: {len(расхождения)} случаев")
    print("   Это значит, что часть операций не разобралась и расходы занижены.")
    for b, что, разница in sorted(расхождения, key=lambda x: -abs(x[2]))[:15]:
        print(f"   {b['date']}  счёт …{b['account'][-4:]}  {что}"
              .replace(",", " "))
    # переписывает таблицы целиком, поэтому получать он должен весь набор
    # сразу — папка это гарантирует, в отличие от «Загрузок», где выписки
    # лежат вперемешку со всем остальным и одну легко забыть.
    files = sys.argv[1:]
    if not files:
        inbox = OUT / "выписки"
        files = sorted(str(p) for p in inbox.glob("*.txt")) + \
                sorted(str(p) for p in inbox.glob("*.zip"))
        if not files:
            raise SystemExit(f"В папке {inbox} нет выписок, и файлы не переданы.\n{__doc__}")
        print(f"Беру все выписки из {inbox}\n")

    tx, bal = [], []
    for p in files:
        t, b, accs = parse(read_text(p))
        print(f"{Path(p).name}: счета {', '.join(accs) or '—'}, платежей {len(t)}, дней {len(b)}")
        tx += t
        bal += b

    # Выписки за разные периоды перекрываются: одна за май–август, другая за
    # июль. Без отсева один и тот же платёж попал бы в расходы дважды.
    # Ключ — счёт + дата + номер документа + сумма + направление.
    seen, uniq, dups = set(), [], 0
    for r in tx:
        key = (r["account"], str(r["date"]), r["doc_no"], round(r["amount"], 2), r["direction"])
        if key in seen:
            dups += 1
            continue
        seen.add(key)
        uniq.append(r)
    tx = uniq

    seen_b, uniq_b = set(), []
    for b in bal:
        key = (b["account"], str(b["date"]))
        if key in seen_b:
            continue
        seen_b.add(key)
        uniq_b.append(b)
    bal = uniq_b

    if dups:
        print(f"отсеяно повторов (тот же платёж в двух выписках): {dups}")

    tx.sort(key=lambda r: (r["date"], r["doc_no"]))
    bal.sort(key=lambda r: r["date"])
    сверить_дни(tx, bal)
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "bank_transactions.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, ["date", "account", "counter_account", "doc_no", "direction", "amount",
                               "counterparty", "inn", "purpose"])
        w.writeheader(); w.writerows(tx)
    with open(OUT / "bank_balances.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, ["date", "account", "opening", "debit", "credit", "closing"])
        w.writeheader(); w.writerows(bal)

    from collections import defaultdict
    M = lambda v: f"{v:,.0f}".replace(",", " ")
    m_out, m_in, n = defaultdict(float), defaultdict(float), defaultdict(int)
    for r in tx:
        k = (r["date"].year, r["date"].month)
        (m_out if r["direction"] == "out" else m_in)[k] += r["amount"]
        n[k] += 1
    print(f"\n{'месяц':<10}{'поступило':>15}{'списано':>15}{'платежей':>10}{'остаток на конец':>19}")
    print("─" * 69)
    for k in sorted(set(m_out) | set(m_in)):
        # остаток на конец месяца — сумма по всем счетам, по последней дате каждого
        per_acc = {}
        for b in bal:
            if (b["date"].year, b["date"].month) == k:
                cur = per_acc.get(b["account"])
                if cur is None or b["date"] > cur["date"]:
                    per_acc[b["account"]] = b
        cl = M(sum(b["closing"] for b in per_acc.values())) if per_acc else "—"
        print(f"{k[1]:02d}.{k[0]:<7}{M(m_in[k]):>15}{M(m_out[k]):>15}{n[k]:>10}{cl:>19}")
    print("─" * 69)
    print(f"{'ИТОГО':<10}{M(sum(m_in.values())):>15}{M(sum(m_out.values())):>15}{len(tx):>10}")


if __name__ == "__main__":
    main()
