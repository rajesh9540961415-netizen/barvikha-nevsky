#!/usr/bin/env python3
"""Забирает список сотрудников из Quick Resto.

Складывает в data/employees.json — из него приложение показывает,
кто на смене. Запускать заново при приёме или увольнении.

Quick Resto не хранит должности, поэтому отделить официантов от
кухни и служебных учёток автоматически нельзя — это делается
в приложении при выборе смены.

Запуск:  python3 scripts/qr_employees.py
"""

import base64
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
OUT = ROOT / "data" / "employees.json"
API_PREFIX = "/platform/online"
EMPLOYEE_CLASS = "ru.edgex.quickresto.modules.personnel.employee.Employee"


def read_env():
    cfg = {}
    for line in ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            cfg[key.strip()] = value.strip()
    return cfg


def main():
    cfg = read_env()
    token = base64.b64encode(
        f"{cfg['QR_LOGIN']}:{cfg['QR_PASSWORD']}".encode()
    ).decode()
    query = urllib.parse.urlencode(
        {"moduleName": "personnel.employee", "className": EMPLOYEE_CLASS}
    )
    req = urllib.request.Request(
        f"{cfg['QR_URL'].rstrip('/')}{API_PREFIX}/api/list?{query}",
        headers={
            "Authorization": "Basic " + token,
            "Content-Type": "application/json",
            "Connection": "keep-alive",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        raw = json.loads(resp.read().decode("utf-8"))

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
                "id": e.get("id"),
                "name": full,
                # Короткое имя для кнопки: «Анна К.»
                "short": f"{first} {last[:1]}." if first and last else full,
            }
        )

    people.sort(key=lambda p: p["name"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(people, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    if not people:
        sys.exit("Quick Resto не вернул ни одного сотрудника.")
    print(f"Сохранено {len(people)} человек в {OUT.relative_to(ROOT)}:")
    for p in people:
        print(f"  {p['short']:24} ({p['name']})")


if __name__ == "__main__":
    main()
