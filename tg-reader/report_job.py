#!/usr/bin/env python3
"""Утренний отчёт по чаевым и мотивации — дело московского робота.

Заведено 21.10.2026 (`plans/2026-10-21-otchyot-v-robote.md`). До переезда то же
самое делала задача Claude на Маке в 11:30 — и пропала вместе со старым
аккаунтом: лист УК за октябрь простоял пустым с 5-го числа, и заметили это
только через две недели. Решение владельца 19.10.2026: всё, что повторяется
по расписанию, живёт в роботе на Amvera, рядом с ключами.

Что делает, по порядку — тем же кодом, что раньше на Маке, ни строчки заново:

  1. `hookah_push.py --залить` — продажи кальянов по чекам ОФД → бэк-офис.
     Мотивация — по продажам, а не по отчёту администратора: «оператор может
     ошибаться» (владелец 21.10.2026). Дни, которые владелец согласовала
     по отчёту администратора, бэк-офис переписать не даст.
  2. `report_pull.py --month` — смены месяца из приложения → отчёт → лист УК.
     Блок мотивации лист берёт из бэк-офиса, куда только что залил шаг 1.

Шаг 1 упал — шаг 2 всё равно идёт: чаевые важнее мотивации, а мотивация
в листе тогда просто останется вчерашней.

⚠️ Скрипты читают ключи из файла `.env` в корне и Google-ключ из
`data/certs/google-robot.json`. В образе их нет и быть не должно: оба файла
собираются из переменных панели прямо перед делом и стираются сразу после.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENV_FILE = ROOT / ".env"
GOOGLE_KEY = ROOT / "data" / "certs" / "google-robot.json"

# Без этих — дело откладывается, а не падает: значит, ключи ещё не положили.
NEED = (
    "QR_MAV_URL", "QR_MAV_LOGIN", "QR_MAV_PASSWORD",
    "QR_SHALAEVA_URL", "QR_SHALAEVA_LOGIN", "QR_SHALAEVA_PASSWORD",
    "OFD_SHALAEVA_SVERKA_KEY", "CHAEVYE_EXPORT_KEY", "TIPS_FIX_KEY",
    "GOOGLE_ROBOT_JSON",
)
# Эти кладём в .env, если заданы, но и без них можно.
OPTIONAL = ("OFD_MAV_SVERKA_KEY", "CHAEVYE_APP_URL", "OFFICE_URL")

# Сколько ждать один скрипт. Первый заход месяца тянет из ОФД и кассы всё
# с начала месяца — это минуты, а не секунды.
TIMEOUT = 40 * 60

_complained_at: datetime | None = None


def missing() -> list[str]:
    return [k for k in NEED if not os.environ.get(k, "").strip()]


def _postpone(reason: str, when: datetime, log) -> None:
    """Сказать, чего не хватает, — но не чаще раза в шесть часов."""
    global _complained_at
    if _complained_at is None or (when - _complained_at).total_seconds() >= 6 * 3600:
        log.warning("⚠️  отчёт по чаевым отложен: %s", reason)
        _complained_at = when


def _write_secrets() -> None:
    lines = [f"{k}={os.environ[k].strip()}" for k in NEED + OPTIONAL
             if k != "GOOGLE_ROBOT_JSON" and os.environ.get(k, "").strip()]
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    ENV_FILE.chmod(0o600)
    ключ = json.loads(os.environ["GOOGLE_ROBOT_JSON"])
    if ключ.get("type") != "service_account":
        raise ValueError("GOOGLE_ROBOT_JSON — не ключ сервисного аккаунта Google")
    GOOGLE_KEY.parent.mkdir(parents=True, exist_ok=True)
    GOOGLE_KEY.write_text(json.dumps(ключ), encoding="utf-8")
    GOOGLE_KEY.chmod(0o600)


def _wipe_secrets() -> None:
    for файл in (ENV_FILE, GOOGLE_KEY):
        try:
            файл.unlink()
        except FileNotFoundError:
            pass


def _step(args: list[str], log) -> tuple[bool, str]:
    """Запустить скрипт, пересказать его вывод в журнал, вернуть (вышло, хвост).

    ⚠️ «Вышло» — не только код возврата. `report_pull` сбой листа УК глотает
    нарочно (на Маке отчёт на Диске был важнее чужой таблицы) и выходит
    с нулём. Здесь же лист УК — весь смысл дела, поэтому его отказ ищем
    в выводе и считаем неудачей: расписание повторит через час.
    """
    try:
        итог = subprocess.run(
            [sys.executable, *args], cwd=ROOT, capture_output=True,
            text=True, timeout=TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return False, f"не уложился в {TIMEOUT // 60} мин"
    вывод = (итог.stdout + "\n" + итог.stderr).strip().splitlines()
    # В журнал — только итоги и тревоги, без списков людей с суммами:
    # журнал панели видят все, у кого есть доступ к проекту.
    for строка in вывод:
        if строка.lstrip().startswith(("✓", "⚠", "✗", "не тронуты", "Всего людям", "Собрано")):
            log.info("  %s", строка.strip())
    хвост = вывод[-1].strip() if вывод else ""
    отказ = next((с.strip() for с in вывод if "обновить не удалось" in с), None)
    if отказ:
        return False, отказ
    return итог.returncode == 0, хвост


def run(when: datetime, log) -> str | None:
    """Дело для расписания. None — отложено (нет ключей), строка — сделано."""
    нет = missing()
    if нет:
        _postpone("в панели не заданы " + ", ".join(нет), when, log)
        return None

    _write_secrets()
    try:
        мотивация_ок, мотивация = _step(["scripts/hookah_push.py", "--залить"], log)
        if not мотивация_ок:
            log.warning("⚠️  мотивация не залита, лист пойдёт с прежней: %s", мотивация)
        отчёт_ок, отчёт = _step(["scripts/report_pull.py", "--month"], log)
    finally:
        _wipe_secrets()

    if not отчёт_ок:
        # Исключение, а не None: расписание запишет неудачу и повторит через час.
        raise RuntimeError(f"отчёт не собран: {отчёт}")
    return "лист УК обновлён" + ("" if мотивация_ок else "; мотивация НЕ залита")


if __name__ == "__main__":
    # Ручной запуск: python3 report_job.py — то же, что сделает расписание.
    import logging

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print(run(datetime.now(), logging.getLogger("отчёт")))
