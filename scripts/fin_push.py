#!/usr/bin/env python3
"""Отправляет разобранные финансы в бэк-офис. План: plans/2026-08-15-razdel-finansy.md

⚠️ **Зачем через сеть, а не прямо в базу.** С этого компьютера до боевой базы
не достучаться: VPN incy перехватывает соединения на порт 5432, пробовали
04.08.2026 и не обошли. Открывать базе внешний доступ нельзя — в ней фамилии
и заработки 17 человек, дверь закрыли 14.08.2026.

Поэтому разбор делается здесь, а запись — в бэк-офисе: он с базой в одном
дата-центре. Тот же приём год работает на QR-чаевых.

⚠️ **Ключ повтора считает НЕ этот скрипт, а бэк-офис.** Отправляй одно и то же
хоть десять раз — в базе оно будет один раз. Так нарочно: правило защиты
от удвоения должно жить рядом с ограничением, которое его держит, а не здесь,
где ошибку никто не проверит.

Запуск:
    python3 scripts/fin_push.py                 # весь август текущего года
    python3 scripts/fin_push.py 2026-07         # конкретный месяц
    python3 scripts/fin_push.py --всё           # всё, что есть
    python3 scripts/fin_push.py --что-там       # только спросить состояние

Адрес и ключ берутся из `.env`: OFFICE_URL и FINANCE_KEY.
"""

from __future__ import annotations

import calendar
import csv
import json
import re
import os
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DDS = ROOT / "data" / "dds"
АДРЕС_ПО_УМОЛЧАНИЮ = "https://nevsky-office-borzovavv.amvera.io"


def из_env(имя: str, запасное: str = "") -> str:
    """Читает .env проекта. Кладём туда же, где остальные ключи."""
    if значение := os.environ.get(имя):
        return значение
    файл = ROOT / ".env"
    if файл.exists():
        for строка in файл.read_text(encoding="utf-8").splitlines():
            строка = строка.strip()
            if строка.startswith(f"{имя}="):
                return строка.split("=", 1)[1].strip().strip('"').strip("'")
    return запасное


def запрос(путь: str, тело: dict | None = None) -> dict:
    адрес = из_env("OFFICE_URL", АДРЕС_ПО_УМОЛЧАНИЮ).rstrip("/") + путь
    ключ = из_env("FINANCE_KEY")
    if not ключ:
        sys.exit(
            "✗ Не задан FINANCE_KEY.\n"
            "  Это ключ на ЗАПИСЬ в финансовый учёт, отдельный от EXPORT_KEY.\n"
            "  Одно и то же значение нужно в двух местах: в .env проекта\n"
            "  и в переменных приложения nevsky-office в панели Amvera."
        )

    данные = json.dumps(тело, ensure_ascii=False).encode("utf-8") if тело else None
    req = urllib.request.Request(
        адрес,
        data=данные,
        method="POST" if тело else "GET",
        headers={"X-Finance-Key": ключ, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as ответ:
            return json.loads(ответ.read())
    except urllib.error.HTTPError as e:
        подробности = e.read().decode("utf-8", errors="replace")
        try:
            причина = json.loads(подробности).get("причина", подробности)
        except json.JSONDecodeError:
            причина = подробности[:300]
        sys.exit(f"✗ Бэк-офис ответил {e.code}: {причина}")
    except urllib.error.URLError as e:
        sys.exit(f"✗ Не достучался до бэк-офиса: {e.reason}")


def банковские(месяц: str | None) -> list[dict]:
    """Платежи из bank_classified.csv, со статьёй расхода.

    ⚠️ **Статью считаем здесь, а не в бэк-офисе, и это принципиально.**
    В `bank_classified.csv` колонки со статьёй нет вовсе: статья выводится
    на лету функцией `article()` из `fin_articles.py` — по словарю ключевых
    слов, по назначению платежа и по решениям владельца в словаре `OWNER`.

    Написать эти правила заново на TypeScript означало бы завести им вторую
    копию, на другом языке. Проект уже держит две копии правил деления
    чаевых и платит за это проверкой `npm run copies`; третью такой проверкой
    не накрыть, и она разошлась бы молча — в деньгах.

    Поэтому статья едет готовым словом, а бэк-офис показывает присланное
    и ничего не вычисляет.
    """
    файл = DDS / "bank_classified.csv"
    if not файл.exists():
        sys.exit(f"✗ Нет {файл}. Сначала: python3 scripts/fin_classify.py")

    sys.path.insert(0, str(ROOT / "scripts"))
    from fin_articles import article, build_dictionary  # noqa: E402

    словарь = build_dictionary()

    строки = []
    for r in csv.DictReader(файл.open(encoding="utf-8")):
        день = r.get("date", "")
        if месяц and not день.startswith(месяц):
            continue
        # Статья есть только у внешних расходов. У поступлений и внутренних
        # переводов её не бывает — и подставлять туда «Прочее» нельзя:
        # в сводке по статьям они раздули бы расход на свою сумму.
        статья = None
        if r.get("direction") == "out" and r.get("class") == "external":
            статья = article(r, словарь)[0]
        строки.append({
            "day": день,
            "source": "bank",
            "entity": r.get("entity") or None,
            "account": r.get("account") or None,
            "direction": r.get("direction") or "out",
            "amount": float(r.get("amount") or 0),
            "counterparty": r.get("counterparty") or None,
            "article": статья,
            "opClass": r.get("class") or None,
            "purpose": r.get("purpose") or None,
            "docNo": r.get("doc_no") or None,
            "why": r.get("why") or None,
        })
    return строки


def эквайринг(месяц: str | None) -> list[dict]:
    """Комиссия банка за приём карт — по дням.

    ⚠️ **Отдельным платежом она не приходит.** Банк удерживает её из зачисления:
    на счёт падает уже за вычетом, и в расходах её нет вовсе. Поэтому статью
    «Комиссия» приходится пополнять отдельно — так же делает `fin_articles.py`
    функцией `acquiring()`.

    Обнаружено 15.08.2026: расходы июля на экране разошлись с «Фин. сводом»
    ровно на 308 116,11 ₽ — это и оказалась она.

    Раскладываем по дням, а не одной строкой за месяц: ДДС ради дневного
    ритма и выбран, а месячный ком его бы сломал.
    """
    # ⚠️ Читаем размеченный файл, а не bank_transactions.csv, хотя `acquiring()`
    # в fin_articles читает именно его. Причина: в неразмеченном нет колонки
    # юрлица, и 15.08.2026 комиссия уехала на экране в отдельную группу
    # «юрлицо неизвестно». Строки в обоих файлах одни и те же — самопроверка
    # ниже это и подтверждает, сверяя итог с `acquiring()`.
    файл = DDS / "bank_classified.csv"
    if not файл.exists():
        return []

    строки = []
    for r in csv.DictReader(файл.open(encoding="utf-8")):
        день = r.get("date", "")
        if месяц and not день.startswith(месяц):
            continue
        if r.get("direction") != "in" or "эквайринг" not in (r.get("purpose") or "").lower():
            continue
        for m in re.finditer(r"Комиссия\s+([\d\s ]+[.,]\d+|[\d\s ]+)", r["purpose"]):
            сумма = float(m.group(1).replace(" ", "").replace(" ", "").replace(",", "."))
            строки.append({
                "day": день,
                "source": "bank",
                "entity": r.get("entity") or None,
                "account": r.get("account") or None,
                "direction": "out",
                "amount": сумма,
                "counterparty": "Сбербанк — эквайринг",
                "article": "Комиссия",
                "opClass": "external",
                "purpose": None,
                # Номер помечен, чтобы ключ повтора не столкнулся с самим
                # зачислением: у него тот же счёт, день и номер документа.
                "docNo": f"{r.get('doc_no') or ''}-эквайринг",
                "why": "удержана банком из зачисления, отдельным платежом не приходит",
            })
    return строки


def наличные(месяц: str | None) -> list[dict]:
    """Наличные расходы из Google-таблицы «Выручка Невский 2026».

    ⚠️ Решение владельца 15.08.2026: таблицу ведём дальше, как есть. Значит
    у раздела два источника с разной свежестью — и это надо показывать честно,
    отметкой filledTo, а не смешивать молча.
    """
    файл = DDS / "cash_expenses.csv"
    if not файл.exists():
        return []

    строки = []
    for r in csv.DictReader(файл.open(encoding="utf-8")):
        день = r.get("date", "")
        if месяц and not день.startswith(месяц):
            continue
        строки.append({
            "day": день,
            "source": "cash",
            "entity": None,
            "account": None,
            "direction": "out",
            "amount": float(r.get("amount") or 0),
            # «Столбец» таблицы — это и есть указание, кому и за что.
            # Своего поля контрагента там нет.
            "counterparty": r.get("column") or None,
            "article": r.get("category") or None,
            # Наличный расход всегда настоящий: перекладывать наличные между
            # своими счетами нечем, счёт у них один — общая касса.
            "opClass": "external",
            "purpose": None,
            "docNo": None,
            "why": None,
        })
    return строки


def дни(месяц: str | None) -> list[dict]:
    """Выручка, чеки и остаток по дням — верхний блок формы ДДС.

    ⚠️ **Выручку берём из касс, а не из Google-таблицы.** Так же делают
    «Фин. свод» (`revenue_by_month` в fin_classify.py) и отчёт по чаевым.
    Взять её из таблицы значило бы завести третий ответ на вопрос «сколько
    заведение заработало», и однажды три ответа разошлись бы.

    ⚠️ **Касс две, и складывать надо обе.** С 07.07.2026 работают ООО «МАВ»
    и ИП Шалаева, у каждой своё облако Quick Resto. Взять одну — занизить
    выручку почти вдвое.

    Остаток на счетах — из наличной таблицы: в кассах его нет.
    """
    собрано: dict[str, dict] = {}

    for имя in ("qr_sales_mav.csv", "qr_sales_shalaeva.csv"):
        файл = DDS / имя
        if not файл.exists():
            continue
        for r in csv.DictReader(файл.open(encoding="utf-8")):
            день = r.get("date", "")
            if not день or (месяц and not день.startswith(месяц)):
                continue
            д = собрано.setdefault(день, {
                "day": день, "revenueCash": 0.0, "revenueCard": 0.0,
                "tablesCount": None, "checksCount": 0, "balanceTotal": None,
            })
            # ⚠️ Возвраты НЕ вычитаем: `qr_sales.py` уже вычел их, когда писал
            # эти колонки (`cash = totalCash − totalReturnCash`, так же
            # и `cashless`). То есть здесь уже «Выручка» Quick Resto,
            # а не «Сумма продаж».
            #
            # ⚠️ И колонка `returns` — это КОЛИЧЕСТВО возвратных заказов
            # (`returnOrdersCount`), а не сумма. 15.08.2026 я вычел её из
            # рублей: получилось вычитание штук из денег, и выручка августа
            # ушла на 214 ₽ вниз. Поймано сверкой с `report_revenue.py`,
            # который считает то же самое живым запросом к кассе.
            д["revenueCash"] += float(r.get("cash") or 0)
            д["revenueCard"] += float(r.get("cashless") or 0)
            д["checksCount"] += int(float(r.get("checks") or 0))

    файл = DDS / "cash_daily.csv"
    if файл.exists():
        for r in csv.DictReader(файл.open(encoding="utf-8")):
            день = r.get("date", "")
            if not день or (месяц and not день.startswith(месяц)):
                continue
            д = собрано.setdefault(день, {
                "day": день, "revenueCash": None, "revenueCard": None,
                "tablesCount": None, "checksCount": None, "balanceTotal": None,
            })
            д["balanceTotal"] = float(r["balance"]) if r.get("balance") else None

    return list(собрано.values())


# Какая касса какому юрлицу принадлежит.
#
# ⚠️ Ключи те же, что у банковских операций (`entity` в bank_classified.csv),
# иначе экран покажет одно и то же юрлицо дважды: расходы под «mav», выручку
# под каким-нибудь «ООО МАВ». Совпадение ключей здесь — не мелочь оформления,
# а условие, при котором две половины таблицы вообще сходятся.
КАССЫ = {
    "qr_sales_mav.csv": "mav",
    "qr_sales_shalaeva.csv": "ip_shalaeva",
}


def выручка_по_юрлицам(месяц: str | None) -> list[dict]:
    """Та же выручка, что в `дни()`, но врозь по юрлицам.

    Нужна экрану месяца: владелец 16.08.2026 попросила видеть доходы и расходы
    в разбивке по юрлицам, накопительным итогом.

    ⚠️ Считается из тех же файлов и теми же правилами, что общий итог в `дни()`,
    нарочно. Завести здесь свой способ счёта значило бы получить второй ответ
    на вопрос «сколько заработали», и однажды два ответа разошлись бы. Экран
    их и не складывает: итог берёт из `days`, разбивку отсюда, и расхождение
    покажет, а не спрячет.
    """
    собрано: dict[tuple[str, str], dict] = {}

    for имя, юрлицо in КАССЫ.items():
        файл = DDS / имя
        if not файл.exists():
            continue
        for r in csv.DictReader(файл.open(encoding="utf-8")):
            день = r.get("date", "")
            if not день or (месяц and not день.startswith(месяц)):
                continue
            з = собрано.setdefault((день, юрлицо), {
                "day": день, "entity": юрлицо,
                "revenueCash": 0.0, "revenueCard": 0.0, "checksCount": 0,
            })
            # Возвраты уже вычтены в qr_sales.py, а `returns` — количество
            # заказов, а не рубли. Подробнее в `дни()`.
            з["revenueCash"] += float(r.get("cash") or 0)
            з["revenueCard"] += float(r.get("cashless") or 0)
            з["checksCount"] += int(float(r.get("checks") or 0))

    return list(собрано.values())


def докуда(строки: list[dict], источник: str) -> str | None:
    """Последний день, за который у источника вообще есть данные."""
    дни_ = [с["day"] for с in строки if с["source"] == источник and с["day"]]
    return max(дни_) if дни_ else None


def main() -> None:
    if "--что-там" in sys.argv:
        с = запрос("/api/finance/import")
        print("Бэк-офис знает:")
        print(f"  платежей: {с['операций']}")
        print(f"  дней:     {с['дней']}")
        print(f"  период:   {с['первыйДень'] or '—'} — {с['последнийДень'] or '—'}")
        for и in с["источники"]:
            print(f"  {и['source']}: заполнено по {и['filledTo']}")
        return

    месяцы = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--всё" in sys.argv:
        месяц = None
    elif месяцы:
        месяц = месяцы[0]
    else:
        месяц = date.today().strftime("%Y-%m")

    экв = эквайринг(месяц)
    # Самопроверка, которая умеет не сойтись: раскладка по дням обязана дать
    # ровно тот же итог, что и `acquiring()` в fin_articles. Разошлось —
    # значит одна из двух читалок назначения платежа неверна, и молча
    # отправлять такое нельзя.
    if месяц and экв:
        sys.path.insert(0, str(ROOT / "scripts"))
        from fin_articles import acquiring
        должно = round(acquiring(месяц), 2)
        вышло = round(sum(с["amount"] for с in экв), 2)
        if должно != вышло:
            sys.exit(
                f"✗ Эквайринг по дням даёт {вышло:,.2f}, а по месяцу {должно:,.2f}.\n"
                "  Отправлять не буду: расхождение значит, что назначение платежа\n"
                "  читается двумя способами по-разному."
            )

    операции = банковские(месяц) + экв + наличные(месяц)
    список_дней = дни(месяц)
    по_юрлицам = выручка_по_юрлицам(месяц)

    # Самопроверка того же рода, что у эквайринга: разбивка по юрлицам обязана
    # дать ровно тот же итог, что общая выручка в `дни()`. Разошлось — значит
    # одна касса попала в один список и не попала в другой, и экран показал бы
    # разбивку, которая не складывается в собственный итог.
    итог_общий = round(sum((д.get("revenueCash") or 0) + (д.get("revenueCard") or 0)
                           for д in список_дней), 2)
    итог_врозь = round(sum(в["revenueCash"] + в["revenueCard"] for в in по_юрлицам), 2)
    if итог_общий != итог_врозь:
        sys.exit(
            f"✗ Выручка по юрлицам даёт {итог_врозь:,.2f}, а всего {итог_общий:,.2f}.\n"
            "  Отправлять не буду: разбивка не сходится с итогом, и экран\n"
            "  показал бы состав, который не складывается в целое."
        )

    что = месяц or "всю историю"
    print(f"Отправляю за {что}: платежей {len(операции)}, дней {len(список_дней)},"
          f" выручка врозь по {len({в['entity'] for в in по_юрлицам})} юрлицам")
    if not операции and not список_дней:
        sys.exit("✗ Отправлять нечего. Проверьте, что данные за этот период разобраны.")

    отметки = {}
    for источник in ("bank", "cash"):
        if д := докуда(операции, источник):
            отметки[источник] = д

    # ⚠️ Наличные просим ЗАМЕНИТЬ за период, а не дописать. Владелец
    # 15.08.2026: касса перепроверяется руками раз в 7–10 дней, и суммы
    # при перепроверке исправляются. Дописывание оставило бы старую неверную
    # строку рядом с новой, и расход дня вырос бы молча.
    #
    # Границы берём по календарю месяца, а не по присланным строкам: если
    # в таблице строку УДАЛИЛИ, её дня в пачке не будет вовсе — а стереть
    # её всё равно надо.
    тело = {"operations": операции, "days": список_дней,
            "revenue": по_юрлицам, "filledTo": отметки}
    if месяц:
        год, мес = (int(x) for x in месяц.split("-"))
        последний = calendar.monthrange(год, мес)[1]
        тело["replace"] = {
            "source": "cash",
            "from": f"{месяц}-01",
            "to": f"{месяц}-{последний:02d}",
        }
    else:
        # Отправляем всё — значит и наличные все, замена за весь срок.
        тело["replace"] = {"source": "cash", "from": "2000-01-01", "to": "2099-12-31"}

    итог = запрос("/api/finance/import", тело)

    print(f"\n✓ Принято:  {итог['принято']}")
    print(f"  добавлено: {итог['добавлено']}")
    print(f"  уже было:  {итог['ужеБыло']}")
    if итог.get("убрано"):
        print(f"  наличные заменены: стёрто прежних строк {итог['убрано']}")
    print(f"  дней:      {итог['дней']}")
    if итог.get("выручки") is not None:
        print(f"  выручка по юрлицам: строк {итог['выручки']}")
    for источник, дата in отметки.items():
        print(f"  {источник}: отмечено «заполнено по {дата}»")

    if итог["добавлено"] == 0 and итог["принято"] > 0:
        print("\n💡 Ничего нового — всё это уже было загружено раньше. Так и должно быть.")


if __name__ == "__main__":
    main()
