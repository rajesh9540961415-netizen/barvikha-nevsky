import employees from "@/data/employees.json";
import type { Employee } from "./types";

/**
 * Кого можно поставить в смену.
 *
 * Основной список — из Quick Resto. Но в смену выходят и те, кого
 * в кассе не завели: стажёры, подработчики. Их администратор дописывает
 * руками прямо на экране смены.
 *
 * У дописанных вручную идентификатор отрицательный — так они никогда
 * не столкнутся с настоящими из Quick Resto.
 */

const MANUAL_KEY = "chaevye.people.manual.v1";
const FROM_QUICK_RESTO = employees as Employee[];

function readManual(): Employee[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MANUAL_KEY);
    return raw ? (JSON.parse(raw) as Employee[]) : [];
  } catch {
    return [];
  }
}

function writeManual(people: Employee[]): void {
  window.localStorage.setItem(MANUAL_KEY, JSON.stringify(people));
}

export function isManual(id: number): boolean {
  return id < 0;
}

export function getQuickRestoPeople(): Employee[] {
  return FROM_QUICK_RESTO;
}

export function getManualPeople(): Employee[] {
  return readManual();
}

export function getAllPeople(): Employee[] {
  return [...FROM_QUICK_RESTO, ...readManual()];
}

/** Добавляет человека вручную. Возвращает обновлённый список дописанных. */
export function addManualPerson(rawName: string): Employee[] {
  const name = rawName.trim().replace(/\s+/g, " ");
  if (!name) return readManual();

  const manual = readManual();
  const exists = [...FROM_QUICK_RESTO, ...manual].some(
    (p) => p.name.toLowerCase() === name.toLowerCase(),
  );
  if (exists) return manual;

  const minId = Math.min(0, ...manual.map((p) => p.id));
  const next = [...manual, { id: minId - 1, name, short: name }];
  writeManual(next);
  return next;
}

export function removeManualPerson(id: number): Employee[] {
  const next = readManual().filter((p) => p.id !== id);
  writeManual(next);
  return next;
}
