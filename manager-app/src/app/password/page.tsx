import { redirect } from "next/navigation";
import { currentManager } from "@/lib/db/managers";
import PasswordForm from "./PasswordForm";

export const dynamic = "force-dynamic";

/**
 * ⚠️ Эта страница НЕ пользуется `requireManager()` намеренно.
 *
 * `requireManager` уводит на `/password` тех, кто не сменил выданный пароль.
 * Позови его отсюда — и человек, которому как раз сюда и надо, ходил бы
 * кругами между этой страницей и ею же.
 */
export default async function PasswordPage() {
  const manager = await currentManager();
  if (!manager) redirect("/login");

  return <PasswordForm mustChange={manager.mustChangePassword} />;
}
