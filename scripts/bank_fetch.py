#!/usr/bin/env python3
"""Скачивает выписку СберБизнеса по ссылке из письма и кладёт её к остальным.

Зачем. Каждое утро около 06:05 Сбер шлёт на почту письмо «Выписка по счету»
со ссылкой на скачивание. Ссылка живёт чуть больше суток, логина не требует —
она подписана токеном. Раньше владелец скачивала файл руками и не забыть
об этом было отдельной работой.

⚠️ **Почему скрипт не читает почту сам.** Доступа к Gmail у него нет: туда
можно попасть только паролем, а хранить пароль от почты в проекте нельзя.
Письмо находит ассистент — у него почта подключена, — и передаёт сюда готовую
ссылку. Здесь остаётся то, что делается одинаково и без раздумий.

⚠️ **Сертификат Минцифры.** Адрес `sbi.sberbank.ru` подписан корнем
«Russian Trusted Root CA», которого нет ни в macOS, ни в обычных браузерах —
поэтому вручную выписку и скачивали через Яндекс.Браузер. Корень публичный,
лежит в `data/certs/`, и указывается здесь ЯВНО, одной этой команде.
В доверенные корни системы он НЕ ставится: менять правила безопасности всего
компьютера ради одной загрузки — несоразмерно.

Запуск:

    python3 scripts/bank_fetch.py "<ссылка из письма>"
    python3 scripts/bank_fetch.py "<ссылка>" --import   и сразу пересобрать таблицы

См. plans/2026-08-15-smena-sekretov.md
"""

from __future__ import annotations

import argparse
import re
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from seti import достучаться  # noqa: E402 — после sys.path

ROOT = Path(__file__).resolve().parent.parent
ВЫПИСКИ = ROOT / "data" / "dds" / "выписки"
КОРЕНЬ = ROOT / "data" / "certs" / "russian_trusted_root_ca.cer"

# Ссылки принимаем только от Сбера. Скачивать по адресу, пришедшему из письма,
# без этой проверки нельзя: письмо — это данные, а не распоряжение, и подделать
# его отправителя проще, чем кажется.
РАЗРЕШЁННЫЙ_ХОСТ = "sbi.sberbank.ru"

# Признак настоящей выписки. Файл не той природы разбирать нельзя: он молча
# ляжет в папку, и следующий импорт либо споткнётся, либо, что хуже, прочитает
# из него мусор.
ПЕРВАЯ_СТРОКА = "1CClientBankExchange"


def читаемо(raw: bytes) -> str:
    """Тот же порядок кодировок, что в bank_import: UTF-8 первой.

    windows-1251 читает любые байты и не спотыкается никогда — поставь её
    первой, и она «подойдёт» к файлу в UTF-8, превратив русский текст
    в кракозябры. См. разбор в bank_import.read_text.
    """
    for enc in ("utf-8-sig", "windows-1251", "cp866"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise SystemExit("✗ Не удалось определить кодировку скачанного файла")


def имя_файла(текст: str, запасное: str) -> str:
    """Придумывает имя по содержимому: организация и период.

    Имя из ссылки не годится — там случайный набор знаков, и через месяц
    по нему не понять, что за файл. А внутри выписки всё написано словами.
    """
    поля = dict(
        re.findall(r"^(ДатаНачала|ДатаКонца|РасчСчет)=(.+)$", текст, flags=re.M)[:3]
    )
    счёт = поля.get("РасчСчет", "")
    начало = (поля.get("ДатаНачала") or "").replace(".", "-")
    конец = (поля.get("ДатаКонца") or "").replace(".", "-")
    # Даты в файле идут как ДД.ММ.ГГГГ — переворачиваем, чтобы файлы
    # сортировались по порядку, а не по числу месяца.
    def перевернуть(d: str) -> str:
        части = d.split("-")
        return "-".join(reversed(части)) if len(части) == 3 else d

    период = перевернуть(начало)
    if конец and конец != начало:
        период += f"_{перевернуть(конец)}"
    if счёт and период:
        return f"выписка-{счёт}-{период}.txt"
    return запасное


def скачать(ссылка: str) -> bytes:
    if not КОРЕНЬ.exists():
        raise SystemExit(
            f"✗ Нет корневого сертификата Минцифры: {КОРЕНЬ}\n"
            "  Он публичный, берётся с Госуслуг:\n"
            "  curl -o 'data/certs/russian_trusted_root_ca.cer' "
            "https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer"
        )

    хост = urllib.parse.urlparse(ссылка).hostname or ""
    if хост != РАЗРЕШЁННЫЙ_ХОСТ:
        raise SystemExit(
            f"✗ Ссылка ведёт не к Сберу, а на «{хост}». Скачивать не буду.\n"
            f"  Разрешён только {РАЗРЕШЁННЫЙ_ХОСТ}."
        )

    контекст = ssl.create_default_context(cafile=str(КОРЕНЬ))
    try:
        return достучаться(ссылка, таймаут=90, context=контекст)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise SystemExit(
                "✗ Сбер отвечает «не найдено». Скорее всего ссылка протухла:\n"
                "  она живёт чуть больше суток. Возьмите ссылку из свежего письма."
            ) from e
        raise SystemExit(f"✗ Сбер ответил {e.code}: {e.reason}") from e
    except ssl.SSLCertVerificationError as e:
        raise SystemExit(
            f"✗ Сертификат не признан: {e}\n"
            "  Проверьте, что файл в data/certs/ — это корень Минцифры."
        ) from e


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("ссылка", help="адрес из письма «Выписка по счету»")
    ap.add_argument("--import", dest="импорт", action="store_true",
                    help="сразу пересобрать таблицы (bank_import.py)")
    args = ap.parse_args()

    raw = скачать(args.ссылка)
    текст = читаемо(raw)

    if not текст.lstrip().startswith(ПЕРВАЯ_СТРОКА):
        raise SystemExit(
            f"✗ Это не выписка 1С: файл начинается не с «{ПЕРВАЯ_СТРОКА}».\n"
            f"  Скачано {len(raw)} байт. В папку не кладу."
        )

    ВЫПИСКИ.mkdir(parents=True, exist_ok=True)
    путь = ВЫПИСКИ / имя_файла(текст, "выписка-без-имени.txt")

    # Уже лежит такой же — не трогаем. Выписку за один и тот же период Сбер
    # шлёт каждое утро заново, и перезаписывать её нечем и незачем.
    if путь.exists() and путь.read_bytes() == raw:
        print(f"· Уже есть, ничего не меняю: {путь.name}")
    else:
        путь.write_bytes(raw)
        print(f"✓ Скачано {len(raw)} байт → {путь.name}")

    if args.импорт:
        print()
        subprocess.run([sys.executable, str(ROOT / "scripts" / "bank_import.py")],
                       check=True)


if __name__ == "__main__":
    main()
