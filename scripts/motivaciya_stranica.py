#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Считалка мотивации кальянного бара — локальная страничка.

Задача владельца 06.09.2026: кальянщики продают разные типы кальянов,
и за каждый тип положена доплата — рубли за штуку. Мотивация ОБЩАЯ НА СМЕНУ,
не личная. За нулевые позиции (прокур, перезабивка, чашка главного)
и за простой кальян на чаше мотивации нет.

Страничка нужна, чтобы ставки можно было вписать руками и сразу увидеть,
сколько выходит на живых продажах. Когда цифры устроят — переносим расчёт
в приложение смены отдельной командой.

⚠️ **Откуда продажи.** Состав заказа Quick Resto через API НЕ отдаёт —
`front.orders` возвращает 50 полей, и позиций среди них нет (та же дыра,
про которую написано письмо №3). Поэтому позиции берутся из фискальных
чеков ОФД по кассе ИП Шалаевой: `data/ofd/чеки-бар-*.json`. Это те же
деньги, что в отчёте продаж на экране кассы, — итог сверяется глазами.

⚠️ Возвраты вычитаются: у чека возврата вид = 2, его позиции идут в минус.

Запуск:
    python3 scripts/motivaciya_stranica.py              # август и сентябрь
    python3 scripts/motivaciya_stranica.py 2026-08      # один месяц
"""
from __future__ import annotations

import glob
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ЧЕКИ = ROOT / "data" / "ofd"
СТАВКИ = ROOT / "data" / "мотивация-ставки.json"
# Имя латиницей нарочно: локальный сервер отдаёт кириллические адреса
# с ошибкой, и страница просто не открывается.
СТРАНИЦА = ROOT / "motivaciya-kb.html"
ПОКАЗ = Path("/Users/user/Claude/Projects/Обучение ИИ/просмотр/motivaciya-kb.html")


def продажи(месяцы: list[str]) -> tuple[dict, dict]:
    """(позиция → [штук, сумма]),  (день → позиция → штук)."""
    позиции: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    по_дням: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for месяц in месяцы:
        путь = ЧЕКИ / f"чеки-бар-{месяц}.json"
        if not путь.exists():
            print(f"  ⚠ нет файла чеков за {месяц}: {путь.name}")
            continue
        for чек in json.loads(путь.read_text(encoding="utf-8")):
            знак = -1 if чек.get("вид") == 2 else 1
            день = (чек.get("время") or "")[:10]
            for имя, кол, сумма in чек.get("позиции", []):
                позиции[имя][0] += знак * (кол or 0)
                позиции[имя][1] += знак * (сумма or 0)
                по_дням[день][имя] += знак * (кол or 0)
    return позиции, по_дням


def выплачено() -> dict[str, float]:
    """Сколько мотивации реально выдали — из наличной таблицы, по дням."""
    import csv
    было: dict[str, float] = defaultdict(float)
    файл = ROOT / "data" / "dds" / "cash_expenses.csv"
    if not файл.exists():
        return было
    for строка in csv.DictReader(файл.open(encoding="utf-8")):
        if "Мотивация КБ" in строка["column"]:
            было[строка["date"]] += float(строка["amount"])
    return было


# Ставки владельца 06.09.2026: рубли за штуку, мотивация общая на смену.
# 🔴 За простой кальян на чаше и за нулевые позиции мотивации НЕТ.
СТАВКИ_КАТЕГОРИЙ = {
    "Perfume чаша": 200,
    "Perfume фрукт": 200,
    "Кальян на фрукте": 200,
    "Авторское предложение": 300,
    "Арт-кальян": 400,
    "Фирменный Барвиха": 1000,
    "без мотивации": 0,
}

# Названия авторских миксов в меню. Список открытый: появится новый —
# дописать сюда, иначе он молча уедет в «без мотивации».
АВТОРСКИЕ = ("TROPICANA", "DU BARRY", "BLACK EDITION", "ONE MORE PLEASE",
             "DOLCE VITA")
# 🔴 «ЧМ» — это АРТ-кальян, а не авторское предложение. Владелец 06.09.2026.
# Проверять ДО перфюма: «ЧМ DEUS PERFUME» иначе уедет в «Perfume чаша».
АРТ = ("АРТ-КАЛЬЯН", "ЧМ")
ФРУКТЫ = ("ГРЕЙПФРУТ", "АНАНАС", "ГРАНАТ")


def категория(имя: str) -> str:
    """Позиция кассы → категория мотивации.

    ⚠️ Порядок проверок важен. «Кальян на Грейпфруте PERFUME» — это фрукт
    И перфюм одновременно; ставка у них одна (200 ₽), но разводить их надо,
    чтобы владелец видела раскладку теми же словами, какими её задала.
    """
    в = имя.upper()
    # 🔴 BOSS — служебные позиции, не продажа гостю. Владелец 06.09.2026.
    # Проверять ПЕРВЫМ: «Кальян на чаше PERFUME BOSS» иначе получит 200 ₽
    # как перфюм, хотя стоит 900 и продажей не является.
    if "BOSS" in в:
        return "без мотивации"
    if "ФИРМЕННЫЙ" in в and "БАРВИХА" in в:
        return "Фирменный Барвиха"
    if any(в.startswith(а) for а in АРТ):
        return "Арт-кальян"
    фрукт = any(ф in в for ф in ФРУКТЫ)
    if "PERFUME" in в:
        return "Perfume фрукт" if фрукт else "Perfume чаша"
    if фрукт:
        return "Кальян на фрукте"
    if any(а in в for а in АВТОРСКИЕ):
        return "Авторское предложение"
    return "без мотивации"


def семейство(имя: str) -> str:
    """Грубая склейка в семейства, чтобы ставки не вписывать 97 раз."""
    т = имя.strip()
    for основа in ("Кальян на чаше PERFUME", "Кальян на чаше микс",
                   "Кальян на чаше", "Кальян на Грейпфруте", "Кальян на Ананасе",
                   "Кальян на Гранате", "Арт-кальян", "Фирменный кальян",
                   "Кальян BOSS", "Переделка", "Перезабивка", "ОСНОВА", "Прокур",
                   "Чашка главного", "МИКС", "СОЛО"):
        if т.startswith(основа):
            return основа
    return т.split()[0] if т.split() else "прочее"


def собрать(месяцы: list[str]) -> Path:
    позиции, по_дням = продажи(месяцы)
    if not позиции:
        sys.exit("✗ Продаж не нашлось — проверьте файлы чеков в data/ofd/")
    ставки = json.loads(СТАВКИ.read_text(encoding="utf-8")) if СТАВКИ.exists() else {}

    строки = []
    for имя, (кол, сумма) in sorted(позиции.items(), key=lambda x: -x[1][1]):
        строки.append({
            "имя": имя,
            "семья": семейство(имя),
            "штук": round(кол, 2),
            "сумма": round(сумма, 2),
            "цена": round(сумма / кол, 0) if кол else 0,
            "категория": категория(имя),
            "ставка": ставки.get(имя, СТАВКИ_КАТЕГОРИЙ[категория(имя)]),
        })
    дни = {д: dict(п) for д, п in sorted(по_дням.items())}

    данные = json.dumps(
        {"позиции": строки, "дни": дни, "выплачено": выплачено(), "месяцы": месяцы},
        ensure_ascii=False)
    СТРАНИЦА.write_text(ШАБЛОН.replace("/*ДАННЫЕ*/", данные), encoding="utf-8")

    # ⚠️ Копия для показа. Локальный сервер, которым открывается страница,
    # папку «Документы» читать не может — песочница не пускает, и воевать
    # с ней ради одной странички дороже, чем положить копию рядом.
    # Хозяин файла — проект; в папке показа лежит именно копия.
    if ПОКАЗ.parent.exists():
        ПОКАЗ.parent.mkdir(exist_ok=True)
        ПОКАЗ.write_text(СТРАНИЦА.read_text(encoding="utf-8"), encoding="utf-8")
    return СТРАНИЦА


ШАБЛОН = r"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Мотивация кальянного бара</title>
<style>
 :root{--фон:#14110f;--карточка:#1d1916;--текст:#efe7dd;--тихо:#a89a8c;
       --линия:#332b25;--акцент:#d8b678;--плюс:#6fbf73;--минус:#e07a5f}
 *{box-sizing:border-box}
 body{margin:0;background:var(--фон);color:var(--текст);
      font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
 h1{font-size:22px;margin:0 0 4px} .тихо{color:var(--тихо);font-size:13px}
 .полосой{display:flex;gap:16px;flex-wrap:wrap;margin:18px 0}
 .карточка{background:var(--карточка);border:1px solid var(--линия);
           border-radius:10px;padding:14px 18px;min-width:190px}
 .карточка .число{font-size:24px;font-weight:600;margin-top:4px}
 .сетка{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start}
 @media(max-width:1100px){.сетка{grid-template-columns:1fr}}
 table{border-collapse:collapse;width:100%;font-size:14px}
 th,td{padding:6px 8px;border-bottom:1px solid var(--линия);text-align:right}
 th:first-child,td:first-child{text-align:left}
 th{color:var(--тихо);font-weight:500;position:sticky;top:0;background:var(--фон)}
 .прокрутка{max-height:60vh;overflow:auto;border:1px solid var(--линия);border-radius:10px}
 input{width:78px;background:#0e0c0b;color:var(--акцент);border:1px solid var(--линия);
       border-radius:6px;padding:4px 6px;text-align:right;font:inherit}
 input:focus{outline:1px solid var(--акцент)}
 .ноль td{color:#6d6157}
 .кнопка{background:var(--акцент);color:#1b1409;border:0;border-radius:8px;
         padding:9px 16px;font:inherit;font-weight:600;cursor:pointer}
 .кнопка.тихая{background:transparent;color:var(--акцент);border:1px solid var(--акцент)}
 .плюс{color:var(--плюс)} .минус{color:var(--минус)}
 details{margin-top:8px} summary{cursor:pointer;color:var(--тихо)}
</style></head><body>
<h1>Мотивация кальянного бара</h1>
<div class="тихо">Ставка — рубли за штуку. Мотивация общая на смену.
 Продажи — из фискальных чеков кассы ИП Шалаевой, возвраты вычтены.</div>

<div class="полосой">
  <div class="карточка"><div class="тихо">Продано кальянов</div><div class="число" id="штук">—</div></div>
  <div class="карточка"><div class="тихо">Выручка бара</div><div class="число" id="выручка">—</div></div>
  <div class="карточка"><div class="тихо">Мотивация по ставкам</div><div class="число" id="мотивация">—</div></div>
  <div class="карточка"><div class="тихо">Платили на самом деле</div><div class="число" id="платили">—</div></div>
  <div class="карточка"><div class="тихо">Разница</div><div class="число" id="разница">—</div></div>
</div>

<div class="сетка">
 <div>
  <h2 style="font-size:16px">Типы кальянов и ставки</h2>
  <div class="тихо">Впишите рубли за штуку. Пусто или ноль — мотивации нет.</div>
  <div class="прокрутка"><table id="типы"><thead><tr>
    <th>позиция</th><th>категория</th><th>штук</th><th>цена</th><th>ставка ₽</th><th>итого</th>
  </tr></thead><tbody></tbody></table></div>
  <div style="margin-top:12px;display:flex;gap:10px">
    <button class="кнопка" onclick="сохранить()">Сохранить ставки</button>
    <button class="кнопка тихая" onclick="обнулить()">Обнулить всё</button>
  </div>
  <div class="тихо" id="сообщение" style="margin-top:8px"></div>
 </div>
 <div>
  <h2 style="font-size:16px">По дням смены</h2>
  <div class="тихо">Столько бар заработал бы мотивации за каждый вечер.</div>
  <div class="прокрутка"><table id="дни"><thead><tr>
    <th>день</th><th>кальянов</th><th>по ставкам</th><th>платили</th><th>разница</th>
  </tr></thead><tbody></tbody></table></div>
 </div>
</div>

<script>
const Д = /*ДАННЫЕ*/;
const руб = n => (Math.round(n)).toLocaleString('ru-RU') + ' ₽';
const ставки = {};
Д.позиции.forEach(п => ставки[п.имя] = п.ставка || 0);
try { Object.assign(ставки, JSON.parse(localStorage.getItem('ставки') || '{}')); } catch(e) {}

function строкиТипов() {
  const tb = document.querySelector('#типы tbody'); tb.innerHTML = '';
  Д.позиции.forEach(п => {
    const tr = document.createElement('tr');
    if (!п.сумма) tr.className = 'ноль';
    tr.innerHTML = `<td title="${п.имя}">${п.имя}</td>
      <td class="тихо" style="font-size:12px">${п.категория === 'без мотивации' ? '—' : п.категория}</td>
      <td>${п.штук.toLocaleString('ru-RU')}</td>
      <td>${руб(п.цена)}</td>
      <td><input type="number" min="0" step="10" value="${ставки[п.имя]||''}"
           data-имя="${п.имя}"></td>
      <td class="итого">—</td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('input').forEach(i => i.addEventListener('input', () => {
    ставки[i.dataset.имя] = Number(i.value) || 0; посчитать();
  }));
}

function посчитать() {
  let штук = 0, выручка = 0, мотивация = 0;
  document.querySelectorAll('#типы tbody tr').forEach((tr, i) => {
    const п = Д.позиции[i], с = ставки[п.имя] || 0;
    штук += п.штук; выручка += п.сумма;
    const итог = п.штук * с; мотивация += итог;
    tr.querySelector('.итого').textContent = итог ? руб(итог) : '—';
  });
  const платили = Object.values(Д.выплачено).reduce((a, b) => a + b, 0);
  document.getElementById('штук').textContent = Math.round(штук).toLocaleString('ru-RU');
  document.getElementById('выручка').textContent = руб(выручка);
  document.getElementById('мотивация').textContent = руб(мотивация);
  document.getElementById('платили').textContent = руб(платили);
  const р = мотивация - платили;
  const эл = document.getElementById('разница');
  эл.textContent = (р >= 0 ? '+' : '') + руб(р);
  эл.className = 'число ' + (р >= 0 ? 'плюс' : 'минус');

  const tb = document.querySelector('#дни tbody'); tb.innerHTML = '';
  Object.entries(Д.дни).forEach(([день, поз]) => {
    let кол = 0, сум = 0;
    Object.entries(поз).forEach(([имя, к]) => { кол += к; сум += к * (ставки[имя] || 0); });
    const было = Д.выплачено[день] || 0, раз = сум - было;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${день.slice(8)}.${день.slice(5,7)}</td>
      <td>${Math.round(кол)}</td><td>${сум ? руб(сум) : '—'}</td>
      <td>${было ? руб(было) : '—'}</td>
      <td class="${раз >= 0 ? 'плюс' : 'минус'}">${сум || было ? (раз>=0?'+':'')+руб(раз) : '—'}</td>`;
    tb.appendChild(tr);
  });
}

function сохранить() {
  localStorage.setItem('ставки', JSON.stringify(ставки));
  const текст = JSON.stringify(ставки, null, 1);
  navigator.clipboard?.writeText(текст);
  document.getElementById('сообщение').textContent =
    'Ставки сохранены в браузере и скопированы. Пришлите их мне — положу в проект.';
}
function обнулить() {
  Object.keys(ставки).forEach(k => ставки[k] = 0);
  document.querySelectorAll('#типы input').forEach(i => i.value = '');
  посчитать();
}
строкиТипов(); посчитать();
</script></body></html>
"""


if __name__ == "__main__":
    месяцы = sys.argv[1:] or ["2026-08", "2026-09"]
    if any(not re.fullmatch(r"\d{4}-\d{2}", м) for м in месяцы):
        sys.exit("Месяц пишется как 2026-08")
    путь = собрать(месяцы)
    print(f"✓ страница собрана: {путь}")
    print("  открыть:  open '" + str(путь) + "'")
