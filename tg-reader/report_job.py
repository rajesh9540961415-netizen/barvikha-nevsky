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

  3. Сверка мотивации за вчера с отчётом администратора из чата «НЕВСКИЙ |
     АДМИН» — по типам кальянов, штуками. Считаем по чекам, а отчёт
     администратора — проверка (владелец 21.10.2026). Итог — в журнал
     и сообщением в Telegram тому же получателю, что и копия базы.

Шаг 1 упал — шаг 2 всё равно идёт: чаевые важнее мотивации, а мотивация
в листе тогда просто останется вчерашней. Сверка ничего не меняет и ни на что
не влияет: не вышла — дело всё равно считается сделанным.

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
    ключ = google_key(os.environ["GOOGLE_ROBOT_JSON"])
    if ключ.get("type") != "service_account":
        raise ValueError("GOOGLE_ROBOT_JSON — не ключ сервисного аккаунта Google")
    GOOGLE_KEY.parent.mkdir(parents=True, exist_ok=True)
    GOOGLE_KEY.write_text(json.dumps(ключ), encoding="utf-8")
    GOOGLE_KEY.chmod(0o600)


def google_key(сырое: str) -> dict:
    """Ключ Google из переменной: как есть (JSON) или упакованный.

    Упакованный — `gzip -c google-robot.json | base64`: одна строка из букв
    и цифр. Заведено 21.10.2026: панель Amvera не приняла JSON ключа целиком —
    кавычки, переносы внутри закрытого ключа и длина в 2,3 тыс. знаков.
    """
    import base64
    import gzip

    сырое = сырое.strip()
    if сырое.startswith("{"):
        return json.loads(сырое)
    данные = base64.b64decode("".join(сырое.split()))
    if данные[:2] == b"\x1f\x8b":
        данные = gzip.decompress(данные)
    return json.loads(данные)


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
        if строка.lstrip().startswith(("✓", "⚠", "✗", "не тронуты", "Всего людям", "Собрано")) \
                or any(м in строка for м in ("не отдала", "доступ не принят", "Error:")):
            log.info("  %s", строка.strip())
    хвост = вывод[-1].strip() if вывод else ""
    отказ = next((с.strip() for с in вывод if "обновить не удалось" in с), None)
    if отказ:
        return False, отказ
    return итог.returncode == 0, хвост


def _office(путь: str) -> dict:
    """GET в бэк-офис ключом правок."""
    import urllib.request

    адрес = os.environ.get("OFFICE_URL", "https://office.barvikha-nevsky.ru").rstrip("/")
    запрос = urllib.request.Request(адрес + путь,
                                    headers={"X-Tips-Fix-Key": os.environ["TIPS_FIX_KEY"]})
    with urllib.request.urlopen(запрос, timeout=60) as ответ:
        return json.loads(ответ.read().decode("utf-8"))


def сверка_текстом(день: str, данные: dict, ставки: dict) -> str:
    """Сверка дня одной человеческой строкой (или несколькими)."""
    дата = f"{день[8:10]}.{день[5:7]}"
    дни = данные.get("дни") or []
    д = next((x for x in дни if x["день"] == день), None)
    if not д or not д.get("мотивация"):
        return f"Мотивация бара {дата}: отчёта администратора в чате нет — сверить не с чем"
    его = д["мотивация"].get("итог")
    сверка = д.get("сверка")
    if not isinstance(сверка, list):
        return (f"Мотивация бара {дата}: продаж по чекам за этот день нет — сверить не с чем "
                f"(у администратора {его if его is None else f'{его:,.0f}'.replace(',', ' ')} ₽)")
    def руб(v) -> str:
        return f"{v:,.0f}".replace(",", " ") if isinstance(v, (int, float)) else "?"

    наш = sum(с["уНас"] * ставки.get(с["тип"], 0) for с in сверка)
    разные = [с for с in сверка if с["разница"]]
    if not разные:
        return f"Мотивация бара {дата}: по чекам {руб(наш)} ₽ — с отчётом администратора сходится"
    строки = [f"⚠️ Мотивация бара {дата}: по чекам {руб(наш)} ₽, у администратора {руб(его)} ₽"]
    for с in разные:
        строки.append(f"  {с['тип']}: по чекам {с['уНас']:g}, у администратора {с['уАдминистратора']:g}")
    строки.append("В лист УК ушло по чекам.")
    return "\n".join(строки)


def _сверить(when: datetime, log) -> None:
    """Сверка вчерашней мотивации с отчётом администратора. Ничего не меняет."""
    from datetime import timedelta

    import tgbot

    вчера = (when - timedelta(days=1)).strftime("%Y-%m-%d")
    try:
        ставки = _office(f"/api/hookah-sales?month={вчера[:7]}").get("ставки") or {}
        данные = _office(f"/api/bar-chat?from={вчера}&to={вчера}")
        текст = сверка_текстом(вчера, данные, ставки)
    except Exception as error:  # noqa: BLE001 — сверка не должна ронять дело
        log.warning("⚠️  сверка с отчётом администратора не вышла: %s: %s",
                    type(error).__name__, error)
        return
    for строка in текст.splitlines():
        log.info("  %s", строка)
    чат = (os.environ.get("TG_BACKUP_CHAT") or "").strip()
    if tgbot.token() and чат:
        try:
            tgbot.call("sendMessage", {"chat_id": чат, "text": текст})
        except Exception as error:  # noqa: BLE001
            log.warning("⚠️  сверку не отправить в Telegram: %s", error)


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
    _сверить(when, log)

    if not отчёт_ок:
        # Исключение, а не None: расписание запишет неудачу и повторит через час.
        raise RuntimeError(f"отчёт не собран: {отчёт}")
    return "лист УК обновлён" + ("" if мотивация_ок else "; мотивация НЕ залита")


if __name__ == "__main__":
    # Ручной запуск: python3 report_job.py — то же, что сделает расписание.
    import logging

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print(run(datetime.now(), logging.getLogger("отчёт")))
