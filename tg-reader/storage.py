#!/usr/bin/env python3
"""Куда робот складывает прочитанное: прямо в базу или через приложение смены.

Зачем два способа. 13.08.2026 робота перенесли в Варшаву — из Москвы РКН режет
соединения к дата-центрам Telegram, и с 4 августа он не прочитал ни одного
поступления. В Варшаве Telegram отвечает сразу, но **внутреннее имя московской
базы там не разрешается**: она видна только внутри своего региона.

Открывать базе внешний доступ ради этого нельзя — в ней фамилии и заработки
17 человек. Поэтому появился второй способ: робот отдаёт прочитанное приложению
смены по обычному https, а в базу пишет уже приложение, стоящее с ней в одном
дата-центре.

💡 Побочная выгода важнее удобства: **через границу едет только сумма, котёл
(«Официант 2») и время.** Персональных данных в этом потоке нет вовсе.

Способ выбирается сам, по переменным окружения:

    CHAEVYE_API           адрес приложения смены — включает передачу по https
    CHAEVYE_EXPORT_KEY    ключ к нему, тот же, что EXPORT_KEY у приложения

Не задан `CHAEVYE_API` — работаем как раньше, прямо с базой.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime

import qr_reader as core

TIMEOUT = 30


class Database:
    """Прямая работа с базой. Так робот жил до переезда в Варшаву."""

    # У этого способа есть база, значит ему можно поручать копию базы.
    has_database = True
    описание = "пишу прямо в базу"

    def known_state(self):
        conn, _schema = core.connect()
        try:
            return core.known_state(conn)
        finally:
            conn.close()

    def store(self, records) -> int:
        conn, _schema = core.connect()
        try:
            return core.store(conn, records)
        finally:
            conn.close()


class Relay:
    """Передача через приложение смены по https."""

    # Базы у этого способа нет: копию базы делает московский робот.
    has_database = False

    def __init__(self, base: str, key: str):
        self.url = base.rstrip("/") + "/api/qr-tips"
        self.key = key
        self.описание = f"отдаю приложению {base}"

    def _call(self, method: str, payload=None):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"X-Export-Key": self.key}
        if body is not None:
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(
            self.url, data=body, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as answer:
                return json.loads(answer.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            # Приложение объясняет отказ словами — покажем их, а не голый код.
            detail = ""
            try:
                detail = json.loads(error.read().decode("utf-8")).get("причина", "")
            except Exception:
                pass
            raise RuntimeError(
                f"приложение ответило {error.code}: {detail or error.reason}"
            )

    def known_state(self):
        answer = self._call("GET")
        since_id = answer.get("sinceId")
        newest = answer.get("newestAt")
        return (
            None if since_id is None else int(since_id),
            None if newest is None else datetime.fromisoformat(newest.replace("Z", "+00:00")),
        )

    def store(self, records) -> int:
        tips = [
            {
                "messageId": message_id,
                "receivedAt": moment.isoformat(),
                "businessDay": day,
                "amount": float(notice.amount),
                "team": notice.team,
            }
            for message_id, moment, day, notice in records
        ]
        answer = self._call("POST", {"tips": tips})
        return int(answer.get("добавлено", 0))


def choose(log):
    """Выбрать способ по переменным окружения и сказать в журнал, какой вышел."""
    base = (os.environ.get("CHAEVYE_API") or "").strip()
    if not base:
        log.info("хранилище: пишу прямо в базу")
        return Database()

    key = (os.environ.get("CHAEVYE_EXPORT_KEY") or "").strip()
    if not key:
        # Молчаливого отката к базе быть не должно: в Варшаве база недоступна,
        # и робот крутился бы вхолостую, а в журнале была бы одна и та же
        # ошибка про имя хоста — не про забытый ключ.
        raise SystemExit(
            "Задан CHAEVYE_API, но не задан CHAEVYE_EXPORT_KEY — ключ к приложению.\n"
            "Это то же значение, что EXPORT_KEY в панели Amvera у приложения chaevye."
        )

    log.info("хранилище: отдаю приложению %s", base)
    return Relay(base, key)
