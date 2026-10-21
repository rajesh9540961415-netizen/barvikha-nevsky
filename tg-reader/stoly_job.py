#!/usr/bin/env python3
"""Столы из Рестоплейс — дело московского робота: копить посадки каждый день.

Заведено 21.10.2026. Рестоплейс отдаёт скользящее окно примерно в 33 дня
и молча забывает старое, поэтому посадки надо складывать к себе, пока они
ещё в окне. До переезда это делала утренняя задача на Маке (`rp_stoly.py`);
она пропала со старым аккаунтом, и склад простоял с 22.09 по 21.10 — ещё
неделя, и дыра стала бы навсегда.

Склад робот держит в базе, в своей таблице `rp_stoly`, а не в файле:
контейнер стирается при каждой выкладке, а база — нет. Заодно склад
попадает в еженедельную копию базы: копия берёт все таблицы схемы.
Имён и телефонов в нём нет — только статус, день, гости и зал (`rp_stoly.худая`).

Разбор и слияние — тем же кодом `scripts/rp_stoly.py`, ни строчки заново.
Первый заход заливает в пустую таблицу склад из проекта
(`data/столы-рестоплейс.json`, его кладёт в образ `deploy_moscow.sh`).

⚠️ Таблица `rp_stoly` — собственность робота, как и `robot_jobs`: её нет
в `schema.sql` приложения смены намеренно.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))

KEY = "RP_API_KEY"
SEED = ROOT / "data" / "столы-рестоплейс.json"

_complained_at: datetime | None = None


def setup(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            create table if not exists rp_stoly (
                id   text primary key,
                data jsonb not null
            )
            """
        )
    conn.commit()


def load(conn) -> dict:
    with conn.cursor() as cur:
        cur.execute("select id, data from rp_stoly")
        return {ид: запись for ид, запись in cur.fetchall()}


def save(conn, склад: dict, ids) -> None:
    """Записать изменившиеся брони одной пачкой."""
    with conn.cursor() as cur:
        cur.executemany(
            """
            insert into rp_stoly (id, data) values (%s, %s::jsonb)
            on conflict (id) do update set data = excluded.data
            """,
            [(ид, json.dumps(склад[ид], ensure_ascii=False)) for ид in ids],
        )
    conn.commit()


def last_closed(склад: dict) -> str | None:
    import rp_stoly

    дни = [з["день"] for з in склад.values() if з.get("статус") == rp_stoly.ЗАКРЫТ]
    return max(дни) if дни else None


def fetch(key: str) -> list[dict]:
    """Все брони из Рестоплейс.

    ⚠️ `rp_reserves` написан для ручного запуска: на отказе он зовёт
    `sys.exit`. В роботе это уронило бы службу целиком — расписание ловит
    только `Exception`, а `SystemExit` мимо него. Поэтому переводим в обычную
    ошибку: дело запишется неудачным и повторится через час.
    Постраничный вывод глушим — в журнал идёт только итог.
    """
    import rp_reserves

    try:
        with contextlib.redirect_stdout(io.StringIO()):
            return rp_reserves.все_брони(key)
    except SystemExit as error:
        raise RuntimeError(str(error.code).strip().splitlines()[0]) from None


def run(conn, when: datetime, log) -> str | None:
    """Дело для расписания. None — отложено (нет ключа), строка — сделано."""
    global _complained_at
    import rp_stoly

    key = os.environ.get(KEY, "").strip()
    if not key:
        if _complained_at is None or when - _complained_at >= timedelta(hours=6):
            log.warning("⚠️  столы из Рестоплейс отложены: в панели не задан %s", KEY)
            _complained_at = when
        return None

    setup(conn)
    склад = load(conn)
    было = dict(склад)
    if not склад and SEED.exists():
        склад.update(json.loads(SEED.read_text(encoding="utf-8")).get("брони") or {})
        log.info("  склад столов пуст — залил из проекта %d броней", len(склад))
    докуда = last_closed(склад)

    свежие = fetch(key)
    новых, обновлённых = rp_stoly.слить(свежие, склад)
    save(conn, склад, [ид for ид, з in склад.items() if было.get(ид) != з])

    # Дыра: самая ранняя свежая бронь позже последнего дня склада. Значит,
    # робот простоял дольше окна Рестоплейс и что-то между ними пропало.
    дни = sorted(д for б in свежие if (д := (rp_stoly.худая(б) or {}).get("день")))
    итог = f"новых {новых}, обновлённых {обновлённых}, в складе {len(склад)}"
    if докуда and дни and дни[0] > докуда:
        log.warning("⚠️  столы: дыра в складе — после %s сразу %s, эти дни Рестоплейс "
                    "уже не отдаёт", докуда, дни[0])
        итог += f"; ⚠️ дыра {докуда} → {дни[0]}"
    return f"{итог}; посадки по {last_closed(склад)}"


if __name__ == "__main__":
    # Ручной запуск: python3 stoly_job.py — то же, что сделает расписание.
    import logging

    import qr_reader as core

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    conn, _ = core.connect()
    try:
        print(run(conn, datetime.now(), logging.getLogger("столы")))
    finally:
        conn.close()
