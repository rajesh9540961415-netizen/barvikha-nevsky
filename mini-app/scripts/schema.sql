-- Схема базы для учёта чаевых.
-- Применяется скриптом db-setup.mjs, выполнять можно сколько угодно раз:
-- всё через "if not exists", уже созданное не трогается.

-- Записи о чаевых.
--
-- business_day — текст, а не дата, намеренно: это ключ бизнес-дня заведения
-- с границей 11:00, а не календарное число. В формате ГГГГ-ММ-ДД он сортируется
-- как дата, зато не может съехать на сутки при пересчёте часовых поясов.
--
-- Имена официанта и ответственного хранятся рядом с номерами намеренно:
-- это денежный документ, он должен читаться сам по себе и через год,
-- даже если человек уволился и из справочника Quick Resto пропал.
create table if not exists entries (
  id            uuid          primary key,
  business_day  text          not null,
  hall_id       integer       not null,
  hall_title    text          not null,
  table_id      integer       not null,
  table_title   text          not null,
  waiter_id     integer       not null,
  waiter_name   text          not null,
  amount        numeric(12,2) not null,
  kind          text          not null check (kind in ('cash', 'terminal', 'service')),
  operator_id   integer       not null,
  operator_name text          not null,
  created_at    timestamptz   not null
);

create index if not exists entries_business_day_idx on entries (business_day);

-- Отмена не стирает запись, а помечает её.
--
-- Раньше «Отменить» удаляло строку бесследно, и проверить себя было нельзя:
-- если администратор ошибся, отменил и внёс заново, в базе оставался только
-- последний вариант. Для самопроверки важно видеть и то, что убрали.
--
-- Отменённые не попадают ни в списки, ни в суммы, ни в отчёт — только
-- в историю. Пишем и кто отменил: в смене работают двое.
alter table entries add column if not exists deleted_at       timestamptz;
alter table entries add column if not exists deleted_by_id    integer;
alter table entries add column if not exists deleted_by_name  text;

-- Обычные списки читают только живые записи, поэтому индекс только по ним.
create index if not exists entries_day_alive_idx
  on entries (business_day) where deleted_at is null;

-- Одни чаевые на нескольких официантов.
--
-- Большой стол обслуживают вдвоём, и гость оставляет чаевые за стол целиком.
-- В базу такие чаевые ложатся несколькими строками — по одной на официанта,
-- каждому своя доля: тогда доля попадает в заработок своего человека, а порог
-- 1300 ₽, итоги смены и отчёт продолжают работать без единой правки.
--
-- Общая метка связывает строки в одно событие: по ней история показывает их
-- вместе, а отмена убирает всю группу. Половина чаевых без пары не значит
-- ничего и только испортила бы итог.
--
-- Пусто у обычной записи одному официанту — таких подавляющее большинство.
alter table entries add column if not exists split_group uuid;

create index if not exists entries_split_group_idx
  on entries (split_group) where split_group is not null;

-- Комиссия Сбера с чаевых на терминале.
--
-- Гость оставляет одну сумму, а до официанта доходит меньше: комиссия идёт
-- «с получателя», так помечена каждая строка в выгрузке личного кабинета.
-- Поэтому в amount лежит то, что дошло (им и считаются порог, доли и отчёт),
-- а в gross — то, что оставил гость.
--
-- Ставка хранится в самой записи: если Сбер поменяет тариф, прошлые смены
-- должны остаться такими, какими были.
alter table entries add column if not exists gross           numeric(12,2);
alter table entries add column if not exists commission_rate numeric(5,4) not null default 0;

-- Записи, сделанные до появления комиссии, шли без удержания: там до официанта
-- дошло ровно то, что оставил гость. Выполнять можно сколько угодно раз.
update entries set gross = amount where gross is null;

-- Чаевые по персональному QR.
--
-- Четвёртый вид денег рядом с наличными, терминалом и сервисным сбором.
-- Приходит не из зала: гость платит по QR на чеке, кассир этих денег
-- не видит вовсе — они всплывают только уведомлением Сбера в Telegram.
-- staff — не доход, а вычет: сколько сотрудник проел за смену. Расходы
-- пробиваются в Quick Resto на столе STAFF; через API их не достать, чеки
-- закрыты, поэтому вносит администратор. Лежат здесь же, а не отдельной
-- таблицей: это движение денег смены, у него тот же автор, та же отмена
-- и то же место в истории.
alter table entries drop constraint if exists entries_kind_check;
alter table entries add constraint entries_kind_check
  check (kind in ('cash', 'terminal', 'service', 'qr', 'staff'));

-- У QR-чаевых стола нет: гость платит по чеку, а не за столом.
-- Поэтому стол перестаёт быть обязательным. У всех остальных видов он
-- по-прежнему заполняется — это ключ ко всему остальному учёту.
alter table entries alter column hall_id     drop not null;
alter table entries alter column hall_title  drop not null;
alter table entries alter column table_id    drop not null;
alter table entries alter column table_title drop not null;

-- Поступления по QR: пришло, но ещё не разнесено по людям.
--
-- Сбер знает не человека, а котёл («Официант 5») — в команде несколько
-- участников. Кто именно обслужил гостя, не знает никто, поэтому сумму
-- разносит кассир по составу смены.
--
-- Ключ — идентификатор сообщения в Telegram: чтение можно запускать
-- сколько угодно раз, повторное сообщение не создаст второе поступление.
create table if not exists qr_tips (
  message_id     bigint        primary key,
  received_at    timestamptz   not null,
  business_day   text          not null,
  amount         numeric(12,2) not null,
  team           text          not null,
  -- Когда кассир разнёс сумму по официантам. Пусто — значит ждёт.
  distributed_at timestamptz,
  distributed_by text
);

create index if not exists qr_tips_pending_idx
  on qr_tips (business_day) where distributed_at is null;

-- Состав смены и роли: одна строка на бизнес-день.
create table if not exists shifts (
  business_day text        primary key,
  crew         integer[]   not null,
  operator_id  integer,
  admin_id     integer,
  cashier_id   integer,
  updated_at   timestamptz not null default now()
);

-- Люди, которых нет в Quick Resto: стажёры, подработчики.
-- Номер отрицательный, чтобы никогда не столкнуться с настоящими из кассы.
create table if not exists manual_people (
  id    integer primary key check (id < 0),
  name  text    not null,
  short text    not null
);

-- Одного человека нельзя завести дважды, даже если два администратора
-- впишут его одновременно с разным регистром букв.
create unique index if not exists manual_people_name_idx
  on manual_people (lower(name));
