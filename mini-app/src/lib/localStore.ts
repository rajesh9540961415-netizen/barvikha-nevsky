/**
 * Постоянная память самого телефона.
 *
 * Всё, что здесь лежит, переживает закрытие вкладки и перезагрузку телефона —
 * в отличие от обычных переменных, которые живут, пока открыт экран.
 * Нужна ровно для одного: если сети нет, запись должна где-то дождаться связи,
 * а не исчезнуть вместе с вкладкой.
 *
 * Взят localStorage, а не IndexedDB. Причина простая: запись сюда происходит
 * сразу, до возврата из функции — то есть к моменту, когда экран сказал
 * «записано», данные уже на диске. У IndexedDB запись асинхронная: между
 * «начали писать» и «записалось» есть окно, в которое помещается закрытие
 * вкладки. Объёмы у нас крошечные (130 записей за вечер — это десятки
 * килобайт при разрешённых пяти мегабайтах), так что единственное
 * преимущество IndexedDB — размер — нам не нужно.
 */

/** Есть ли вообще память: на сервере и в закрытом приватном режиме её нет. */
function store(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    // Некоторые браузеры бросают ошибку на самом обращении к localStorage,
    // если хранение запрещено настройками.
    return null;
  }
}

export function hasLocalStore(): boolean {
  const ls = store();
  if (!ls) return false;
  try {
    // Проверяем не наличие объекта, а возможность писать: в приватном режиме
    // объект есть, а запись отказывает.
    ls.setItem("chaevye.probe", "1");
    ls.removeItem("chaevye.probe");
    return true;
  } catch {
    return false;
  }
}

/**
 * Читает сохранённое.
 *
 * Если содержимое испорчено, оно не выбрасывается, а откладывается в сторону
 * под именем с «.broken»: там могут быть деньги смены, и терять их молча
 * нельзя даже когда прочитать не удалось.
 */
export function readLocal<T>(key: string): T | null {
  const ls = store();
  if (!ls) return null;
  const raw = ls.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      ls.setItem(`${key}.broken`, raw);
      ls.removeItem(key);
    } catch {
      // Даже отложить не вышло — оставляем как есть, вдруг починится.
    }
    return null;
  }
}

/** Пишет. Возвращает false, если память отказала — например, кончилось место. */
export function writeLocal(key: string, value: unknown): boolean {
  const ls = store();
  if (!ls) return false;
  try {
    ls.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeLocal(key: string): void {
  const ls = store();
  if (!ls) return;
  try {
    ls.removeItem(key);
  } catch {
    // Не смогли убрать — не беда, лишняя запись никому не мешает.
  }
}
