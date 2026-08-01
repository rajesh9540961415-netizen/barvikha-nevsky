import employees from "@/data/employees.json";
import { addManual, deleteManual, listManual } from "./db/actions";
import type { Employee } from "./types";

/**
 * Кого можно поставить в смену.
 *
 * Основной список — из Quick Resto, лежит файлом в самой сборке и читается
 * мгновенно. Но в смену выходят и те, кого в кассе не завели: стажёры,
 * подработчики. Их администратор дописывает руками прямо на экране смены,
 * и вот они уже в общей базе — их должен видеть и сменщик.
 *
 * У дописанных вручную идентификатор отрицательный — так они никогда
 * не столкнутся с настоящими из Quick Resto.
 */

const FROM_QUICK_RESTO = employees as Employee[];

export function isManual(id: number): boolean {
  return id < 0;
}

export function getQuickRestoPeople(): Employee[] {
  return FROM_QUICK_RESTO;
}

export async function getManualPeople(): Promise<Employee[]> {
  return listManual();
}

/**
 * Добавляет человека вручную. Возвращает обновлённый список дописанных.
 *
 * Совпадение с Quick Resto проверяется здесь: в базе этого списка нет,
 * он живёт файлом в сборке. Совпадение среди уже дописанных ловит сама
 * база — там на имя стоит запрет повторов.
 */
export async function addManualPerson(rawName: string): Promise<Employee[]> {
  const name = rawName.trim().replace(/\s+/g, " ");
  if (!name) return listManual();

  const inQuickResto = FROM_QUICK_RESTO.some(
    (p) => p.name.toLowerCase() === name.toLowerCase(),
  );
  if (inQuickResto) return listManual();

  return addManual(name);
}

export async function removeManualPerson(id: number): Promise<Employee[]> {
  return deleteManual(id);
}
