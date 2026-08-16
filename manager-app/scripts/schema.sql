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

-- Когда смену выгрузили для отчёта и кто это сделал.
--
-- Раньше выгрузка не оставляла следа вовсе: администратор нажимал кнопку,
-- файл падал в загрузки, а на экране не менялось ничего. Выгрузил или нет,
-- выгрузил ли уже сменщик — узнать было неоткуда, и смену выгружали по
-- второму разу либо не выгружали совсем.
--
-- В базе, а не в памяти телефона, намеренно: вопрос «эту смену выгружали?»
-- задают позже и часто не с того телефона, где нажимали кнопку.
--
-- Заодно это дата, которой не хватало, чтобы помечать смену как тронутую
-- ПОСЛЕ выгрузки — см. plans/2026-08-03-upravlencheskiy-blok.md, фаза 3.5.
alter table shifts add column if not exists exported_at timestamptz;
alter table shifts add column if not exists exported_by text;

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

-- ─────────────────────────────────────────────────────────────────────
-- Исправления
-- ─────────────────────────────────────────────────────────────────────
--
-- Исправление НЕ переписывает запись, а заменяет её: старая помечается
-- отменённой (это уже умеет `deleted_at`), новая ссылается на неё.
--
-- Почему не править на месте. Это денежный документ, и через год должно
-- быть видно не только «сколько», но и «что было до того, как поправили,
-- кто поправил и когда». Правка на месте стирает первое и превращает
-- историю в пересказ победителя.
alter table entries add column if not exists corrects uuid;

create index if not exists entries_corrects_idx
  on entries (corrects) where corrects is not null;

-- Откуда пришла запись: из приложения смены или из бэк-офиса.
--
-- Смена правит только свою смену и только в ту же ночь. Бэк-офис — любой
-- период. По этому полю сразу видно, вмешивались ли в смену задним числом.
alter table entries add column if not exists source text not null default 'shift'
  check (source in ('shift', 'office'));

-- Управляющий, сделавший запись из бэк-офиса. У записей смены пусто.
alter table entries add column if not exists manager_id integer;

-- Автор записи из бэк-офиса — не сотрудник смены, и номера сотрудника
-- у него нет. Поэтому operator_id перестаёт быть обязательным, но взамен
-- появляется требование: автор должен быть указан хоть каким-то способом.
alter table entries alter column operator_id drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'entries_author_present') then
    alter table entries add constraint entries_author_present
      check (operator_id is not null or manager_id is not null);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Управляющий состав
-- ─────────────────────────────────────────────────────────────────────
--
-- Вход в бэк-офис — по людям, а не общим паролем. Решение владельца
-- 04.08.2026: заходить будут трое, потом до пяти-шести.
--
-- Дело не в безопасности как таковой: под общим паролем правка денег
-- подписывалась бы должностью, а не именем, и спросить «почему так»
-- было бы не у кого. Это ровно то, от чего уходили, бросая бумагу.
--
-- Роли различаются не тем, что видят — видят все и всё, включая заработки
-- поимённо, — а тем, что могут править:
--   manager — факты: сумма, официант, вид денег, состав смены;
--   owner   — правила: порог, доли, ставка комиссии, закрытые месяцы.
create table if not exists managers (
  id            serial      primary key,
  name          text        not null,
  login         text        not null unique,
  password_hash text        not null,
  role          text        not null check (role in ('owner', 'manager')),
  -- Уволившегося отключаем, а не удаляем: вместе с ним ушла бы история
  -- его правок, а это денежный след.
  active        boolean     not null default true,
  created_at    timestamptz not null default now()
);

-- Журнал входов. На шести людях с правом менять деньги это перестаёт быть
-- излишеством. Неудачные попытки тоже пишем — по ним видно подбор пароля;
-- у них manager_id пуст, а введённый логин сохраняется.
-- Пароль выдан, но человек им ещё не пользовался как своим.
--
-- Выданный пароль случайный и показывается один раз: человек его куда-то
-- запишет, и записанное живёт дольше нужного. Поэтому при первом входе
-- бэк-офис требует сменить пароль на свой — решение владельца 14.08.2026.
--
-- ⚠️ По умолчанию `false`, и это намеренно: у тех, кто заведён до появления
-- экранов паролей, ничего не меняется. Иначе запасной вход `zapas`, пароль
-- которого лежит в надёжном месте, потребовал бы смены — и перестал бы быть
-- запасным ровно в тот момент, когда он нужен.
alter table managers add column if not exists must_change_password boolean not null default false;

create table if not exists manager_logins (
  id         bigserial   primary key,
  login      text        not null,
  manager_id integer     references managers (id),
  ok         boolean     not null,
  at         timestamptz not null default now()
);

create index if not exists manager_logins_at_idx on manager_logins (at desc);

-- ─────────────────────────────────────────────────────────────────────
-- След правки: кто, когда, зачем
-- ─────────────────────────────────────────────────────────────────────
--
-- Ссылка `corrects` выше говорит, ЧТО заменили. Здесь — КТО и ЗАЧЕМ.
--
-- Управляющий, отменивший запись из бэк-офиса, — не сотрудник смены,
-- и номера сотрудника у него нет. Класть его в `deleted_by_id` нельзя:
-- номера управляющих и номера сотрудников из Quick Resto считаются
-- независимо и однажды совпадут — тогда отмену припишут не тому человеку.
alter table entries add column if not exists deleted_by_manager_id integer
  references managers (id);

-- Зачем поправили и зачем отменили. Поля разные, потому что запись,
-- созданную одной правкой, потом могут отменить другой: одно поле
-- хранило бы только последнее объяснение, а первое теряло бы молча.
--
-- Заполнять не обязательно — решение владельца 07.08.2026: на мелких
-- правках обязательное поле превращается в отписку «правка», и толку
-- от него меньше, чем помех.
alter table entries add column if not exists note         text;
alter table entries add column if not exists deleted_note text;

-- История правок состава смены.
--
-- Своей таблицей, а не по образцу записей: у `shifts` одна строка
-- на бизнес-день, и правка её переписывает — следа не остаётся вовсе.
-- А состав и роли определяют всю раскладку денег: сменился кассир —
-- сменился и тот, кому уходит доля.
--
-- Было и стало храним целиком, а не разницей: разницу нельзя прочитать,
-- не восстанавливая всю цепочку с самого начала.
create table if not exists shift_changes (
  id           bigserial   primary key,
  business_day text        not null,
  manager_id   integer     not null references managers (id),
  -- Имя рядом с номером намеренно, как и в записях: это денежный след,
  -- он должен читаться сам по себе и через год.
  manager_name text        not null,
  at           timestamptz not null default now(),
  before_state jsonb       not null,
  after_state  jsonb       not null,
  note         text
);

create index if not exists shift_changes_day_idx
  on shift_changes (business_day, at desc);

-- ─────────────────────────────────────────────────────────────────────────
-- РАЗДЕЛ «ФИНАНСЫ» БЭК-ОФИСА. План: plans/2026-08-15-razdel-finansy.md
-- ─────────────────────────────────────────────────────────────────────────
--
-- ⚠️ Таблицы нужны бэк-офису, а описаны здесь — потому что схема общая
-- и `npm run copies` копирует её ОТСЮДА в бэк-офис, а не наоборот.
-- Правка в manager-app/scripts/schema.sql будет молча затёрта при первой же
-- сборке: `prebuild` вызывает проверку копий. Проверено 15.08.2026, дважды.
--
-- Приложение смены этими таблицами не пользуется вовсе, и это нормально:
-- схема одна на общую базу, а не на приложение.
--
-- Форма — ДДС, решение владельца 15.08.2026: расходы стоят по дням, а не
-- свалены в месяц, и на этом ритме строится план платежей.
--
-- Данные приходят снаружи, адресом /api/finance/import бэк-офиса. Иначе
-- не выходит: выписки приезжают в почту владельца, то есть на её Мак,
-- а с Мака до этой базы не достучаться — VPN incy перехватывает соединения.
-- Тот же приём год работает на QR-чаевых, см. api/qr-tips/route.ts.

-- Одна строка = один платёж. Плоско, без вложенности: так же лежат данные
-- в bank_classified.csv, и разбирать их по дороге незачем.
create table if not exists fin_operations (
  id             bigserial     primary key,
  day            text          not null,        -- ГГГГ-ММ-ДД
  source         text          not null check (source in ('bank', 'cash')),
  entity         text,                          -- юрлицо: mav / ip_shalaeva / ...
  account        text,                          -- счёт; у наличных пусто
  direction      text          not null check (direction in ('in', 'out')),
  amount         numeric(14,2) not null,
  counterparty   text,
  article        text,                          -- статья расхода, одна из 20
  -- Род платежа из fin_classify.py:
  --   external   — настоящий расход или поступление
  --   internal   — перекладывание денег между своими счетами
  --   withdrawal — вывод собственнику
  --
  -- ⚠️ Нужен отдельным полем. В форме владельца «Расходы» и «Без
  -- вознаграждения» — разные колонки, и разница между ними ровно
  -- withdrawal. Через пустую статью это не вывести: у неопознанного
  -- расхода статья тоже пустая, и он слился бы с переводами.
  op_class       text,
  purpose        text,
  doc_no         text,
  why            text,                          -- почему размечено именно так
  -- Ключ повтора. Отправили те же строки дважды — база их не удвоила.
  --
  -- ⚠️ Без этого первая же повторная отправка тихо удвоит расходы месяца,
  -- и заметить это по суммам почти невозможно: они просто станут больше.
  -- Ключ считает бэк-офис, а не отправитель: правило защиты должно жить
  -- рядом с ограничением, которое его держит.
  dedup_key      text          not null unique,
  loaded_at      timestamptz   not null default now()
);

create index if not exists fin_operations_day_idx
  on fin_operations (day);
create index if not exists fin_operations_article_idx
  on fin_operations (article, day);

-- День целиком: то, что в файле владельца стоит верхним блоком.
create table if not exists fin_days (
  day             text          primary key,     -- ГГГГ-ММ-ДД
  revenue_card    numeric(14,2),
  revenue_cash    numeric(14,2),
  tables_count    integer,
  checks_count    integer,
  balance_total   numeric(14,2),                 -- деньги на счетах на конец дня
  updated_at      timestamptz   not null default now()
);

-- Выручка того же дня, но врозь по юрлицам.
--
-- ⚠️ Отдельной таблицей, а не колонками в fin_days. Юрлиц сейчас два с кассами,
-- было одно до 07.07.2026 и будет иначе через полгода — колонки пришлось бы
-- заводить под каждое. Строка на пару «день + юрлицо» переживает это молча.
--
-- ⚠️ И это НЕ дубль fin_days: там выручка заведения целиком, здесь её состав.
-- Складывать одно из другого экран не станет — итог берётся из fin_days,
-- разбивка отсюда. Если они разойдутся, это видно сразу, а не сглаживается.
create table if not exists fin_revenue (
  day           text          not null,          -- ГГГГ-ММ-ДД
  entity        text          not null,          -- mav / ip_shalaeva / …
  revenue_card  numeric(14,2),
  revenue_cash  numeric(14,2),
  checks_count  integer,
  updated_at    timestamptz   not null default now(),
  primary key (day, entity)
);

-- Остатки на счетах по дням: сколько было на начало, сколько стало на конец.
--
-- Приходят из той же выписки 1С, что и платежи, — поля НачальныйОстаток,
-- ВсегоСписано, ВсегоПоступило, КонечныйОстаток. Разбирались с мая 2024
-- и не использовались нигде: экраны показывали только остаток на конец,
-- да и тот общей суммой. Владелец 16.08.2026 спросила, видим ли мы остаток
-- на начало дня, — оказалось, что видим и выбрасываем.
--
-- ⚠️ Отдельной таблицей, а не колонками в fin_days: остаток бывает у счёта,
-- а не у заведения. Счетов пять, у каждого свой день, и складывать их
-- в одну строку значило бы потерять, на каком счёте деньги лежат.
--
-- 💡 Пара «списано/поступило» хранится не для красоты: она позволяет
-- проверить день, не поднимая платежи, — начало плюс поступило минус
-- списано обязано дать конец.
create table if not exists fin_balances (
  day           text          not null,          -- ГГГГ-ММ-ДД
  account       text          not null,          -- номер счёта
  entity        text,                            -- чей счёт; для подписи
  opening       numeric(14,2),
  debit         numeric(14,2),                   -- всего списано за день
  credit        numeric(14,2),                   -- всего поступило за день
  closing       numeric(14,2),
  updated_at    timestamptz   not null default now(),
  primary key (day, account)
);


-- Докуда доведён каждый источник.
--
-- ⚠️ Отдельной таблицей, а не «последней датой в fin_operations». Последняя
-- дата отвечает на вопрос «когда был последний платёж», а нужен ответ
-- на другой — «докуда мы вообще смотрели». Три дня без наличных расходов
-- это не пробел, а просто три дня без расходов; экран, построенный
-- на последней дате, пугал бы пропуском, которого нет.
create table if not exists fin_sources (
  source      text        primary key,           -- 'bank' / 'cash'
  filled_to   text        not null,              -- ГГГГ-ММ-ДД, докуда данные
  updated_at  timestamptz not null default now()
);
