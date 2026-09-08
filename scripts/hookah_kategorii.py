#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Карта «позиция меню → категория» из отчёта продаж Quick Resto (№808).

🔴 **Зачем она нужна.** До 08.09.2026 категория кальяна угадывалась по словам
в названии: «содержит PERFUME», «начинается с ЧМ». Это работало, пока названия
не начали спорить друг с другом: «Кальян на чаше PERFUME BOSS» — служебная
позиция, а не перфюм, и её пришлось отлавливать отдельным правилом, стоящим
первым. Каждое новое название меню — новая заплатка.

Категорию ставит МЕНЮ, и касса её отдаёт: поле `productCategory` в отчёте.
Девять категорий покрывают все проданные позиции без единого исключения
(проверено на августе 2026: ни одна позиция не осталась без категории).

⚠️ **Отбор по нашему залу обязателен.** Облако баровой кассы общее на сеть:
в отчёте рядом с нашим Невским лежат Митино, Красная площадь и Москва-Сити.
Без отбора мотивация нашей смены посчиталась бы по чужим продажам.

⚠️ Карта — СЛЕПОК: в ней только то, что продавалось за взятый период. Новое
блюдо в меню в ней не появится, пока его хоть раз не продадут. Поэтому строим
её с запасом за весь год и пересобираем, когда встретится незнакомая позиция.

Запуск:
    python3 scripts/hookah_kategorii.py            # пересобрать карту за год
    python3 scripts/hookah_kategorii.py --показать  # что в ней сейчас
"""
from __future__ import annotations

import base64
import json
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

КАРТА = ROOT / "data" / "кальяны-категории.json"
НАШ_ЗАЛ = "Невский"
ОТЧЁТ = 808          # vid из адреса отчёта в кабинете кассы
СМЕНА_НАЧИНАЕТСЯ = 11  # торговые сутки, как во всём проекте


def доступ() -> tuple[str, str]:
    from qr_employees import read_env
    cfg = read_env()
    база = (cfg.get("QR_SHALAEVA_URL") or cfg["QR_URL"]).rstrip("/")
    логин = cfg.get("QR_SHALAEVA_LOGIN") or cfg["QR_LOGIN"]
    пароль = cfg.get("QR_SHALAEVA_PASSWORD") or cfg["QR_PASSWORD"]
    return база, base64.b64encode(f"{логин}:{пароль}".encode()).decode()


def продажи(с: datetime, по: datetime) -> list[dict]:
    """Строки отчёта за период. Только наш зал.

    ⚠️ Это GET **с телом** — формат Quick Resto, не опечатка. И даты в теле
    идут СПИСКАМИ: `[мс]`, а не `мс`. Голое число даёт 400 Bad Request,
    на этом 08.09.2026 потерян первый заход.

    💡 Границы берём с часами, а не по полуночи: отчёт принимает любое время,
    и это позволяет спрашивать ТОРГОВЫЕ сутки. Разница не косметическая —
    за 05.09.2026 календарные сутки дают 102 кальяна, торговые 135.
    """
    база, токен = доступ()
    адрес = (f"{база}/platform/online/api/list"
             f"?moduleName=report.datasources.sales&ownerContextId={ОТЧЁТ}")
    тело = json.dumps({"mode": "dateFilter", "extParams": {
        "dateFrom": [int(с.timestamp() * 1000)],
        "dateTo": [int(по.timestamp() * 1000)]}}).encode()
    запрос = urllib.request.Request(адрес, data=тело, method="GET", headers={
        "Authorization": "Basic " + токен, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(запрос, timeout=120) as ответ:
            строки = json.loads(ответ.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        sys.exit(f"✗ Касса ответила {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
    return [с_ for с_ in строки
            if НАШ_ЗАЛ in ((с_.get("tableScheme") or {}).get("title") or "")]


def собрать(месяцев: int = 12) -> dict:
    по = datetime.now()
    с = по - timedelta(days=31 * месяцев)
    строки = продажи(с, по)
    карта: dict[str, str] = {}
    спор = defaultdict(Counter)
    for стр in строки:
        имя = (стр.get("storeItem") or {}).get("title")
        кат = (стр.get("productCategory") or {}).get("title")
        if not имя or not кат:
            continue
        спор[имя][кат] += 1
        карта[имя] = кат
    # Одна позиция в двух категориях — это меню переезжало. Молчать нельзя:
    # мотивация посчитается по случайной из них.
    двойные = {и: dict(к) for и, к in спор.items() if len(к) > 1}
    return {"обновлено": datetime.now().isoformat(timespec="seconds"),
            "период": f"{с:%Y-%m-%d} … {по:%Y-%m-%d}",
            "категории": карта, "спорные": двойные}


def прочитать() -> dict:
    if not КАРТА.exists():
        sys.exit(f"✗ Нет карты категорий. Соберите: python3 scripts/hookah_kategorii.py")
    return json.loads(КАРТА.read_text(encoding="utf-8"))


def главное() -> None:
    if "--показать" in sys.argv:
        д = прочитать()
        по_кат = defaultdict(list)
        for имя, кат in д["категории"].items():
            по_кат[кат].append(имя)
        print(f"Карта от {д['обновлено']}, период {д['период']}\n")
        for кат in sorted(по_кат):
            print(f"{кат}  ({len(по_кат[кат])} названий)")
            for имя in sorted(по_кат[кат])[:6]:
                print(f"     {имя}")
            if len(по_кат[кат]) > 6:
                print(f"     …ещё {len(по_кат[кат]) - 6}")
        if д.get("спорные"):
            print(f"\n⚠️ Позиции в двух категориях: {д['спорные']}")
        return

    д = собрать()
    КАРТА.write_text(json.dumps(д, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Карта собрана: {len(д['категории'])} названий, "
          f"{len(set(д['категории'].values()))} категорий")
    print(f"  период: {д['период']}")
    if д["спорные"]:
        print(f"  ⚠️ в двух категориях: {д['спорные']}")
    print(f"  файл: {КАРТА.relative_to(ROOT)}")


if __name__ == "__main__":
    главное()
