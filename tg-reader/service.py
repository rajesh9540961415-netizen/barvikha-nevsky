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
import bar_reader
import jobs
import probe
import report_job
import stoly_job
import qr_reader as core
import storage as storage_module
import tgbot

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

# Сколько ждать между попытками дозвониться до Telegram — и как отступать,
# когда не выходит раз за разом.
#
# Зачем отступать. Каждая неудачная попытка создаёт четыре клиента Telegram
# (по одному на способ подключения) и ждёт сети восемьдесят секунд. При паузе
# в минуту это ~2 500 клиентов в сутки, и на тарифе с четвертью процессора
# панель Amvera показывает «Высокое потребление» — замечено 13.08.2026
# на московском роботе, которому РКН перекрыл Telegram насовсем.
#
# Первая минута нужна: обычный обрыв связи проходит сам и быстро. А вот
# перекрытый канал минутными попытками не откроешь. Отсюда удвоение:
# 1, 2, 4, 8, 16, 32 минуты… и дальше по шесть часов.
#
# ⚠️ Потолок в шесть часов, а не в четверть часа, — потому что московскому
# роботу читать Telegram больше не нужно: с 13.08.2026 это делает варшавский.
# Москва пробует только на случай, если РКН однажды отпустит; узнать об этом
# в течение шести часов совершенно достаточно.
#
# Успешное подключение сбрасывает отсчёт: следующий обрыв снова проверится
# через минуту.
RECONNECT_SECONDS = 60
RECONNECT_MAX_SECONDS = 6 * 3600

# Как часто заглядывать в расписание. Дела там недельные, а раз в минуту —
# это 1 440 соединений с базой в сутки ради того, что срабатывает раз в семь
# дней. Пять минут точности хватает с запасом: у дел час срабатывания, а не
# минута. Замечено 13.08.2026 по «Высокому потреблению» у московского робота.
SCHEDULE_EVERY_SECONDS = 300

# Как часто повторять жалобу на недоступный Telegram.
#
# Зачем. С 13.08.2026 московский робот до Telegram не дотягивается вовсе —
# РКН режет соединения к его дата-центрам из России. Читает теперь варшавский,
# а московский остался ради копии базы. Но пробовать он не перестаёт: РКН
# однажды отпустит, и хорошо бы это заметить.
#
# Проблема только в журнале: жалоба раз в минуту забивает его так, что
# ради чего в него смотрят — не найти. Поэтому пробуем часто, а говорим редко.
#
# Отключать чтение переменной не стали намеренно: выключенный режим,
# о котором в журнале ни слова, — это ровно та тишина, которая в этом проекте
# уже дважды стоила дорого.
TELEGRAM_COMPLAIN_EVERY = timedelta(hours=1)

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


def connection_modes():
    """Способы подключения к Telegram, от обычного к обходным.

    Зачем несколько. 11.08.2026 робот на Amvera не смог подключиться вовсе:
    шесть попыток, на каждой тишина. Обычный способ ходит по порту 443,
    и если хостинг его наружу не выпускает, помогает подключение через 80 —
    тот открыт почти везде, потому что через него ходят все сайты.

    Порядок важен: сначала обычный, он самый быстрый и надёжный. Обходные —
    только если обычный не отозвался.
    """
    from telethon.network import (
        ConnectionHttp,
        ConnectionTcpAbridged,
        ConnectionTcpFull,
        ConnectionTcpObfuscated,
    )

    return (
        ("full", "обычный, порт 443", ConnectionTcpFull),
        ("abridged", "укороченный, порт 443", ConnectionTcpAbridged),
        ("obfuscated", "замаскированный, порт 443", ConnectionTcpObfuscated),
        ("http", "через порт 80", ConnectionHttp),
    )


def make_client():
    """Подключение к Telegram. На сервере — сессией из переменной окружения.

    Перебирает способы подключения и возвращает первый, который отозвался.
    Переменной `TG_CONNECTION` можно закрепить один — когда станет известно,
    какой работает, чтобы не тратить время на заведомо мёртвые.
    """
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

    only = (os.environ.get("TG_CONNECTION") or "").strip().lower()
    tried = []

    for key, title, mode in connection_modes():
        if only and key != only:
            continue
        tried.append(title)
        client = TelegramClient(
            StringSession(session),
            int(api_id),
            api_hash,
            connection=mode,
            # По одной попытке на способ: перебор всё равно идёт по кругу
            # снаружи, а пять попыток на каждом растянули бы его на минуты.
            connection_retries=1,
            timeout=10,
        )
        try:
            client.connect()
        except Exception as error:
            log.warning("способ «%s» не подошёл: %s", title, type(error).__name__)
            try:
                client.disconnect()
            except Exception:
                pass
            continue

        # Сессия негодна — это не про связь, перебирать способы бессмысленно.
        if not client.is_user_authorized():
            sys.exit("Сессия не годится: Telegram не признал её. Нужен новый вход.")

        log.info("подключился к Telegram, способ: %s", title)
        if key != "full":
            log.info(
                "  обычный способ не отозвался — впишите TG_CONNECTION=%s "
                "в переменные, чтобы робот больше его не пробовал",
                key,
            )
        return client

    raise ConnectionError(
        "ни один способ подключения к Telegram не сработал: " + ", ".join(tried)
    )


def one_pass(client, group, since_day, storage):
    """Один заход: прочитать новое, записать, вернуть сведения о молчании.

    Куда именно записать — решает `storage`: прямо в базу или через приложение
    смены по https. Читателю это безразлично, и в этом весь смысл: переезд
    в Варшаву не потребовал трогать разбор уведомлений.
    """
    since_id, known_newest = storage.known_state()
    found, skipped, too_old = core.collect(
        client,
        group,
        limit=None if since_id else FIRST_RUN_LIMIT,
        since_id=since_id,
        since_day=None if since_id else since_day,
    )

    added = storage.store(found) if found else 0
    if added:
        total = sum(n.amount for _, _, _, n in found)
        log.info(
            "записано %d на %.2f ₽ (пропущено чужих %d, старых %d)",
            added,
            total,
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


def schedule_pass(now):
    """Проверить расписание и сделать то, чему настал срок.

    ⚠️ **Не зависит от связи с Telegram по MTProto.** Копия базы уходит обычным
    https через бота, а чтение чаевых — через telethon. 11.08.2026 на Amvera
    работало только первое, и робот, который ждал бы второго, не сделал бы
    копию никогда. Дела по расписанию и чтение группы должны жить порознь.

    Соединение с базой своё и короткое: дела здесь редкие — раз в неделю, —
    держать ради них связь круглосуточно незачем.

    Копию базы делаем в понедельник в пять утра. Смена к этому часу разошлась
    даже в пятницу и субботу, когда работают до шести: понедельник — самое
    пустое утро недели.
    """
    conn, schema = core.connect()
    try:
        # Таблицу отметок заводим здесь, а не при старте службы: у стартового
        # обращения к базе нет второй попытки, и недоступная в ту секунду база
        # уронила бы робота целиком. Здесь всё внутри общего «попробуем снова».
        jobs.setup(conn)
        jobs.tick(
            conn,
            (
                jobs.Job(
                    name="копия базы",
                    weekday=0,
                    hour=5,
                    do=lambda: backup.run(conn, schema, now, log),
                ),
                # Каждый день в 11:30: к этому часу смена закрыта, отчёт
                # администратора написан, ночные правки внесены. Так было
                # на Маке до переезда (решение владельца 21.10.2026).
                jobs.Job(
                    name="отчёт по чаевым",
                    weekday=None,
                    hour=11,
                    minute=30,
                    do=lambda: report_job.run(now, log),
                ),
                # Каждый день в 11:00, до отчёта. Рестоплейс помнит ~33 дня,
                # пропуск дольше стирает посадки навсегда; час не важен, важно
                # не пропускать (21.10.2026, `stoly_job.py`).
                jobs.Job(
                    name="столы из Рестоплейс",
                    weekday=None,
                    hour=11,
                    do=lambda: stoly_job.run(conn, now, log),
                ),
            ),
            now,
            log,
        )
    finally:
        conn.close()


def announce_schedule(storage):
    """Сказать при старте, будет копия базы или нет, и почему.

    Говорим всегда, а не молчим: беззвучно не делать копию — ровно тот случай,
    когда пропажу обнаруживают в день, когда она нужна.
    """
    if not storage.has_database:
        # Варшавский робот до базы не дотягивается вовсе — копию делает
        # московский. Это не поломка, а разделение труда, и сказать о нём
        # надо прямо, иначе выглядит как молчаливая пропажа.
        log.info("расписание: копию базы делает московский робот, здесь её нет")
        return

    missing = []
    if not backup.password():
        missing.append("BACKUP_PASSWORD")
    if not tgbot.token():
        missing.append("TG_BOT_TOKEN")
    if missing:
        log.warning("⚠️  копии базы НЕ будет: не задано %s", ", ".join(missing))
    else:
        log.info("расписание: копия базы — по понедельникам в 5 утра")
    # Каким ботом шлём — вслух. 21.10.2026 владелец написала не тому боту
    # и полчаса ждала, а ключ в панели не прочитать ни ей, ни нам: секрет.
    if tgbot.token():
        try:
            имя = tgbot.call("getMe", {}).get("username")
            log.info("расписание: копию базы и сверку шлёт бот @%s — "
                     "напишите ему, чтобы он узнал, куда слать", имя)
        except Exception as error:
            log.warning("⚠️  ключ бота не принят Telegram: %s", error)
    нет = report_job.missing()
    if нет:
        log.warning("⚠️  отчёта по чаевым НЕ будет: в панели не заданы %s", ", ".join(нет))
    else:
        log.info("расписание: отчёт по чаевым и мотивации — каждый день в 11:30")
    if not os.environ.get(stoly_job.KEY, "").strip():
        log.warning("⚠️  столов из Рестоплейс НЕ будет: в панели не задан %s", stoly_job.KEY)
    else:
        log.info("расписание: столы из Рестоплейс — каждый день в 11:00")


def main():
    # Один заход и выход — чтобы службу можно было проверить, не запуская
    # навсегда. На сервере запускается без ключей и работает постоянно.
    once = "--once" in sys.argv

    # Читаем ли мы Telegram вообще.
    #
    # Роботов двое, и делают они разное: варшавский читает группу, московский
    # делает копию базы (Telegram из Москвы перекрыт с 13.08.2026). До сих пор
    # «не читаю Telegram» было для службы поломкой: без TG_SESSION она просто
    # выходила. Из-за этого у московского робота переменная осталась стоять —
    # и 18.08.2026 обернулась потерянным днём чаевых: два робота в разных
    # странах вошли в Telegram ОДНИМ ключом, и Telegram отозвал его у обоих.
    #
    # Поэтому теперь это законное состояние: нет сессии — не читаем, но живём
    # и делаем дела по расписанию. Копия базы в Telegram не нуждается вовсе,
    # она уходит ботом, а у бота ключ свой.
    reads_telegram = bool(os.environ.get("TG_SESSION"))

    group_id = os.environ.get("TG_GROUP_ID")
    if reads_telegram and not group_id:
        sys.exit("Не задана TG_GROUP_ID")
    since_day = os.environ.get("QR_SINCE_DAY")

    storage = storage_module.choose(log)
    announce_schedule(storage)
    if not reads_telegram:
        # Говорим прямо, а не молчим: «робот работает» и «робот читает группу» —
        # разные вещи, и перепутать их стоило нам недели поступлений в августе.
        log.info(
            "Telegram НЕ читаю: сессия (TG_SESSION) не задана. Так и задумано "
            "для московского робота — его дело копия базы. Группу читает "
            "варшавский, и ключ Telegram должен быть только у него: один "
            "ключ на двух серверах Telegram отзывает."
        )

    client = None
    group = None
    bar_groups = None
    bar_checked_at = None
    picture = None
    tried_at = None
    reconnect_after = RECONNECT_SECONDS
    schedule_checked_at = None
    said_about_telegram = None
    said_about_silence = None
    said_alive = None

    try:
        while True:
            now_utc = datetime.now(timezone.utc)

            # 1. Связь с Telegram. Держим, но НЕ ждём её.
            #
            # ⚠️ Раньше служба стояла здесь, пока не дозвонится, и всё
            # остальное стояло вместе с ней. 11.08.2026 это значило бы, что
            # копия базы не сделается никогда: MTProto с Amvera перекрыт,
            # а копия уходит другим путём и в нём не нуждается.
            if reads_telegram and client is None and (
                tried_at is None
                or now_utc - tried_at >= timedelta(seconds=reconnect_after)
            ):
                tried_at = now_utc
                try:
                    client = make_client()
                    group = client.get_entity(int(group_id))
                    log.info(
                        "читаю группу «%s» раз в %d с",
                        getattr(group, "title", "—"),
                        POLL_SECONDS,
                    )
                    if since_day:
                        log.info("при первом запуске беру смены с %s и позже", since_day)
                    # Связь появилась: старая картина устарела, о следующей
                    # пропаже надо сказать сразу, а не через час молчания,
                    # и проверить её тоже сразу, а не через четверть часа.
                    picture = None
                    said_about_telegram = None
                    reconnect_after = RECONNECT_SECONDS
                    # Группы бара ищем заново на каждом подключении: аккаунт
                    # могли добавить в группу, пока робот жил без связи.
                    bar_groups = None
                    bar_checked_at = None
                except ConnectionError as error:
                    client = None
                    # Не вышло — ждём вдвое дольше, но не дольше четверти часа.
                    reconnect_after = min(reconnect_after * 2, RECONNECT_MAX_SECONDS)
                    # Пробуем каждую минуту, а жалуемся раз в час: журнал
                    # листают с конца, и ответ должен попадаться на глаза
                    # в любом его обрывке — но не заслонять собою всё
                    # остальное, как было 13.08.2026.
                    if (
                        said_about_telegram is None
                        or now_utc - said_about_telegram > TELEGRAM_COMPLAIN_EVERY
                    ):
                        log.error("не дозвонился до Telegram: %s", error)
                        if picture is None:
                            picture = probe.summary(probe.check(log))
                        for line in picture:
                            log.error("  %s", line)
                        said_about_telegram = now_utc

            # 2. Чаевые по QR — только когда связь есть.
            if client is not None:
                try:
                    alarm, message = one_pass(client, group, since_day, storage)
                    if alarm:
                        # Тревогу повторяем редко, но повторяем: она должна
                        # попадаться на глаза и через сутки.
                        if (
                            said_about_silence is None
                            or now_utc - said_about_silence > SILENCE_REPEAT
                        ):
                            log.warning("⚠️  %s", message)
                            said_about_silence = now_utc
                    else:
                        said_about_silence = None
                        if said_alive is None or now_utc - said_alive > HEARTBEAT:
                            log.info("жив. %s", message)
                            said_alive = now_utc
                except Exception as error:
                    log.error("заход не удался: %s: %s", type(error).__name__, error)
                    # Связь могла оборваться — пусть следующий круг переподключится.
                    try:
                        client.disconnect()
                    except Exception:
                        pass
                    client = None

            # 2а. Состав и мотивация кальянного бара — раз в четверть часа.
            #
            # Отдельно от QR и со своей ловушкой ошибок: QR — деньги смены
            # прямо сейчас, и сбой чтения бара не должен их останавливать.
            if (
                client is not None
                and getattr(storage, "reads_bar", False)
                and (bar_checked_at is None or now_utc - bar_checked_at >= bar_reader.EVERY)
            ):
                bar_checked_at = now_utc
                try:
                    # Пока какая-то группа не видна — ищем заново на каждом
                    # заходе: 20.10.2026 аккаунт добавили в общий чат, когда
                    # робот уже работал, и без перезапуска он бы этого не узнал.
                    if bar_groups is None or not all(
                        report["видна"] for _e, report in bar_groups.values()
                    ):
                        bar_groups = bar_reader.find_groups(client, log)
                    bar_reader.one_pass(client, bar_groups, storage, log)
                except Exception as error:
                    log.error("бар: заход не удался: %s: %s", type(error).__name__, error)

            # 3. Расписание — всегда, когда есть база: оно не зависит
            #    от связи с Telegram. Без базы дел у расписания нет вовсе,
            #    и лезть в неё каждую минуту значило бы засорять журнал
            #    одной и той же ошибкой про неразрешимое имя.
            if storage.has_database and (
                schedule_checked_at is None
                or now_utc - schedule_checked_at
                >= timedelta(seconds=SCHEDULE_EVERY_SECONDS)
            ):
                schedule_checked_at = now_utc
                try:
                    schedule_pass(datetime.now(core.MOSCOW))
                except Exception as error:
                    log.error(
                        "расписание не отработало: %s: %s", type(error).__name__, error
                    )

            if once:
                log.info("один заход сделан, выхожу")
                break

            time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        log.info("остановлено вручную")

    if client is not None:
        client.disconnect()


if __name__ == "__main__":
    main()
