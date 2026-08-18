#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Забирает списки сотрудников из Quick Resto — из обеих касс.

Касс две, у каждого юрлица своё облако:
  — ООО «МАВ» (QR_MAV_*) — зал: официанты, администраторы, кассиры, хостес;
  — ИП Шалаева (QR_SHALAEVA_*) — кальянный бар, отдельный контур.

Складывает в data/employees.json и data/hookah.json, и сразу же кладёт
копии в mini-app/src/data/ — приложение читает список из своей сборки,
а не с диска. Раньше копию переносили руками, и 18.08.2026 выяснилось,
что она отстала на шесть человек: в кассе 23, в приложении 17.
Копирование руками — это не шаг, это будущая забытая правка.

Quick Resto не хранит должности НИ В ОДНОЙ кассе: официант, хостес и кухня
лежат одинаково. Поэтому роль назначает администратор при сборе смены,
а разделение на зал и кальянный бар держится на том, из какой это кассы.

Запускать заново при приёме или увольнении.

Запуск:  python3 scripts/qr_employees.py
"""

import base64
import json
import sys
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
API_PREFIX = "/platform/online"
EMPLOYEE_CLASS = "ru.edgex.quickresto.modules.personnel.employee.Employee"

# На сколько сдвигаем номера кальянщиков.
#
# Касс две, и обе выдают номера из одного ряда: в зале сейчас 172–919,
# у Шалаевой 885–908. Не столкнулись они пока СЛУЧАЙНО — завтра новый
# кальянщик получит номер уже работающего официанта, и чаевые лягут чужому
# человеку, молча и без единой ошибки на экране.
#
# Поэтому у кальянщиков свой диапазон: настоящий номер плюс миллион. Тем же
# приёмом уже разведены вписанные вручную — у них номер отрицательный.
# Вернуть настоящий номер всегда можно вычитанием, он никуда не делся.
HOOKAH_OFFSET = 1_000_000

# Куда кладём. Первый путь — рабочий файл проекта, второй — копия в сборке
# приложения смены, из которой оно рисует состав.
CLOUDS = (
    {
        "prefix": "QR_MAV",
        "title": "ООО «МАВ» — зал",
        "offset": 0,
        "files": (
            ROOT / "data" / "employees.json",
            ROOT / "mini-app" / "src" / "data" / "employees.json",
        ),
    },
    {
        "prefix": "QR_SHALAEVA",
        "title": "ИП Шалаева — кальянный бар",
        "offset": HOOKAH_OFFSET,
        "files": (
            ROOT / "data" / "hookah.json",
            ROOT / "mini-app" / "src" / "data" / "hookah.json",
        ),
    },
)


def read_env():
    cfg = {}
    for line in ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            cfg[key.strip()] = value.strip()
    return cfg


def fetch(cfg, prefix):
    """Список сотрудников одной кассы.

    Ключи ищем сначала свои (QR_MAV_URL), потом общие (QR_URL): общие
    остались с тех пор, когда касса была одна.
    """
    def key(suffix):
        value = cfg.get(f"{prefix}_{suffix}") or cfg.get(f"QR_{suffix}")
        if not value:
            raise SystemExit(f"В .env не заполнено: {prefix}_{suffix}")
        return value

    token = base64.b64encode(
        f"{key('LOGIN')}:{key('PASSWORD')}".encode()
    ).decode()
    query = urllib.parse.urlencode(
        {"moduleName": "personnel.employee", "className": EMPLOYEE_CLASS}
    )
    req = urllib.request.Request(
        f"{key('URL').rstrip('/')}{API_PREFIX}/api/list?{query}",
        headers={
            "Authorization": "Basic " + token,
            "Content-Type": "application/json",
            "Connection": "keep-alive",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode("utf-8"))


def people_from(raw, offset=0):
    people = []
    for e in raw:
        # systemEmployee — тип учётки, а не флаг: Custom у живых людей,
        # SuperUser и FrontOffice у служебных входов.
        if e.get("blocked") or e.get("systemEmployee") != "Custom":
            continue
        first = (e.get("firstName") or "").strip()
        last = (e.get("lastName") or "").strip()
        full = (e.get("fullName") or f"{first} {last}").strip()
        if not full:
            continue
        people.append(
            {
                "id": e.get("id") + offset,
                "name": full,
                # Короткое имя для кнопки: «Анна К.»
                "short": f"{first} {last[:1]}." if first and last else full,
            }
        )
    people.sort(key=lambda p: p["name"])
    return people


def warn_about(people):
    """Странное не выбрасываем молча, а показываем.

    Одинаковых людей и тестовые записи чинят в самой кассе — решение,
    кого удалять, за владельцем. Скрипт, который «умно» отфильтровал бы
    их сам, однажды выкинет живого человека и не скажет об этом.
    """
    warnings = []
    for name, count in Counter(p["name"] for p in people).items():
        if count > 1:
            warnings.append(f"дважды заведён: {name} ({count} записи)")
    for p in people:
        parts = p["name"].lower().split()
        if len(set(parts)) < len(parts) or "иванов" in p["name"].lower():
            warnings.append(f"похоже на тестовую запись: {p['name']}")
    return warnings


def main():
    cfg = read_env()
    for cloud in CLOUDS:
        raw = fetch(cfg, cloud["prefix"])
        people = people_from(raw, cloud["offset"])
        if not people:
            sys.exit(f"{cloud['title']}: Quick Resto не вернул ни одного сотрудника.")

        body = json.dumps(people, ensure_ascii=False, indent=2) + "\n"
        for path in cloud["files"]:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")

        print(f"\n{cloud['title']}: {len(people)} человек")
        for p in people:
            print(f"  {p['short']:24} ({p['name']})")
        for w in warn_about(people):
            print(f"  ⚠️  {w}")
        print("  записано в: " + ", ".join(
            str(p.relative_to(ROOT)) for p in cloud["files"]
        ))


if __name__ == "__main__":
    main()
