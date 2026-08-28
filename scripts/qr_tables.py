#!/usr/bin/env python3
"""Забирает схему залов и столов из Quick Resto.

Складывает результат в data/tables.json — из него приложение
рисует кнопки. Запускать заново, если в зале поменялись столы.

Запуск:  python3 scripts/qr_tables.py
"""

import base64
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from seti import достучаться  # noqa: E402 — после sys.path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
OUT = ROOT / "data" / "tables.json"
API_PREFIX = "/platform/online"
SCHEME_CLASS = "ru.edgex.quickresto.modules.front.tablemanagement.TableScheme"


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
        {"moduleName": "front.tablemanagement", "className": SCHEME_CLASS}
    )
    req = urllib.request.Request(
        f"{cfg['QR_URL'].rstrip('/')}{API_PREFIX}/api/list?{query}",
        headers={
            "Authorization": "Basic " + token,
            "Content-Type": "application/json",
            "Connection": "keep-alive",
        },
    )
    schemes = json.loads(достучаться(req, таймаут=90).decode("utf-8"))

    if not schemes:
        sys.exit("Quick Resto не вернул ни одной схемы залов.")

    scheme = schemes[0]
    halls = []
    for hall in scheme.get("webHalls") or []:
        if hall.get("deleted"):
            continue
        tables = [
            {
                "id": t.get("id"),
                "title": t.get("title"),
                "seats": t.get("maxCapacity"),
                "x": t.get("x"),
                "y": t.get("y"),
                "width": t.get("width"),
                "height": t.get("height"),
                "shape": t.get("shape"),
            }
            for t in (hall.get("tables") or [])
            if not t.get("deleted") and t.get("title")
        ]
        if tables:
            halls.append(
                {"id": hall.get("id"), "title": hall.get("title"), "tables": tables}
            )

    data = {"scheme": scheme.get("itemTitle") or scheme.get("name"), "halls": halls}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    total = sum(len(h["tables"]) for h in halls)
    print(f"Схема: {data['scheme']}")
    for h in halls:
        print(f"  {h['title']}: {len(h['tables'])} столов")
    print(f"\nСохранено {total} столов в {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
