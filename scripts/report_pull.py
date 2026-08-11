#!/usr/bin/env python3
"""Забирает смену из приложения и вписывает её в отчёт.

Раньше это делалось руками в четыре шага: администратор жал «Выгрузить смену
для отчёта», файл падал в загрузки его телефона, оттуда его надо было принести
на компьютер владельца и там запустить report_fill.py. Не сделал ни разу
никто — в отчёте за август на 11.08.2026 была заполнена одна ячейка.

Теперь смена берётся прямо у приложения по адресу /api/export/<день>.
Он отдаёт ровно тот же JSON, что и кнопка: и адрес, и кнопка зовут один
и тот же код, поэтому разойтись цифрам негде.

Запуск:
    python3 scripts/report_pull.py                 # вчерашняя смена
    python3 scripts/report_pull.py 2026-08-10      # конкретный день
    python3 scripts/report_pull.py --month 2026-08 # весь месяц по вчера

Ключ берётся из переменной CHAEVYE_EXPORT_KEY — её же кладут в `.env`
строкой  CHAEVYE_EXPORT_KEY=<то же значение, что EXPORT_KEY в панели Amvera>.

⚠️ Заполнение столбца перезаписывает то, что там было. Это нарочно: смену
можно перезабрать, если данные поправили задним числом.
"""

from __future__ import annotations

import argparse
import calendar
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from db import load_env  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
СКАЧАННЫЕ = ROOT / "data" / "выгрузки-смен"

БОЕВОЙ_АДРЕС = "https://chaevye-borzovavv.amvera.io"


def адрес() -> str:
    """Куда ходить за сменой. Можно подменить на время проверки."""
    return os.environ.get("CHAEVYE_APP_URL", БОЕВОЙ_АДРЕС).rstrip("/")


def забрать(день: str, ключ: str) -> dict:
    """Скачивает выгрузку одной смены.

    Ключ идёт заголовком, а не в адресе: адреса оседают в журналах сервера
    и в истории команд, и ключ утёк бы туда вместе с ними.
    """
    запрос = urllib.request.Request(
        f"{адрес()}/api/export/{день}",
        headers={"X-Export-Key": ключ},
    )
    try:
        with urllib.request.urlopen(запрос, timeout=60) as ответ:
            return json.loads(ответ.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        тело = e.read().decode("utf-8", "replace")
        try:
            причина = json.loads(тело).get("причина", тело)
        except json.JSONDecodeError:
            причина = тело[:200]
        if e.code == 401:
            sys.exit(
                "✗ Приложение не приняло ключ.\n"
                "  Значение CHAEVYE_EXPORT_KEY в `.env` должно совпадать\n"
                "  с EXPORT_KEY в панели Amvera, у приложения chaevye."
            )
        if e.code == 503:
            sys.exit(
                "✗ Выдача выключена на стороне приложения.\n"
                f"  Ответ: {причина}\n"
                "  Задайте EXPORT_KEY в панели Amvera и перезапустите приложение."
            )
        sys.exit(f"✗ Приложение ответило {e.code}: {причина}")
    except urllib.error.URLError as e:
        sys.exit(f"✗ Не достучаться до приложения: {e.reason}")


def вписать(путь: Path) -> bool:
    """Отдаёт скачанный файл проверенному report_fill.py.

    Отдельным запуском, а не импортом: тогда путь «из кнопки» и путь
    «из адреса» проходят через один и тот же код, и починка одного
    не разъезжается с другим.
    """
    готово = subprocess.run(
        [sys.executable, str(Path(__file__).parent / "report_fill.py"), str(путь)],
        cwd=ROOT,
    )
    return готово.returncode == 0


def дни_месяца(месяц: str, по: date) -> list[str]:
    год, мес = (int(x) for x in месяц.split("-"))
    последний = calendar.monthrange(год, мес)[1]
    все = [date(год, мес, д) for д in range(1, последний + 1)]
    return [d.isoformat() for d in все if d <= по]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("день", nargs="?", help="день смены, например 2026-08-10")
    ap.add_argument("--month", help="весь месяц: 2026-08")
    args = ap.parse_args()

    load_env()
    ключ = os.environ.get("CHAEVYE_EXPORT_KEY")
    if not ключ:
        sys.exit(
            "✗ Не задан CHAEVYE_EXPORT_KEY.\n"
            "  Добавьте в файл `.env` строку:\n"
            "     CHAEVYE_EXPORT_KEY=<то же значение, что EXPORT_KEY в Amvera>"
        )

    вчера = date.today() - timedelta(days=1)
    if args.month:
        дни = дни_месяца(args.month, вчера)
    elif args.день:
        дни = [args.день]
    else:
        дни = [вчера.isoformat()]

    СКАЧАННЫЕ.mkdir(parents=True, exist_ok=True)

    записано = 0
    пустых = 0
    for день in дни:
        данные = забрать(день, ключ)

        # Смены без единого официанта пропускаем молча только в режиме месяца:
        # заведение работает не каждый день, и десяток «пусто» подряд в выводе
        # мешал бы увидеть настоящую беду.
        if not данные.get("waiters"):
            пустых += 1
            if not args.month:
                print(f"· {день}: смена пустая, в отчёт вписывать нечего")
            continue

        путь = СКАЧАННЫЕ / f"смена-{день}.json"
        путь.write_text(
            json.dumps(данные, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        if вписать(путь):
            записано += 1
        else:
            print(f"✗ {день}: не удалось вписать в отчёт", file=sys.stderr)

    if args.month:
        print(f"\nГотово. Смен записано: {записано}, пустых дней: {пустых}")


if __name__ == "__main__":
    main()
