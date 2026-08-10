#!/usr/bin/env python3
"""Создаёт пустой отчёт по чаевым на месяц.

Порядок листа: сначала сводка, потом детализация. Открыв файл, первым
видишь итоги дня, а не фамилию по алфавиту — решение владельца 08.08.2026.

Блоки детализации сворачиваются: слева от строк стоят кнопки «−/+», как
в обычной группировке Excel. Свернул всё — остался лист-сводка на месяц.

Разбивка по видам денег сохранена, как в приложении: наличные, терминал,
QR и сервисный сбор идут отдельными блоками. Так же, как в рабочей таблице
в ноябре 2025 отдельным блоком появился сервисный сбор.

⚠️ В отчёт попадают только выплаты **в пользу** сотрудника. Вычеты с его
стороны — прежде всего удержание за питание — в отчёт не идут ни блоком,
ни строкой: отчёт про то, сколько заведение начислило людям, а обед
сотрудника к начислению отношения не имеет. Решение владельца 08.08.2026.

Запуск:
    python3 scripts/report_new.py            # текущий месяц
    python3 scripts/report_new.py 2026-09    # конкретный месяц

Заполняется скриптом report_fill.py из выгрузки приложения.
"""

import calendar
import json
import sys
from datetime import date
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from report_path import describe, report_dir

ROOT = Path(__file__).resolve().parent.parent
MONTHS = "январь февраль март апрель май июнь июль август сентябрь октябрь ноябрь декабрь".split()

if len(sys.argv) > 1:
    YEAR, MONTH = (int(x) for x in sys.argv[1].split("-"))
else:
    today = date.today()
    YEAR, MONTH = today.year, today.month

OUT = report_dir() / f"Чаевые-дубль-{MONTHS[MONTH - 1]}-{YEAR}.xlsx"
PEOPLE = json.loads((ROOT / "data" / "employees.json").read_text("utf-8"))

DAYS = calendar.monthrange(YEAR, MONTH)[1]
FIRST = 2
LAST = FIRST + DAYS - 1          # B .. AF при 31 дне
COL_SHIFTS = LAST + 1
COL_TIPS = COL_SHIFTS + 1
COL_SALARY = COL_TIPS + 1
COL_BONUS = COL_SALARY + 1
COL_INCOME = COL_BONUS + 1
COL_AVG = COL_INCOME + 1

FONT = "Arial"
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEAD_FILL = PatternFill("solid", fgColor="D9D9D9")
INPUT_FILL = PatternFill("solid", fgColor="FFFFCC")

wb = Workbook()
ws = wb.active
ws.title = f"{MONTHS[MONTH - 1].capitalize()} {YEAR}"

# Итог группы стоит НАД её строками, а не под ними. Без этого Excel рисует
# кнопку «−» под последней строкой группы, и она оказывается у чужого
# заголовка — свернуть «наличные» можно было бы только кнопкой «терминала».
ws.sheet_properties.outlinePr.summaryBelow = False

ws.cell(1, 1, "Сотрудник")
for i in range(DAYS):
    ws.cell(1, FIRST + i, f"{i + 1:02d}.{MONTH:02d}.{YEAR}").alignment = Alignment(
        horizontal="center"
    )
for col, title in [
    (COL_SHIFTS, "Кол-во смен"),
    (COL_TIPS, "Общий чай за месяц"),
    (COL_SALARY, "Оклад сотрудника (выходы в смену)"),
    (COL_BONUS, "Сумма мотиваций, премий сотрудника"),
    (COL_INCOME, "Итого доход сотрудника:"),
    (COL_AVG, "Средний чай за месяц"),
]:
    ws.cell(1, col, title)
for col in range(1, COL_AVG + 1):
    c = ws.cell(1, col)
    c.font = Font(name=FONT, bold=True, size=9)
    c.fill = HEAD_FILL
    c.border = BORDER
    c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

# ── сводная таблица: строки занимаем сразу, формулы впишем в конце ───────
#
# Порядок строк — от общего к частному: сначала итог, под ним из чего он
# сложился. Разбивка по видам денег убрана под группу: в обычный день
# смотрят одну строку «Общий чай всего», а разложить её можно кнопкой.
#
# Формулы ссылаются на строки блоков, а блоки идут ниже и их границы
# ещё не известны. Поэтому сначала занимаем строки под ярлыки, строим
# блоки, а формулы вписываем последним шагом — номера к тому моменту есть.
SUMMARY_ROWS = [
    # (ярлык, жирный, под группой)
    ("Общий чай всего", True, False),
    ("Чаевые наличные", False, True),
    ("Чаевые терминал", False, True),
    ("Чаевые QR", False, True),
    ("Сервисный сбор", False, True),
    ("Итого распределено", True, False),
    ("Начислено официантам", False, True),
    ("На руки администраторам", False, True),
    ("На руки кассирам", False, True),
    ("На руки хостес", False, True),
    ("Расхождение", True, False),
    ("Выручка", True, False),
    ("% чаевых от выручки", False, False),
]

row = 2
ws.cell(row, 1, "СВОДНАЯ ТАБЛИЦА").font = Font(name=FONT, bold=True, size=10)
for col in range(1, COL_AVG + 1):
    ws.cell(row, col).fill = HEAD_FILL
    ws.cell(row, col).border = BORDER
row += 1

summary: dict[str, int] = {}
for label, bold, grouped in SUMMARY_ROWS:
    ws.cell(row, 1, label).font = Font(name=FONT, bold=bold, size=10)
    ws.cell(row, 1).border = BORDER
    if grouped:
        ws.row_dimensions[row].outlineLevel = 1
    summary[label] = row
    row += 1

row += 1

# ── блоки детализации ───────────────────────────────────────────────────
names = [p["name"] for p in PEOPLE if not p["name"].startswith("Кухня")]
blocks: dict[str, tuple[int, int]] = {}


def block(title: str, people: list[str], spare: int, color: str):
    """Блок: заголовок с итогами, строки сотрудников, запас пустых строк.

    Строки сотрудников уходят на уровень группировки 1 — их сворачивает
    кнопка напротив заголовка. Сам заголовок остаётся виден всегда,
    иначе свёрнутый лист превращается в набор безымянных полос.

    Итог блока стоит в самой строке заголовка, а не отдельной строкой под ним.
    Так в свёрнутом виде каждый блок — одна строка: название и его цифры.
    Отдельная строка «Итого» при этом занимала бы место и в развёрнутом виде,
    и в свёрнутом, ничего не добавляя.
    """
    global row
    fill = PatternFill("solid", fgColor=color)
    ws.cell(row, 1, title).font = Font(name=FONT, bold=True, size=10)
    for col in range(1, COL_AVG + 1):
        ws.cell(row, col).fill = fill
        ws.cell(row, col).border = BORDER
    head = row
    row += 1
    start = row

    for name in people + [""] * spare:
        ws.cell(row, 1, name).font = Font(name=FONT, size=10)
        ws.cell(row, 1).border = BORDER
        for col in range(FIRST, LAST + 1):
            c = ws.cell(row, col)
            c.border = BORDER
            c.number_format = "#,##0"
            c.fill = INPUT_FILL
        LC, LT = get_column_letter(FIRST), get_column_letter(LAST)
        rng = f"{LC}{row}:{LT}{row}"
        ws.cell(row, COL_SHIFTS, f'=COUNTIF({rng},">0")')
        ws.cell(row, COL_TIPS, f"=SUM({rng})")
        ws.cell(row, COL_SALARY).fill = INPUT_FILL
        ws.cell(row, COL_BONUS).fill = INPUT_FILL
        A_T, A_S, A_B = (get_column_letter(c) for c in (COL_TIPS, COL_SALARY, COL_BONUS))
        ws.cell(row, COL_INCOME, f"={A_T}{row}+{A_S}{row}+{A_B}{row}")
        A_SH = get_column_letter(COL_SHIFTS)
        ws.cell(row, COL_AVG, f"=IFERROR({A_T}{row}/{A_SH}{row},0)")
        for col in range(COL_SHIFTS, COL_AVG + 1):
            ws.cell(row, col).border = BORDER
            ws.cell(row, col).number_format = "#,##0"
            ws.cell(row, col).font = Font(name=FONT, size=10)
        ws.row_dimensions[row].outlineLevel = 1
        row += 1

    end = row - 1
    blocks[title] = (start, end)

    # Итоги блока — в строку заголовка, по каждому дню и за месяц.
    # Столбцы «кол-во смен», «оклад», «премии» и «средний чай» намеренно
    # оставлены пустыми: складывать смены и оклады по блоку смысла нет,
    # а число в такой ячейке читалось бы как осмысленное.
    for col in list(range(FIRST, LAST + 1)) + [COL_TIPS]:
        L = get_column_letter(col)
        c = ws.cell(head, col, f"=SUM({L}{start}:{L}{end})")
        c.font = Font(name=FONT, bold=True, size=10)
        c.number_format = "#,##0"

    row += 1


# Деньги от гостей — с разбивкой по видам, как в приложении.
# QR стоит рядом с наличными и терминалом: это такие же чаевые гостя,
# просто пришли не в зале, а по коду на чеке.
GUEST_BLOCKS = {
    "Чаевые наличные": "ОФИЦИАНТЫ · ЧАЕВЫЕ НАЛИЧНЫЕ",
    "Чаевые терминал": "ОФИЦИАНТЫ · ЧАЕВЫЕ ТЕРМИНАЛ",
    "Чаевые QR": "ОФИЦИАНТЫ · ЧАЕВЫЕ QR",
    "Сервисный сбор": "ОФИЦИАНТЫ · СЕРВИСНЫЙ СБОР",
}
block(GUEST_BLOCKS["Чаевые наличные"], names, 6, "FCE4D6")
block(GUEST_BLOCKS["Чаевые терминал"], names, 6, "FBE2D5")
block(GUEST_BLOCKS["Чаевые QR"], names, 6, "FDE9D9")
block(GUEST_BLOCKS["Сервисный сбор"], names, 6, "E4DFEC")

# Кому сколько начислено. Сумма всех этих блоков должна сойтись
# с «Общий чай всего» — за этим следит строка «Расхождение» в сводной.
#
# У официантов блок зовётся «НАЧИСЛЕНО», а не «на руки»: питание из этой
# цифры не вычтено, и поевший получит на руки меньше. У остальных вычитать
# нечего, поэтому там «на руки» — это ровно оно и есть.
PAYOUT_BLOCKS = {
    "Начислено официантам": "ОФИЦИАНТЫ · НАЧИСЛЕНО",
    "На руки администраторам": "АДМИНИСТРАТОРЫ · на руки (доля 20 %)",
    "На руки кассирам": "КАССИРЫ · на руки (доля от 750 ₽)",
    "На руки хостес": "ХОСТЕС · на руки",
}
block(PAYOUT_BLOCKS["Начислено официантам"], names, 6, "D6E9D5")
block(PAYOUT_BLOCKS["На руки администраторам"], [], 6, "DDEBF7")
block(PAYOUT_BLOCKS["На руки кассирам"], [], 4, "E2EFDA")
block(PAYOUT_BLOCKS["На руки хостес"], [], 4, "FFF2CC")

# Кальянный бар — отдельный контур учёта, в зал не входит.
block("КАЛЬЯННЫЙ БАР (отдельный учёт)", ["Котёл кальянного бара"], 0, "EDEDED")

# ── формулы сводной ─────────────────────────────────────────────────────
BOLD_ROWS = {label for label, bold, _ in SUMMARY_ROWS if bold}


def block_sum(col_letter: str, title: str) -> str:
    a, b = blocks[title]
    return f"SUM({col_letter}{a}:{col_letter}{b})"


for col in range(FIRST, LAST + 1):
    L = get_column_letter(col)
    R = summary

    for label, title in GUEST_BLOCKS.items():
        ws.cell(R[label], col, f"={block_sum(L, title)}")
    for label, title in PAYOUT_BLOCKS.items():
        ws.cell(R[label], col, f"={block_sum(L, title)}")

    ws.cell(
        R["Общий чай всего"],
        col,
        "=" + "+".join(f"{L}{R[label]}" for label in GUEST_BLOCKS),
    )
    ws.cell(
        R["Итого распределено"],
        col,
        "=" + "+".join(f"{L}{R[label]}" for label in PAYOUT_BLOCKS),
    )
    ws.cell(
        R["Расхождение"],
        col,
        f"={L}{R['Общий чай всего']}-{L}{R['Итого распределено']}",
    )
    ws.cell(
        R["% чаевых от выручки"],
        col,
        f"=IFERROR({L}{R['Общий чай всего']}/{L}{R['Выручка']},0)",
    )
    for label, r in summary.items():
        c = ws.cell(r, col)
        c.border = BORDER
        c.font = Font(name=FONT, bold=label in BOLD_ROWS, size=10)
        c.number_format = "0.0%" if label == "% чаевых от выручки" else "#,##0"
    ws.cell(R["Выручка"], col).fill = INPUT_FILL
    # Расхождение должно быть нулём — подсвечиваем, если нет.
    ws.cell(R["Расхождение"], col).number_format = '#,##0;[Red]-#,##0;"—"'

for label, r in summary.items():
    if label == "% чаевых от выручки":
        AT = get_column_letter(COL_TIPS)
        ws.cell(r, COL_TIPS, f"=IFERROR({AT}{summary['Общий чай всего']}/{AT}{summary['Выручка']},0)")
        ws.cell(r, COL_TIPS).number_format = "0.0%"
    else:
        ws.cell(r, COL_TIPS, f"=SUM({get_column_letter(FIRST)}{r}:{get_column_letter(LAST)}{r})").number_format = "#,##0"
    ws.cell(r, COL_TIPS).font = Font(name=FONT, bold=True, size=10)
    ws.cell(r, COL_TIPS).border = BORDER

# Замораживаем по нижнюю границу сводной: прокручивая длинный список
# фамилий, итоги дня держим перед глазами. Ради этого сводку и подняли.
ws.freeze_panes = f"B{summary['% чаевых от выручки'] + 1}"
ws.column_dimensions["A"].width = 28
for col in range(FIRST, LAST + 1):
    ws.column_dimensions[get_column_letter(col)].width = 10
for col in range(COL_SHIFTS, COL_AVG + 1):
    ws.column_dimensions[get_column_letter(col)].width = 14
ws.row_dimensions[1].height = 46

# ── лист-легенда ────────────────────────────────────────────────────────
legend = wb.create_sheet("Как заполнять")
for i, (a, b) in enumerate(
    [
        ("Что это", f"Дубль отчёта «Чаевые Таблица учёта Невский» на {MONTHS[MONTH - 1]} {YEAR}."),
        ("", "Собран для проверки формата. На Google Диск не выкладывался."),
        ("", ""),
        ("Как читается лист", "Сверху сводка за каждый день, ниже — детализация по людям."),
        ("", "Сводка закреплена: листаешь фамилии, а итоги дня остаются на экране."),
        ("Группировка", "Слева от строк кнопки «−» и «+». Свернул всё — остался лист-сводка."),
        ("", "Свернуть весь лист разом: кнопка «1» в левом верхнем углу, развернуть — «2»."),
        ("", ""),
        ("Жёлтые ячейки", "Заполняются вручную или выгружаются из приложения."),
        ("Белые ячейки", "Считаются формулами, руками не трогать."),
        ("", ""),
        ("Сколько оставили гости", "Четыре блока официантов: наличные, терминал, QR, сервисный сбор."),
        ("", "Раздельно, как в приложении — иначе не виден эффект от чаевых на терминале."),
        ("Чаевые QR", "Гость платит по коду на чеке. Сбер присылает сумму на котёл («Официант 5»),"),
        ("", "кассир разносит её по людям в приложении — в отчёт приходит уже разнесённое."),
        ("Кто сколько получил", "Четыре блока: официанты, администраторы, кассиры, хостес."),
        ("", "Сумма этих блоков должна сойтись с «Общий чай всего»."),
        ("Почему «начислено»", "У официантов блок зовётся «НАЧИСЛЕНО», а не «на руки»: питание"),
        ("", "из этой цифры не вычтено, и поевший получит на руки меньше."),
        ("", "У остальных вычитать нечего — там «на руки» это ровно оно и есть."),
        ("Питание", "В отчёт не входит. Отчёт фиксирует выплаты В ПОЛЬЗУ сотрудника,"),
        ("", "а обед — его встречная покупка. Удержание видно в приложении и в бэк-офисе."),
        ("Итоги блоков", "Стоят в цветной строке заголовка. Свернул блок — цифры остались."),
        ("Кальянный бар", "Отдельный контур учёта, в зал не входит."),
        ("", ""),
        ("Общий чай всего", "Наличные + терминал + QR + сервисный сбор. Всё, что оставили гости."),
        ("Итого распределено", "Сумма всех блоков «на руки»."),
        ("Расхождение", "Общий чай минус распределено. Должно быть 0 — прочерк в ячейке."),
        ("", "Красное число значит, что деньги где-то потерялись или задвоились."),
        ("Выручка", "Вносится из Quick Resto."),
        ("", ""),
        ("Дата смены", "Смена пишется на дату НАЧАЛА. Чаевые в 3 часа ночи 1 августа"),
        ("", "относятся к смене 31 июля. Приложение считает так же."),
        ("", ""),
        ("Как заполняется", "Кнопка «Выгрузить смену для отчёта» в приложении → файл смена-ГГГГ-ММ-ДД.json."),
        ("", "Затем: python3 scripts/report_fill.py ~/Downloads/смена-ГГГГ-ММ-ДД.json"),
    ],
    start=1,
):
    legend.cell(i, 1, a).font = Font(name=FONT, bold=True, size=10)
    legend.cell(i, 2, b).font = Font(name=FONT, size=10)
legend.column_dimensions["A"].width = 24
legend.column_dimensions["B"].width = 95

wb.save(OUT)
print(f"Сохранено: {OUT.name}")
print(f"Папка: {describe(OUT.parent)}")
print(f"Сводная: строки {min(summary.values())}–{max(summary.values())}")
for k, v in blocks.items():
    print(f"  {k:38} строки {v[0]}–{v[1]}")
