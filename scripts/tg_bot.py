#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Бот «Барвиха Невский — отчёты»: токен, получатели, отправка.

Зачем отдельный бот, а не аккаунт владельца. Сообщения с Мака уходят сейчас
от личного аккаунта Виктории Борзовой — тем же ключом, которым она переписывается
с людьми. Для ежедневной рассылки это плохо трижды: управляющему сводка приходит
как личное сообщение, рассылка стоит, пока Мак не залогинен, и любой сбой сессии
бьёт по личной переписке. У бота своё имя, свой ключ и никакого доступа к чужим
чатам.

🔴 **Второй аккаунт — «Марина Видикер» — не трогать.** Это робот на Amvera,
читающий чаевые по QR. Telegram рвёт ключ, работающий с двух адресов сразу,
и робот замолкает МОЛЧА. Так пропали чаевые за 18.08.2026.

⚠️ **Токен в переписку не печатается никогда.** Он приезжает из буфера обмена
прямо в `.env`, минуя экран: `--токен`. Проверить, что он рабочий, можно по
имени бота — оно печатается, а ключ нет.

⚠️ **Боту нельзя написать первым.** Пока человек не нажал «Старт» в чате с
ботом, Telegram отказывает в отправке. Поэтому шаг «нажать Старт» из инструкции
выбросить нельзя — без него рассылка молча не уйдёт именно этому человеку.

⚠️ **Отправка — отдельным ключом.** По умолчанию скрипт показывает текст и
получателей, но ничего не шлёт. Сообщение живым людям отменить нельзя.

Запуск:
    python3 scripts/tg_bot.py --токен              взять токен из буфера обмена
    python3 scripts/tg_bot.py --кто                кто нажал «Старт» у бота
    python3 scripts/tg_bot.py --кому 12345 «Виктория»   записать получателя
    python3 scripts/tg_bot.py --список             кому сейчас идёт рассылка
    python3 scripts/tg_bot.py --текст "…"          показать, что уйдёт
    python3 scripts/tg_bot.py --текст "…" --отправить
"""
import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
ПОЛУЧАТЕЛИ = ROOT / "data" / "рассылка.json"
КЛЮЧ = "TG_BOT_TOKEN"


def токен(обязателен=True):
    if ENV.exists():
        for строка in ENV.read_text(encoding="utf-8").splitlines():
            if строка.startswith(f"{КЛЮЧ}="):
                return строка.split("=", 1)[1].strip().strip('"').strip("'")
    if обязателен:
        sys.exit("✗ В .env нет TG_BOT_TOKEN.\n"
                 "  Скопируйте токен от BotFather и выполните:\n"
                 "  python3 scripts/tg_bot.py --токен")
    return None


def запрос(метод, данные=None, ключ=None):
    """Вызов Telegram Bot API. Ключ в сообщениях об ошибке не появляется."""
    ключ = ключ or токен()
    адрес = f"https://api.telegram.org/bot{ключ}/{метод}"
    тело = urllib.parse.urlencode(данные or {}).encode()
    try:
        with urllib.request.urlopen(адрес, тело if данные else None, timeout=30) as о:
            ответ = json.load(о)
    except urllib.error.HTTPError as e:
        подробности = e.read().decode("utf-8", "replace")[:200]
        sys.exit(f"✗ Telegram отказал на «{метод}»: {e.code}. {подробности}")
    except OSError as e:
        sys.exit(f"✗ Не достучались до Telegram: {e}")
    if not ответ.get("ok"):
        sys.exit(f"✗ Telegram вернул ошибку на «{метод}»: {ответ.get('description')}")
    return ответ["result"]


def записать_токен():
    """Токен из буфера обмена — сразу в .env, не показывая его на экране."""
    из_буфера = subprocess.run(["pbpaste"], capture_output=True, text=True).stdout
    ключ = "".join(из_буфера.split())
    if ключ.count(":") != 1 or not ключ.split(":")[0].isdigit():
        sys.exit("✗ В буфере обмена не похоже на токен бота.\n"
                 "  Ожидается вид «1234567890:AA...». Скопируйте его в BotFather\n"
                 "  (нажать на сам токен — он копируется) и повторите.")
    я = запрос("getMe", ключ=ключ)
    строки = [с for с in ENV.read_text(encoding="utf-8").splitlines()
              if not с.startswith(f"{КЛЮЧ}=")]
    строки.append(f"{КЛЮЧ}={ключ}")
    ENV.write_text("\n".join(строки) + "\n", encoding="utf-8")
    print(f"✓ Токен записан в .env. Бот: «{я.get('first_name')}» @{я.get('username')}")
    print("  Дальше: вы и управляющий открываете чат с ботом и жмёте «Старт»,")
    print("  потом — python3 scripts/tg_bot.py --кто")


def кто_написал():
    """Кто нажал «Старт». Telegram помнит это ~24 часа, потом список пустеет."""
    новости = запрос("getUpdates", {"limit": 100})
    люди = {}
    for н in новости:
        сообщение = н.get("message") or н.get("edited_message") or {}
        чат = сообщение.get("chat") or {}
        if чат.get("id"):
            имя = " ".join(filter(None, (чат.get("first_name"), чат.get("last_name"))))
            люди[чат["id"]] = имя or чат.get("title") or чат.get("username") or "без имени"
    if not люди:
        print("Пока никто не написал боту.\n"
              "  Это же сообщение вы увидите, если «Старт» нажали больше суток\n"
              "  назад: Telegram хранит непрочитанные обновления сутки. Тогда\n"
              "  попросите написать боту ещё раз — любое слово.")
        return
    print("Написали боту:")
    for ид, имя in люди.items():
        print(f"   {ид:>14}   {имя}")
    print("\nЗаписать получателя:  python3 scripts/tg_bot.py --кому <id> «Имя»")


def список():
    if not ПОЛУЧАТЕЛИ.exists():
        print("Получателей пока нет."); return {}
    данные = json.loads(ПОЛУЧАТЕЛИ.read_text(encoding="utf-8"))
    print("Рассылка идёт:")
    for п in данные["получатели"]:
        полнота = "полная" if п.get("полная") else "без денег"
        print(f"   {п['id']:>14}   {п['имя']:<24} {полнота}")
    return данные


def добавить(ид, имя, полная):
    данные = {"получатели": []}
    if ПОЛУЧАТЕЛИ.exists():
        данные = json.loads(ПОЛУЧАТЕЛИ.read_text(encoding="utf-8"))
    данные["получатели"] = [п for п in данные["получатели"] if str(п["id"]) != str(ид)]
    данные["получатели"].append({"id": int(ид), "имя": имя, "полная": полная})
    ПОЛУЧАТЕЛИ.parent.mkdir(exist_ok=True)
    ПОЛУЧАТЕЛИ.write_text(json.dumps(данные, ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")
    print(f"✓ Записан: {имя} ({ид}), версия "
          f"{'полная' if полная else 'без денег'}")


def отправить(текст, вправду):
    данные = список()
    if not данные:
        sys.exit("✗ Некому слать: сначала --кому")
    print("\n" + "─" * 60 + f"\n{текст}\n" + "─" * 60)
    if not вправду:
        print("\nЭто холостой показ. Чтобы отправить по-настоящему, добавьте --отправить")
        return
    for п in данные["получатели"]:
        запрос("sendMessage", {"chat_id": п["id"], "text": текст,
                               "parse_mode": "HTML",
                               "disable_web_page_preview": "true"})
        print(f"   ✓ отправлено: {п['имя']}")


def main():
    р = argparse.ArgumentParser(add_help=True)
    р.add_argument("--токен", action="store_true", help="взять токен из буфера обмена")
    р.add_argument("--кто", action="store_true", help="кто нажал «Старт»")
    р.add_argument("--кому", nargs=2, metavar=("ID", "ИМЯ"), help="записать получателя")
    р.add_argument("--без-денег", action="store_true",
                   help="этому получателю — версия без блока о деньгах")
    р.add_argument("--список", action="store_true", help="кому идёт рассылка")
    р.add_argument("--текст", help="текст сообщения")
    р.add_argument("--отправить", action="store_true", help="не показать, а отправить")
    а = р.parse_args()

    if а.токен:
        записать_токен()
    elif а.кто:
        кто_написал()
    elif а.кому:
        добавить(а.кому[0], а.кому[1], not а.без_денег)
    elif а.список:
        список()
    elif а.текст:
        отправить(а.текст, а.отправить)
    else:
        р.print_help()


if __name__ == "__main__":
    main()
