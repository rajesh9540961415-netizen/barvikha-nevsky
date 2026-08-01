#!/usr/bin/env python3
"""Создаёт пустой отчёт по чаевым на месяц.

Разбивка по видам денег сохранена, как в приложении: наличные, терминал
и сервисный сбор идут отдельными блоками. Так же, как в рабочей таблице
в ноябре 2025 отдельным блоком появился сервисный сбор.

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

ROOT = Path(__file__).resolve().parent.parent
MONTHS = "январь февраль март апрель май июнь июль август сентябрь октябрь ноябрь декабрь".split()
MONTHS_OF = "января февраля марта апреля мая июня июля августа сентября октября ноября декабря".split()

if len(sys.argv) > 1:
    YEAR, MONTH = (int(x) for x in sys.argv[1].split("-"))
else:
    today = date.today()
    YEAR, MONTH = today.year, today.month

OUT = ROOT / f"Чаевые-дубль-{MONTHS[MONTH - 1]}-{YEAR}.xlsx"
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

names = [p["name"] for p in PEOPLE if not p["name"].startswith("Кухня")]
row = 2
blocks: dict[str, tuple[int, int]] = {}
guest_rows: list[int] = []    # деньги, оставленные гостями
payout_rows: list[int] = []   # кто сколько получил на руки


def block(title: str, people: list[str], spare: int, color: str, bucket=None):
    """Блок: заголовок, строки сотрудников, запас пустых строк."""
    global row
    fill = PatternFill("solid", fgColor=color)
    ws.cell(row, 1, title).font = Font(name=FONT, bold=True, size=10)
    for col in range(1, COL_AVG + 1):
        ws.cell(row, col).fill = fill
        ws.cell(row, col).border = BORDER
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
        if bucket is not None:
            bucket.append(row)
        row += 1

    blocks[title] = (start, row - 1)
    row += 1


# Деньги от гостей — с разбивкой по видам, как в приложении.
block("ОФИЦИАНТЫ · ЧАЕВЫЕ НАЛИЧНЫЕ", names, 6, "FCE4D6", guest_rows)
block("ОФИЦИАНТЫ · ЧАЕВЫЕ ТЕРМИНАЛ", names, 6, "FBE2D5", guest_rows)
block("ОФИЦИАНТЫ · СЕРВИСНЫЙ СБОР", names, 6, "E4DFEC", guest_rows)

# Кто сколько получил на руки. Сумма всех этих блоков должна сойтись
# с «Общий чай всего» — за этим следит строка «Расхождение» в сводной.
block("ОФИЦИАНТЫ · НА РУКИ", names, 6, "D6E9D5", payout_rows)
block("АДМИНИСТРАТОРЫ · на руки (доля 20 %)", [], 6, "DDEBF7", payout_rows)
block("КАССИРЫ · на руки (доля от 750 ₽)", [], 4, "E2EFDA", payout_rows)
block("ХОСТЕС · на руки", [], 4, "FFF2CC", payout_rows)

# Кальянный бар — отдельный контур учёта, в зал не входит.
block("КАЛЬЯННЫЙ БАР (отдельный учёт)", ["Котёл кальянного бара"], 0, "EDEDED")

# ── сводная таблица ─────────────────────────────────────────────────────
ws.cell(row, 1, "СВОДНАЯ ТАБЛИЦА").font = Font(name=FONT, bold=True, size=10)
for col in range(1, COL_AVG + 1):
    ws.cell(row, col).fill = HEAD_FILL
    ws.cell(row, col).border = BORDER
row += 1

summary: dict[str, int] = {}
BOLD_ROWS = ("Общий чай всего", "Итого распределено", "Расхождение", "Выручка")
for label in (
    "Чаевые наличные",
    "Чаевые терминал",
    "Сервисный сбор",
    "Общий чай всего",
    "На руки официантам",
    "На руки администраторам",
    "На руки кассирам",
    "На руки хостес",
    "Итого распределено",
    "Расхождение",
    "% чаевых от выручки",
    "Выручка",
):
    ws.cell(row, 1, label).font = Font(name=FONT, bold=label in BOLD_ROWS, size=10)
    ws.cell(row, 1).border = BORDER
    summary[label] = row
    row += 1


def block_sum(col_letter: str, title: str) -> str:
    a, b = blocks[title]
    return f"SUM({col_letter}{a}:{col_letter}{b})"


for col in range(FIRST, LAST + 1):
    L = get_column_letter(col)
    R = summary
    ws.cell(R["Чаевые наличные"], col, f"={block_sum(L, 'ОФИЦИАНТЫ · ЧАЕВЫЕ НАЛИЧНЫЕ')}")
    ws.cell(R["Чаевые терминал"], col, f"={block_sum(L, 'ОФИЦИАНТЫ · ЧАЕВЫЕ ТЕРМИНАЛ')}")
    ws.cell(R["Сервисный сбор"], col, f"={block_sum(L, 'ОФИЦИАНТЫ · СЕРВИСНЫЙ СБОР')}")
    ws.cell(
        R["Общий чай всего"],
        col,
        f"={L}{R['Чаевые наличные']}+{L}{R['Чаевые терминал']}+{L}{R['Сервисный сбор']}",
    )
    ws.cell(R["На руки официантам"], col, f"={block_sum(L, 'ОФИЦИАНТЫ · НА РУКИ')}")
    ws.cell(
        R["На руки администраторам"],
        col,
        f"={block_sum(L, 'АДМИНИСТРАТОРЫ · на руки (доля 20 %)')}",
    )
    ws.cell(
        R["На руки кассирам"],
        col,
        f"={block_sum(L, 'КАССИРЫ · на руки (доля от 750 ₽)')}",
    )
    ws.cell(R["На руки хостес"], col, f"={block_sum(L, 'ХОСТЕС · на руки')}")
    ws.cell(
        R["Итого распределено"],
        col,
        f"={L}{R['На руки официантам']}+{L}{R['На руки администраторам']}"
        f"+{L}{R['На руки кассирам']}+{L}{R['На руки хостес']}",
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

ws.freeze_panes = "B2"
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
        ("Что это", "Дубль отчёта «Чаевые Таблица учёта Невский» на август 2026."),
        ("", "Собран для проверки формата. На Google Диск не выкладывался."),
        ("", ""),
        ("Жёлтые ячейки", "Заполняются вручную или выгружаются из приложения."),
        ("Белые ячейки", "Считаются формулами, руками не трогать."),
        ("", ""),
        ("Сколько оставили гости", "Три блока официантов: наличные, терминал, сервисный сбор."),
        ("", "Раздельно, как в приложении — иначе не виден эффект от чаевых на терминале."),
        ("Кто сколько получил", "Четыре блока «на руки»: официанты, администраторы, кассиры, хостес."),
        ("", "Сумма этих блоков должна сойтись с «Общий чай всего»."),
        ("Кальянный бар", "Отдельный контур учёта, в зал не входит."),
        ("", ""),
        ("Общий чай всего", "Наличные + терминал + сервисный сбор. Всё, что оставили гости."),
        ("Итого распределено", "Сумма всех блоков «на руки»."),
        ("Расхождение", "Общий чай минус распределено. Должно быть 0 — прочерк в ячейке."),
        ("", "Красное число значит, что деньги где-то потерялись или задвоились."),
        ("Выручка", "Вносится из Quick Resto. За 1 августа — из API по смене."),
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
print(f"Сохранено: {OUT}")
print(f"Строк «от гостей»: {len(guest_rows)}, строк «на руки»: {len(payout_rows)}")
for k, v in blocks.items():
    print(f"  {k:38} строки {v[0]}–{v[1]}")
print(f"Сводная: {min(summary.values())}–{max(summary.values())}")
