import { опознатьБар, type СтрокаЧата } from "../barChat";
import { db } from "./sql";

/**
 * Состав и мотивация кальянного бара из Telegram — запись и состояние.
 *
 * ⚠️ Без «use server» намеренно: всё, что лежит в `actions.ts`, можно вызвать
 * прямо с телефона. Эти функции зовёт только `/api/bar-chat` под ключом.
 *
 * План: `plans/2026-10-20-bar-iz-telegram.md`.
 */

export type ВходящийСостав = {
  messageId: number;
  businessDay: string;
  dayFromText: boolean;
  postedAt: string;
  editedAt: string | null;
  sectionFound: boolean;
  zones: number;
  lines: СтрокаЧата[];
  skeleton: string;
};

export type ПозицияМотивации = { тип: string; штук: number; ставка: number; сумма: number };

export type ВходящаяМотивация = {
  messageId: number;
  businessDay: string;
  dayFromText: boolean;
  postedAt: string;
  editedAt: string | null;
  items: ПозицияМотивации[];
  total: number | null;
  remarks: string[];
  text: string;
};

export type ВходящийИсточник = {
  что: "состав" | "мотивация";
  группа: number | null;
  название: string | null;
  видна: boolean;
  заметка: string;
};

/** По какой день уже есть записи — робот решает, сколько перечитывать. */
export async function barChatState(): Promise<{
  составДо: string | null;
  мотивацияДо: string | null;
}> {
  const [строка] = await db()<{ состав: string | null; мотивация: string | null }[]>`
    select (select max(business_day) from bar_crew_chat)       as "состав",
           (select max(business_day) from bar_motivation_chat) as "мотивация"
  `;
  return { составДо: строка?.состав ?? null, мотивацияДо: строка?.мотивация ?? null };
}

/**
 * Кладёт прочитанное. Пачка — одной транзакцией: либо вся, либо ничего.
 *
 * На день — одна строка, главнее сообщение с бо́льшим номером. То же
 * сообщение, пришедшее с правкой, перезаписывает строку; пришедшее без
 * изменений — не трогает её и в «изменено» не считается: робот присылает
 * одно и то же каждые четверть часа.
 */
export async function saveBarChat(пачка: {
  состав: ВходящийСостав[];
  мотивация: ВходящаяМотивация[];
  источники: ВходящийИсточник[];
}): Promise<{ состав: number; мотивация: number; заметки: string[] }> {
  const заметки: string[] = [];
  let состав = 0;
  let мотивация = 0;

  // По возрастанию номера: из двух сообщений одного дня последнее ляжет последним.
  const составы = [...пачка.состав].sort((a, b) => a.messageId - b.messageId);
  const мотивации = [...пачка.мотивация].sort((a, b) => a.messageId - b.messageId);

  await db().begin(async (tx) => {
    for (const с of составы) {
      const о = опознатьБар(с.lines);
      const легло = await tx`
        insert into bar_crew_chat as t
               (business_day, message_id, posted_at, edited_at, day_from_text,
                lines, skeleton, section_found, zones, crew, names, unknown)
        values (${с.businessDay}, ${с.messageId}, ${с.postedAt}, ${с.editedAt},
                ${с.dayFromText}, ${tx.json(с.lines)}, ${с.skeleton}, ${с.sectionFound},
                ${с.zones}, ${о.crew}, ${tx.json(о.names)}, ${о.unknown})
        on conflict (business_day) do update
           set message_id = excluded.message_id, posted_at = excluded.posted_at,
               edited_at = excluded.edited_at, day_from_text = excluded.day_from_text,
               lines = excluded.lines, skeleton = excluded.skeleton,
               section_found = excluded.section_found, zones = excluded.zones,
               crew = excluded.crew, names = excluded.names, unknown = excluded.unknown,
               received_at = now()
         where excluded.message_id > t.message_id
            or (excluded.message_id = t.message_id
                and row(excluded.edited_at, excluded.lines, excluded.skeleton,
                        excluded.crew, excluded.unknown)
                    is distinct from row(t.edited_at, t.lines, t.skeleton, t.crew, t.unknown))
        returning business_day
      `;
      if (легло.length > 0) {
        состав += 1;
        // Без имён: ответ уезжает в журнал робота за границей.
        заметки.push(
          `состав ${с.businessDay}: опознано ${о.crew.length}` +
            (о.unknown.length ? `, не опознано ${о.unknown.length}` : "") +
            (с.sectionFound ? "" : ", раздела «КАЛЬЯННЫЙ БАР» нет") +
            (с.sectionFound && с.zones !== 5 ? `, зон ${с.zones} вместо пяти` : ""),
        );
      }
    }

    for (const м of мотивации) {
      const легло = await tx`
        insert into bar_motivation_chat as t
               (business_day, message_id, posted_at, edited_at, day_from_text,
                items, total, remarks, text)
        values (${м.businessDay}, ${м.messageId}, ${м.postedAt}, ${м.editedAt},
                ${м.dayFromText}, ${tx.json(м.items)}, ${м.total}, ${м.remarks}, ${м.text})
        on conflict (business_day) do update
           set message_id = excluded.message_id, posted_at = excluded.posted_at,
               edited_at = excluded.edited_at, day_from_text = excluded.day_from_text,
               items = excluded.items, total = excluded.total,
               remarks = excluded.remarks, text = excluded.text, received_at = now()
         where excluded.message_id > t.message_id
            or (excluded.message_id = t.message_id
                and row(excluded.edited_at, excluded.items, excluded.text)
                    is distinct from row(t.edited_at, t.items, t.text))
        returning business_day
      `;
      if (легло.length > 0) {
        мотивация += 1;
        заметки.push(
          `мотивация ${м.businessDay}: типов ${м.items.length}, итог ${м.total ?? "—"}` +
            (м.remarks.length ? `, замечаний к арифметике ${м.remarks.length}` : ""),
        );
      }
    }

    for (const и of пачка.источники) {
      await tx`
        insert into tg_sources (source, chat_id, title, seen, note, checked_at)
        values (${и.что}, ${и.группа}, ${и.название}, ${и.видна}, ${и.заметка}, now())
        on conflict (source) do update
           set chat_id = excluded.chat_id, title = excluded.title, seen = excluded.seen,
               note = excluded.note, checked_at = excluded.checked_at
      `;
    }
  });

  return { состав, мотивация, заметки };
}
