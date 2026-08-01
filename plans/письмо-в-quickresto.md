**Кому:** support@quickresto.ru
**Тема:** fk381 — Back Office API: `front.orders` возвращает пустой массив при наличии чеков

---

Здравствуйте!

Спасибо за предыдущий ответ — он помог, доступ к Back Office API мы настроили, и он работает. Отдельные логин и пароль для API заведены в «Предприятие → Настройки → Общие настройки», базовый адрес — `https://fk381.quickresto.ru/platform/online`, авторизация Basic. Общая инструкция по подключению нам уже не нужна, вопрос ниже — про один конкретный раздел.

Облако: **fk381**.

Коротко о цели: автоматизируем учёт чаевых. Нужны поля чека `localCreateDate`, `frontTotalPrice`, `table.title`, `waiter.fullName`, `shiftId`, `documentNumber` — без них невозможно связать чаевые с конкретным официантом и столом.

### Что работает

Под теми же учётными данными корректно читаются:

- `front.zreport` — кассовые смены, 1414 записей, живые данные;
- `personnel.employee` — 19 сотрудников;
- `core.company`, справочники залов и столов.

### Что не работает

Запрос к `moduleName=front.orders`, `className=ru.edgex.quickresto.modules.front.orders.OrderInfo` возвращает **HTTP 200 и пустой массив `[]`**. Ошибки нет. То же самое с `front.preorders`.

При этом за те же даты кассовые смены отдают ненулевой `ordersCount`, то есть чеки в системе точно есть. Например, смена №105 от 30.07.2026: `ordersCount` = 102, `totalCash` = 191 007 ₽, `totalCard` = 428 351 ₽.

Пример запроса (логин и пароль заменены на заглушки):

```bash
curl -sS -u "ЛОГИН:ПАРОЛЬ" -G \
  "https://fk381.quickresto.ru/platform/online/api/list" \
  --data-urlencode "moduleName=front.orders" \
  --data-urlencode "className=ru.edgex.quickresto.modules.front.orders.OrderInfo" \
  --data-urlencode 'filters=[{"field":"localCreateDate","operation":"range","value":{"since":"1785358800000","till":"1785445200000"}}]'
```

Ответ:

```
HTTP/1.1 200
[]
```

Тот же запрос с `moduleName=front.zreport` за тот же период возвращает смены с данными.

### Что уже пробовали

Перебрали семь вариантов записи фильтра — везде HTTP 200 и `[]`:

1. `filters` как JSON-массив (пример выше);
2. `filters` как JSON-объект;
3. параметры вида `filterField[]`;
4. операция `gte`;
5. операция `range`;
6. запрос с телом, содержащим `limit`;
7. метод `POST` вместо `GET`.

### Вопросы

1. Почему `front.orders` отдаёт пустой массив при наличии чеков: это ограничение прав API-пользователя, ограничение тарифа или мы неверно указываем `moduleName`/`className`?
2. Если дело в правах — какое именно право нужно включить и в каком разделе бэк-офиса?
3. Какой корректный формат запроса для выборки чеков за период? Просим пример рабочего `curl`.
4. Дополнительно: есть ли в API способ получить состав смены (какие сотрудники работают в конкретный день) и должности/роли сотрудников? В объекте `Employee` мы видим только `firstName`, `lastName`, `fullName`, `shortName`, `blocked`, `systemEmployee`, `allowedTablesSchemes`, а разделы `personnel.role`, `personnel.position`, `personnel.workshift`, `personnel.timesheet` отвечают HTTP 400.

Будем признательны за ответ по существу — готовы предоставить любые дополнительные логи запросов.

С уважением,
[Имя], ИТ-специалист
ресторан «Барвиха Лаунж Невский»
облако fk381
[контактный e-mail / телефон]
