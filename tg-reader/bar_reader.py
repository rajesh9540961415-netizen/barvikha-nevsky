"""Состав и мотивация кальянного бара из двух групп Telegram.

Заведено 20.10.2026. Зачем: мотивацию бара делят поровну между теми, кто
в этот вечер работал (так считает таблица УК). Состав смены бара в приложении
отмечают не всегда, а в 8–19.10.2026 приложение не работало вовсе — смены
шли на бумаге, и бара на листах нет. Зато администратор каждый вечер пишет
в два чата:

    «НЕВСКИЙ | ОБЩИЙ ЧАТ»  «РАСПРЕДЕЛЕНИЕ ДД.ММ.ГГ» — кто на какой зоне;
    «НЕВСКИЙ | АДМИН»      «Мотивация кальянного бара» — продажи по типам.

Оба разбираются в `bar_parse.py`, а уходят приложению смены на
`/api/bar-chat` тем же ключом, что QR. Базы у варшавского робота нет.

⚠️ **Через границу теперь едут имена.** До 20.10.2026 этот поток вёз только
суммы и котлы. Владелец решила это сознательно: без имён состав бара взять
неоткуда. Везём минимум — строки раздела «КАЛЬЯННЫЙ БАР» и «КМ», а не всё
распределение с залом, кухней и охраной.

⚠️ **Аккаунт робота может не состоять в этих группах.** Раньше оба чата
читали с Мака, под отдельным аккаунтом. Поэтому робот сам проверяет, видит ли
он каждую группу, и отдаёт ответ приложению — его видно служебной дверью
бэк-офиса, без панели Amvera.

Настройки:

    TG_ADMIN_GROUP_ID   «НЕВСКИЙ | АДМИН», по умолчанию -1002111693197
    TG_CREW_GROUP_ID    «НЕВСКИЙ | ОБЩИЙ ЧАТ»; не задан — ищем по названию
    BAR_SINCE_DAY       с какой смены читать, когда в базе ещё пусто
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import qr_reader as core
from bar_parse import разобрать_мотивацию, разобрать_распределение

ADMIN_GROUP_ID = -1002111693197

# Раз в четверть часа, а не раз в минуту: распределение пишут раз в вечер,
# отчёт — раз в ночь. Минутный опрос двух лишних групп ничего не ускорит,
# а запросов к Telegram станет втрое больше.
EVERY = timedelta(minutes=15)

# Сколько дней назад перечитывать каждый раз. Не «только новое по номеру»,
# потому что администратор правит распределение задним числом — подмена
# в баре случается примерно раз в неделю (владелец 09.09.2026). Правка
# сообщения номер не меняет, и чтение «после последнего номера» её не увидит.
WINDOW_DAYS = 3

# При пустой базе — сколько дней назад читать, если BAR_SINCE_DAY не задан.
# С запасом: робот могут выложить не сразу, а нужны 8–19.10.2026.
FIRST_RUN_DAYS = 30

# Предохранитель: общий чат живой, и без потолка первое чтение могло бы
# тянуть историю за год.
MAX_MESSAGES = 6000


def _подпись(entity) -> str:
    return getattr(entity, "title", None) or "—"


# Латинские буквы, неотличимые на глаз от русских. 20.10.2026 робот не нашёл
# «НЕВСКИЙ | ОБЩИЙ ЧАТ» по названию, хотя владелец подтвердила, что аккаунт
# в группе: «HEBCKИЙ» с латинскими H, E, B, C выглядит так же, а поиск
# по «невск» его не видит.
_ДВОЙНИКИ = str.maketrans("aeopcxykmthbABEKMHOPCTXY", "аеорсхукмтнвАВЕКМНОРСТХУ")


def _ключ(название: str) -> str:
    """Название для сравнения: строчные, латинские двойники — русскими, ё → е."""
    return " ".join(название.translate(_ДВОЙНИКИ).lower().replace("ё", "е").split())


def _общий_чат(название: str) -> bool:
    к = _ключ(название)
    return "общ" in к and "чат" in к and "невск" in к


def _свежесть(dialog) -> str | None:
    when = getattr(dialog, "date", None)
    return when.astimezone(timezone.utc).isoformat() if when else None


def find_groups(client, log) -> dict:
    """Какие из двух групп аккаунт видит. Отдаёт {что: (группа | None, отчёт)}.

    Перебираем диалоги один раз: и для поиска общего чата по названию,
    и чтобы Telegram отдал ключи доступа к группе по номеру.

    ⚠️ Названия «Сберчаевые Нев» в августе оказалось две, и живая была
    одна (см. README). Поэтому при нескольких «ОБЩИЙ ЧАТ» берём ту, где
    последнее сообщение свежее, и называем в отчёте все.
    """
    admin_id = int(os.environ.get("TG_ADMIN_GROUP_ID") or ADMIN_GROUP_ID)
    crew_env = (os.environ.get("TG_CREW_GROUP_ID") or "").strip()

    groups = []
    for dialog in client.iter_dialogs():
        if not (dialog.is_group or dialog.is_channel):
            continue
        groups.append(dialog)

    found = {}

    admin = next((d for d in groups if d.id == admin_id), None)
    found["мотивация"] = (
        admin.entity if admin else None,
        {
            "что": "мотивация",
            "группа": admin_id,
            "название": _подпись(admin.entity) if admin else None,
            "видна": admin is not None,
            "заметка": (
                f"последнее сообщение {_свежесть(admin)}"
                if admin
                else "аккаунт робота в этой группе не состоит — нужно добавить"
            ),
        },
    )

    if crew_env:
        crew = next((d for d in groups if d.id == int(crew_env)), None)
        candidates = [crew] if crew else []
        how = f"номер {crew_env} из TG_CREW_GROUP_ID"
    else:
        candidates = sorted(
            (
                d
                for d in groups
                if _общий_чат(_подпись(d.entity))
            ),
            key=lambda d: d.date or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )
        crew = candidates[0] if candidates else None
        how = "по названию"

    if crew:
        note = f"найдена {how}, последнее сообщение {_свежесть(crew)}"
        if len(candidates) > 1:
            note += "; групп с таким названием несколько: " + ", ".join(
                f"{d.id} ({_свежесть(d)})" for d in candidates
            )
    else:
        # Какие похожие группы аккаунт видит — с «невск», «общ» или «чат»
        # в названии, с номером. Все группы аккаунта сюда не нужны: у него
        # есть и чужие переписки (замер 04.08.2026).
        near = [
            f"«{_подпись(d.entity)}» {d.id}"
            for d in groups
            if any(с in _ключ(_подпись(d.entity)) for с in ("невск", "общ", "чат"))
        ]
        note = (
            f"не найдена ({how}): ни у одной из {len(groups)} групп аккаунта нет в названии "
            f"«Невск», «общ» и «чат» сразу. Похожие: {'; '.join(near) or 'ни одной'}. "
            "Если общий чат среди них — задать его номер в TG_CREW_GROUP_ID"
        )
    found["состав"] = (
        crew.entity if crew else None,
        {
            "что": "состав",
            "группа": crew.id if crew else (int(crew_env) if crew_env else None),
            "название": _подпись(crew.entity) if crew else None,
            "видна": crew is not None,
            "заметка": note,
        },
    )

    for what, (_entity, report) in found.items():
        if report["видна"]:
            log.info("бар: группа «%s» (%s) видна — %s", report["название"], what, report["заметка"])
        else:
            log.warning("⚠️  бар: группа для «%s» НЕ видна — %s", what, report["заметка"])
    return found


def _since(state_day: str | None) -> datetime:
    """С какого момента читать: окно в несколько дней или первый заход."""
    now = datetime.now(timezone.utc)
    if state_day:
        return now - timedelta(days=WINDOW_DAYS)
    first = os.environ.get("BAR_SINCE_DAY")
    if first:
        # Смена дня начинается в 11:00 по Москве; берём с запасом — с полуночи.
        return datetime.fromisoformat(first).replace(tzinfo=core.MOSCOW)
    return now - timedelta(days=FIRST_RUN_DAYS)


def _when(moment) -> str | None:
    return moment.isoformat() if moment else None


def _messages(client, entity, since: datetime, log):
    """Сообщения группы от новых к старым — до `since` или до потолка.

    ⚠️ Упёрлись в потолок, не дойдя до `since`, — говорим об этом громко:
    молча недочитанный период выглядит так же, как «распределения не было».
    """
    seen = 0
    for message in client.iter_messages(entity, limit=MAX_MESSAGES):
        if message.date < since:
            return
        seen += 1
        yield message
    if seen >= MAX_MESSAGES:
        log.warning(
            "⚠️  бар: «%s» — прочитано %d сообщений, а до %s не дошёл. "
            "Старше этого не видно: поднять MAX_MESSAGES в bar_reader.py",
            _подпись(entity), seen, since.date(),
        )


def collect_crew(client, entity, since: datetime, log):
    """«РАСПРЕДЕЛЕНИЕ» за период: по записи на сообщение."""
    found = []
    for message in _messages(client, entity, since, log):
        parsed = разобрать_распределение(message.message or "")
        if parsed is None:
            continue
        day = parsed.день or core.business_day(message.date)[0]
        found.append(
            {
                "messageId": message.id,
                "businessDay": day,
                "dayFromText": parsed.день is not None,
                "postedAt": _when(message.date),
                "editedAt": _when(message.edit_date),
                "sectionFound": parsed.раздел_найден,
                "zones": parsed.зон_в_разделе,
                "lines": [{"зона": с.зона, "текст": с.текст} for с in parsed.строки],
                "skeleton": parsed.скелет,
            }
        )
    return found


def collect_motivation(client, entity, since: datetime, log):
    """«Мотивация кальянного бара» за период: по записи на сообщение.

    ⚠️ День берём из ТЕКСТА отчёта, а не по времени отправки: отчёт пишут
    ночью или под утро, и календарная дата сообщения — уже следующий день.
    """
    found = []
    for message in _messages(client, entity, since, log):
        parsed = разобрать_мотивацию(message.message or "")
        if parsed is None:
            continue
        day = parsed.день or core.business_day(message.date)[0]
        found.append(
            {
                "messageId": message.id,
                "businessDay": day,
                "dayFromText": parsed.день is not None,
                "postedAt": _when(message.date),
                "editedAt": _when(message.edit_date),
                "items": [
                    {"тип": п.тип, "штук": п.штук, "ставка": п.ставка, "сумма": п.сумма}
                    for п in parsed.позиции
                ],
                "total": parsed.итог,
                "remarks": parsed.замечания,
                "text": message.message,
            }
        )
    return found


def one_pass(client, groups: dict, storage, log) -> None:
    """Прочитать обе группы за окно и отдать приложению."""
    state = storage.bar_state()
    payload = {"источники": [report for _e, report in groups.values()]}

    crew_entity, _ = groups["состав"]
    if crew_entity is not None:
        payload["состав"] = collect_crew(client, crew_entity, _since(state.get("составДо")), log)

    motivation_entity, _ = groups["мотивация"]
    if motivation_entity is not None:
        payload["мотивация"] = collect_motivation(
            client, motivation_entity, _since(state.get("мотивацияДо")), log
        )

    answer = storage.bar_store(payload)
    changed = answer.get("изменено") or {}
    if any(changed.values()):
        log.info(
            "бар: записано — состав %d, мотивация %d (новые дни и правки)",
            changed.get("состав", 0),
            changed.get("мотивация", 0),
        )
        for line in answer.get("заметки") or []:
            log.info("  %s", line)
