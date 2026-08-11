#!/usr/bin/env python3
"""Читатель QR-чаевых: крутится на сервере и складывает поступления в базу.

Раз в минуту заглядывает в группу «Сберчаевые Нев», разбирает уведомления
«СберЧаевые PRO» и кладёт новые в таблицу qr_tips. Оттуда их подхватывает
приложение смены и показывает кассиру полосой «Чаевые по QR».

Почему опрос раз в минуту, а не мгновенные события: у приложения смены экран
и так обновляется раз в 25 секунд, минута погоды не делает, а движущихся
частей вдвое меньше. Меньше частей — меньше способов молча сломаться.

Настройки — переменными окружения, см. qr_reader.py. Дополнительно:

    TG_SESSION      сессия строкой (обязательно на сервере)
    POLL_SECONDS    как часто заглядывать, по умолчанию 60
    QR_SINCE_DAY    с какой смены начинать при первом запуске, ГГГГ-ММ-ДД

Запуск:  python3 service.py
"""

import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import backup
import jobs
import qr_reader as core

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%d.%m %H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("qr")

# Telethon по умолчанию рассказывает про каждое соединение и шифрование.
# В журнале, куда смотрят раз в неделю и обычно в тревоге, это шум:
# нужное тонет. Оставляем от него только предупреждения и ошибки.
logging.getLogger("telethon").setLevel(logging.WARNING)

POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "60"))

# Раз в час говорим, что живы, даже когда ничего не пришло. Иначе «работает
# и поступлений нет» и «упало» выглядят в журнале одинаково — пустотой.
# Это то же правило, что и про молчание рассылки, только про саму службу.
HEARTBEAT = timedelta(hours=1)

# Про молчание говорим не чаще раза в час. Иначе журнал забьётся одной и той же
# строкой, и в нём перестанут искать настоящие ошибки.
SILENCE_REPEAT = timedelta(hours=1)

# При первом запуске таблица пуста, и без границы читатель вытянул бы всю
# историю группы разом. Ограничиваем и по числу сообщений, и по смене.
FIRST_RUN_LIMIT = 200


def make_client():
    """Подключение к Telegram. На сервере — сессией из переменной окружения."""
    from telethon.sessions import StringSession
    from telethon.sync import TelegramClient

    api_id = os.environ.get("TG_API_ID")
    api_hash = os.environ.get("TG_API_HASH")
    session = os.environ.get("TG_SESSION")
    for name, value in (("TG_API_ID", api_id), ("TG_API_HASH", api_hash)):
        if not value:
            sys.exit(f"Не задана переменная {name}")
    if not session:
        sys.exit(
            "Не задана TG_SESSION — сессия Telegram строкой.\n"
            "Получить: python3 scripts/tg_session_export.py на компьютере владельца."
        )

    client = TelegramClient(StringSession(session), int(api_id), api_hash)
    client.connect()
    if not client.is_user_authorized():
        sys.exit("Сессия не годится: Telegram не признал её. Нужен новый вход.")
    return client


def one_pass(client, group, since_day):
    """Один заход: прочитать новое, записать, вернуть сведения о молчании."""
    conn, schema = core.connect()
    try:
        since_id, known_newest = core.known_state(conn)
        found, skipped, too_old = core.collect(
            client,
            group,
            limit=None if since_id else FIRST_RUN_LIMIT,
            since_id=since_id,
            since_day=None if since_id else since_day,
        )

        added = core.store(conn, found) if found else 0
        if added:
            total = sum(n.amount for _, _, _, n in found)
            log.info(
                "записано %d на %.2f ₽ (схема %s, пропущено чужих %d, старых %d)",
                added,
                total,
                schema,
                skipped,
                too_old,
            )
            for _, moment, day, notice in found:
                _, local = core.business_day(moment)
                log.info(
                    "  %s %s — %.2f ₽ · %s",
                    day,
                    local.strftime("%H:%M"),
                    notice.amount,
                    notice.team,
                )

        newest = max((m for _, m, _, _ in found), default=None)
        if known_newest and (newest is None or known_newest > newest):
            newest = known_newest
        return core.silence_report(newest)
    finally:
        conn.close()


def schedule_pass(client, now):
    """Проверить расписание и сделать то, чему настал срок.

    Соединение своё и короткое: дела здесь редкие — раз в неделю, — держать
    ради них связь круглосуточно незачем.

    Копию базы делаем в понедельник в пять утра. Смена к этому часу разошлась
    даже в пятницу и субботу, когда работают до шести: понедельник — самое
    пустое утро недели.
    """
    conn, schema = core.connect()
    try:
        jobs.tick(
            conn,
            (
                jobs.Job(
                    name="копия базы",
                    weekday=0,
                    hour=5,
                    do=lambda: backup.run(client, conn, schema, now),
                ),
            ),
            now,
            log,
        )
    finally:
        conn.close()


def main():
    # Один заход и выход — чтобы службу можно было проверить, не запуская
    # навсегда. На сервере запускается без ключей и работает постоянно.
    once = "--once" in sys.argv

    group_id = os.environ.get("TG_GROUP_ID")
    if not group_id:
        sys.exit("Не задана TG_GROUP_ID")
    since_day = os.environ.get("QR_SINCE_DAY")

    client = make_client()
    group = client.get_entity(int(group_id))
    log.info("читаю группу «%s» раз в %d с", getattr(group, "title", "—"), POLL_SECONDS)
    if since_day:
        log.info("при первом запуске беру смены с %s и позже", since_day)

    # Таблицу отметок заводим один раз при старте, а не каждую минуту.
    starter, _ = core.connect()
    try:
        jobs.setup(starter)
    finally:
        starter.close()
    if backup.password():
        log.info("расписание: копия базы — по понедельникам в 5 утра")
    else:
        # Говорим при каждом старте, а не молчим: беззвучно не делать копию —
        # ровно тот случай, когда пропажу замечают в день, когда она нужна.
        log.warning("⚠️  копии базы НЕ будет: не задан BACKUP_PASSWORD")

    said_about_silence = None
    said_alive = None
    while True:
        try:
            alarm, message = one_pass(client, group, since_day)
            now = datetime.now(timezone.utc)
            if alarm:
                # Тревогу повторяем редко, но повторяем: она должна попадаться
                # на глаза и через сутки, а не потеряться в первой строке.
                if said_about_silence is None or now - said_about_silence > SILENCE_REPEAT:
                    log.warning("⚠️  %s", message)
                    said_about_silence = now
            else:
                said_about_silence = None
                if said_alive is None or now - said_alive > HEARTBEAT:
                    log.info("жив. %s", message)
                    said_alive = now
            # Расписание проверяем после чтения чаевых, а не до: чаевые —
            # главная работа робота, и она не должна ждать, пока соберётся копия.
            schedule_pass(client, datetime.now(core.MOSCOW))
        except KeyboardInterrupt:
            log.info("остановлено вручную")
            break
        except Exception as error:
            # Падать нельзя: связь с Telegram или базой рвётся, это обычное дело
            # ночью. Записали, чем именно, и пробуем снова через минуту.
            log.error("заход не удался: %s: %s", type(error).__name__, error)

        if once:
            log.info("один заход сделан, выхожу")
            break

        time.sleep(POLL_SECONDS)

    client.disconnect()


if __name__ == "__main__":
    main()
