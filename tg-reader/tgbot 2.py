#!/usr/bin/env python3
"""Отправка через обычный Telegram для ботов — по https, а не по MTProto.

Зачем отдельно от telethon. 11.08.2026 выяснилось: Amvera не выпускает
соединения к дата-центрам Telegram, которыми пользуется `telethon`. Замерено
с сервера — молчат все четыре способа и оба порта. А `api.telegram.org`
отвечает за 0,3 секунды: это обычный https, тот же, каким открываются сайты.

Значит **отправить** файл с сервера можно, а **прочитать** группу — нет:
Telegram не даёт ботам читать сообщения других ботов, а уведомления Сбера
шлёт именно бот (проверено владельцем 11.08.2026). Поэтому здесь только
отправка, и чтение чаевых по-прежнему живёт на telethon.

Без сторонних библиотек намеренно: `urllib` из стандартной поставки умеет
всё нужное, а лишняя зависимость в службе без присмотра — лишний способ
однажды не собраться.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from uuid import uuid4

BASE = "https://api.telegram.org"
TIMEOUT = 120  # копия базы может быть тяжёлой, а канал — небыстрым


def token() -> str | None:
    """Ключ бота. Пусто и пробелы считаем за «не задан»."""
    value = (os.environ.get("TG_BOT_TOKEN") or "").strip()
    return value or None


def call(method: str, fields: dict, file: tuple | None = None) -> dict:
    """Позвать Telegram. `file` — это (имя_поля, имя_файла, содержимое)."""
    key = token()
    if not key:
        raise RuntimeError("Не задан TG_BOT_TOKEN")

    url = f"{BASE}/bot{key}/{method}"
    if file is None:
        body = json.dumps(fields).encode("utf-8")
        headers = {"Content-Type": "application/json"}
    else:
        body, content_type = multipart(fields, *file)
        headers = {"Content-Type": content_type}

    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as answer:
            payload = json.loads(answer.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # Телеграм объясняет отказ словами — покажем их, а не голый код.
        detail = ""
        try:
            detail = json.loads(error.read().decode("utf-8")).get("description", "")
        except Exception:
            pass
        raise RuntimeError(f"Telegram отказал ({error.code}): {detail or error.reason}")

    if not payload.get("ok"):
        raise RuntimeError(f"Telegram отказал: {payload.get('description')}")
    return payload["result"]


def multipart(fields: dict, name: str, filename: str, blob: bytes) -> tuple[bytes, str]:
    """Собрать тело запроса с файлом. Двадцать строк вместо новой библиотеки."""
    boundary = "----" + uuid4().hex
    body = bytearray()
    for key, value in fields.items():
        body += f"--{boundary}\r\n".encode("utf-8")
        body += f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8")
        body += f"{value}\r\n".encode("utf-8")
    body += f"--{boundary}\r\n".encode("utf-8")
    body += (
        f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
    ).encode("utf-8")
    body += b"Content-Type: application/octet-stream\r\n\r\n"
    body += blob + b"\r\n"
    body += f"--{boundary}--\r\n".encode("utf-8")
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def send_document(chat: str, filename: str, blob: bytes, caption: str) -> None:
    call(
        "sendDocument",
        {"chat_id": chat, "caption": caption},
        ("document", filename, blob),
    )


def find_chat() -> str | None:
    """Куда слать, если адрес не задан руками.

    Бот не может написать первым — это правило Telegram. Значит владелец
    один раз пишет боту «привет», и его переписка появляется в getUpdates.
    Оттуда и берём адрес.

    ⚠️ Telegram хранит эти события около суток. Если владелец написала боту
    неделю назад, здесь будет пусто — тогда либо написать боту ещё раз, либо
    вписать адрес переменной TG_BACKUP_CHAT.
    """
    for update in call("getUpdates", {"limit": 100}):
        message = update.get("message") or update.get("channel_post") or {}
        chat = message.get("chat") or {}
        if chat.get("type") == "private" and chat.get("id"):
            return str(chat["id"])
    return None
