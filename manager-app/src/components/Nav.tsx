import Link from "next/link";
import { currentManager, signOut } from "@/lib/db/managers";

/**
 * Общая шапка бэк-офиса: разделы вкладками.
 *
 * Появилась 16.08.2026 по просьбе владельца. До неё ссылки на разделы жили
 * только на странице смен, а прочие страницы обходились случайными подписями
 * вроде «весь месяц» и «смены» — по ним было непонятно даже как вернуться.
 *
 * Порядок разделов — владельца: сводка, финансы, чаевые, сотрудники.
 * «Сводка» появилась 07.09.2026 и встала на «/» первой вкладкой, как и было
 * задумано; остальные не сдвинулись. Название — владельца: сначала было
 * «Обзор», она выбрала «Сводка» в тот же день.
 *
 * ⚠️ Управляющему «Сводку» не показываем: это выручка и прибыль, а его экран
 * начинается с чаевых. Сама страница тоже его завернёт — здесь лишь про то,
 * что нарисовать.
 *
 * ⚠️ Ничего не решает про доступ. Финансы и доступ показываются только
 * владельцу — но это лишь про то, что нарисовать. Право смотреть спрашивают
 * сами страницы и, глубже, сами данные: шапка может забыть, данные — нет.
 */
export default async function Nav({ раздел }: { раздел?: string }) {
  const manager = await currentManager();
  // На входе и на смене пароля шапки нет: показывать разделы человеку,
  // который ещё не вошёл, — значит обещать то, чего он не получит.
  if (!manager) return null;

  const вкладки: { ключ: string; подпись: string; адрес: string }[] = [
    ...(manager.role === "owner"
      ? [
          { ключ: "сводка", подпись: "Сводка", адрес: "/" },
          { ключ: "finance", подпись: "Финансы", адрес: "/finance" },
          // Заимствования между площадками. Владельцу и только ей: это долг
          // другого заведения перед нашим, управляющему смотреть там нечего.
          { ключ: "moskva", подпись: "Москва", адрес: "/moskva" },
          // Вознаграждение собственнику. Владельцу и только ей.
          { ключ: "boss", подпись: "Вознаграждение босса", адрес: "/boss" },
        ]
      : []),
    { ключ: "tips", подпись: "Чаевые", адрес: "/tips" },
    { ключ: "motivaciya", подпись: "Мотивация бара", адрес: "/motivaciya" },
    { ключ: "people", подпись: "Сотрудники", адрес: "/people" },
    ...(manager.role === "owner"
      ? [{ ключ: "access", подпись: "Доступ", адрес: "/access" }]
      : []),
  ];

  return (
    <nav className="border-b border-line">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-1 gap-y-2 px-6 py-3">
        {вкладки.map((в) => {
          const выбрана = в.ключ === раздел;
          return (
            <Link
              key={в.ключ}
              href={в.адрес}
              aria-current={выбрана ? "page" : undefined}
              className={
                "rounded-md px-3 py-1.5 text-sm transition-colors " +
                (выбрана
                  ? "bg-sand/15 font-medium text-sand"
                  : "text-fg-muted hover:bg-line/40 hover:text-fg")
              }
            >
              {в.подпись}
            </Link>
          );
        })}

        <span className="ml-auto flex items-baseline gap-4 text-sm text-fg-muted">
          <span className="hidden sm:inline">
            {manager.name} · {manager.role === "owner" ? "владелец" : "управляющий"}
          </span>
          <Link href="/password" className="underline hover:text-fg">
            пароль
          </Link>
          <form action={signOut}>
            <button className="underline hover:text-fg">выйти</button>
          </form>
        </span>
      </div>
    </nav>
  );
}
