import { listAccess } from "@/lib/db/managers";
import AccessScreen from "./AccessScreen";

export const dynamic = "force-dynamic";

/**
 * Кто может заходить в бэк-офис. Экран владельца.
 *
 * Проверка прав не здесь, а внутри `listAccess`: страница может забыть
 * спросить, а данные — нет. Не владельца оно уводит на сводку.
 */
export default async function AccessPage() {
  const people = await listAccess();
  return <AccessScreen people={people} />;
}
