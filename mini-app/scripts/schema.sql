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
