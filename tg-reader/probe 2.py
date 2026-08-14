#!/usr/bin/env python3
"""Проверка связи: куда робот дозванивается с этого сервера, а куда нет.

Зачем. 11.08.2026 робот на Amvera не смог подключиться к Telegram и упал,
Amvera перезапустила его, он упал снова — и так по кругу. В журнале при этом
была только одна строка: «Connection to Telegram failed 5 time(s)». По ней
не понять ничего: то ли сервер вообще не выпускают в интернет, то ли закрыт
один порт, то ли Telegram не пускает адреса дата-центров.

Эта проверка отвечает на вопрос за десять секунд и пишет ответ словами,
а не кодом ошибки. Идёт при каждом запуске: стоит она копейки, а без неё
разбор упирается в догадки.

Проверить с компьютера:  python3 probe.py
"""

from __future__ import annotations

import socket
import time

TIMEOUT = 6

# Заведомо несуществующий адрес: диапазон 203.0.113.0/24 отведён под примеры
# в документации, живых машин там нет. Стучимся туда ПЕРВЫМ делом.
#
# Зачем. На компьютере владельца работает VPN incy, и он принимает любое
# соединение — даже в никуда. Проверка связи там показывает сплошные «✓»
# и врёт целиком. Правило проекта: прогони проверку на случае с известным
# ответом, прежде чем строить на ней вывод. Здесь она это делает сама.
NOWHERE = ("203.0.113.9", 443)

# Адреса Telegram — постоянные, они же зашиты в саму библиотеку telethon.
# Проверяем именно по адресам, а не по именам: если не сработает разбор имён,
# хочется видеть это отдельной строкой, а не вперемешку с отказом связи.
TARGETS = (
    (
        "путь-робота",
        "Telegram, основной путь робота",
        "149.154.167.51",
        443,
        "не отвечает — робот читать чаевые не сможет",
    ),
    (
        "порт-80",
        "Telegram, тот же адрес через порт 80",
        "149.154.167.51",
        80,
        "отвечает при закрытом 443 — поможет другой способ подключения",
    ),
    (
        "запасной-ЦОД",
        "Telegram, запасной дата-центр",
        "149.154.167.91",
        443,
        "отвечает при отказе основного — дело в одном адресе, а не во всех",
    ),
    (
        "api.telegram.org",
        "Telegram для ботов, api.telegram.org",
        "api.telegram.org",
        443,
        "отвечает при отказе остальных — Telegram доступен, закрыт путь робота",
    ),
    (
        "ya.ru",
        "Обычный сайт, ya.ru",
        "ya.ru",
        443,
        "не отвечает — сервер не выпускают в интернет вовсе",
    ),
)


def reach(host: str, port: int) -> tuple[bool, str]:
    """Стукнуться в адрес. Вернуть (дозвонились, что сказать человеку)."""
    started = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT):
            pass
    except socket.gaierror:
        return False, "не удалось разобрать имя в адрес"
    except socket.timeout:
        return False, f"тишина, ждали {TIMEOUT} с"
    except OSError as error:
        return False, f"отказ: {error.strerror or error}"
    return True, f"ответил за {time.monotonic() - started:.1f} с"


def trustworthy() -> bool:
    """Можно ли верить этой проверке здесь. Ложь — значит что-то отвечает за всех."""
    answered, _ = reach(*NOWHERE)
    return not answered


def check(log) -> dict[str, bool]:
    """Пройти по всем адресам, записать в журнал, вернуть кто отозвался."""
    if not trustworthy():
        log.warning(
            "⚠️  проверке связи здесь верить нельзя: отвечает даже несуществующий "
            "адрес %s. Соединения перехватывает что-то локальное — на компьютере "
            "владельца это VPN incy. На сервере такого нет.",
            NOWHERE[0],
        )
        return {}

    log.info("проверяю связь с этого сервера:")
    result: dict[str, bool] = {}
    for _short, title, host, port, meaning in TARGETS:
        ok, note = reach(host, port)
        result[f"{host}:{port}"] = ok
        log.info("  %s %s — %s", "✓" if ok else "✗", title, note)
        if not ok:
            log.info("      (%s)", meaning)

    log.info("итог: %s", verdict(result))
    return result


def summary(result: dict[str, bool]) -> list[str]:
    """Две строки на всю картину — чтобы повторять их при каждой неудаче.

    Зачем повторять. Журнал в панели Amvera листают с конца, и подробный
    разбор, написанный один раз при запуске, до читателя не доходит: 11.08.2026
    он дважды подряд оказался выше того куска, который удалось скопировать.
    Ответ должен попадаться на глаза в любом обрывке журнала, а не только
    в том, где он записан.
    """
    if not result:
        return ["проверке связи здесь верить нельзя — что-то отвечает за все адреса"]

    marks = " ".join(
        f"{'✓' if result.get(f'{host}:{port}') else '✗'}{short}"
        for short, _title, host, port, _meaning in TARGETS
    )
    return [f"связь: {marks}", f"итог: {verdict(result)}"]


def verdict(result: dict[str, bool]) -> str:
    """Один вывод словами вместо пяти строк, которые надо сопоставлять самому."""
    internet = result.get("ya.ru:443", False)
    main_way = result.get("149.154.167.51:443", False)
    spare_dc = result.get("149.154.167.91:443", False)
    port_80 = result.get("149.154.167.51:80", False)
    bots = result.get("api.telegram.org:443", False)

    if not internet and not bots and not main_way:
        return "сервер не выпускают в интернет вовсе — это вопрос к поддержке Amvera"
    if main_way or spare_dc:
        return "путь к Telegram открыт; если робот всё равно не подключается, дело не в связи"
    if port_80:
        return "порт 443 закрыт, а 80 открыт — пробуем подключение через порт 80"
    if bots:
        return (
            "Telegram доступен обычным способом, но закрыт путь, которым ходит робот. "
            "Похоже на запрет со стороны хостинга или на блокировку адресов дата-центра"
        )
    return "Telegram недоступен с этого сервера ни одним из способов"


if __name__ == "__main__":
    import logging
    import sys

    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    check(logging.getLogger("проверка"))
