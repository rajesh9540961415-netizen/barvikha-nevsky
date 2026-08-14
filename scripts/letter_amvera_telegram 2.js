const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, ShadingType, AlignmentType,
} = require("docx");
const fs = require("fs");

const FONT = "Calibri";
const COLS = [4400, 1300, 3300];
const TOTAL = COLS.reduce((a, b) => a + b, 0);

// Обычный абзац с необязательным жирным зачином.
const p = (bold, rest, opts = {}) =>
  new Paragraph({
    spacing: { after: 160 },
    ...opts,
    children: [
      ...(bold ? [new TextRun({ text: bold, bold: true, font: FONT, size: 22 })] : []),
      ...(rest ? [new TextRun({ text: rest, font: FONT, size: 22 })] : []),
    ],
  });

const cell = (text, { head = false, width } = {}) =>
  new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: head ? { type: ShadingType.CLEAR, fill: "F2F2F2" } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [
      new Paragraph({
        children: [new TextRun({ text, bold: head, font: FONT, size: 20 })],
      }),
    ],
  });

const row = (cells, head = false) =>
  new TableRow({
    tableHeader: head,
    children: cells.map((t, i) => cell(t, { head, width: COLS[i] })),
  });

const measurements = [
  ["149.154.167.51 (дата-центр Telegram)", "443", "тишина, тайм-аут"],
  ["149.154.167.51", "80", "тишина, тайм-аут"],
  ["149.154.167.91 (запасной дата-центр Telegram)", "443", "тишина, тайм-аут"],
  ["api.telegram.org", "443", "ответил за 0,3 с"],
  ["ya.ru", "443", "ответил мгновенно"],
];

const questions = [
  [
    "1. ",
    "Ограничиваются ли на вашей площадке исходящие соединения к адресам Telegram " +
      "(диапазоны 149.154.160.0/20 и 91.108.4.0/22)? Нас особенно интересует, почему они " +
      "проходят через раз: это намеренная политика, ограничение по частоте обращений " +
      "или технический сбой?",
  ],
  [
    "2. ",
    "Если это политика — можно ли сделать исключение для нашего приложения chaevye-reader? " +
      "Готовы описать назначение подробнее, если потребуется: служба читает одну служебную " +
      "группу с банковскими уведомлениями и ничего никуда не отправляет.",
  ],
  [
    "3. ",
    "Если исключение невозможно — просим сказать об этом прямо. Тогда мы перенесём эту часть " +
      "на другую площадку, а остальные проекты оставим у вас. Нам важен определённый ответ, " +
      "а не ожидание: пока соединение не работает, наши данные о чаевых сотрудников " +
      "не собираются.",
  ],
];

const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: 22 } } } },
  sections: [
    {
      children: [
        p("Кому: ", "support@amvera.ru"),
        p("Тема: ", "chaevye-reader (регион Москва) — не проходят исходящие соединения к Telegram"),
        new Paragraph({ spacing: { after: 160 }, children: [] }),

        p(null, "Здравствуйте!"),

        p(
          null,
          "Пишем от лица ООО «МАВ» (ресторан «Барвиха Лаунж Невский», Санкт-Петербург). " +
            "У нас в Amvera размещены три проекта, регион «Москва»: приложение chaevye, " +
            "база PostgreSQL chaevye1 и приложение chaevye-reader (тариф «Начальный»)."
        ),

        p(
          null,
          "chaevye-reader — небольшая служба на Python. Она читает служебную группу в Telegram, " +
            "где банк публикует уведомления о чаевых, и складывает суммы в нашу базу. Для этого " +
            "она подключается к Telegram по протоколу MTProto (библиотека Telethon), то есть " +
            "открывает исходящее TCP-соединение к дата-центрам Telegram."
        ),

        p(
          "Эти соединения из контейнера не проходят. ",
          "Проверено 11 августа 2026 года около 16:08 МСК замером из самого контейнера: " +
            "обычное TCP-соединение, тайм-аут 6 секунд."
        ),

        new Table({
          columnWidths: COLS,
          width: { size: TOTAL, type: WidthType.DXA },
          rows: [
            row(["Куда", "Порт", "Результат"], true),
            ...measurements.map((m) => row(m)),
          ],
        }),

        new Paragraph({ spacing: { after: 160 }, children: [] }),

        p(
          null,
          "То есть доступ в интернет у контейнера есть и работает, api.telegram.org тоже доступен — " +
            "не проходят именно прямые соединения к адресам дата-центров Telegram. Соединение " +
            "не отклоняется с ошибкой, а именно молчит до истечения тайм-аута, что похоже " +
            "на отбрасывание пакетов, а не на отсутствие маршрута."
        ),

        p(
          "Важная подробность: соединения пропадают не постоянно, а с перебоями. ",
          "В тот же день, 11 августа около 18:49 МСК, наше приложение успешно подключилось " +
            "к Telegram и прочитало данные, а через полчаса, в 19:24, снова не смогло — " +
            "ни одним из четырёх способов подключения. То есть речь не о наглухо закрытом " +
            "маршруте, а о соединениях, которые то проходят, то нет."
        ),

        p(null, "Никаких сетевых ограничений на своей стороне мы не настраивали."),

        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 160 },
          children: [new TextRun({ text: "Вопросы", font: FONT })],
        }),

        ...questions.map(([n, text]) => p(n, text)),

        p(
          null,
          "Ответ просим по возможности в ближайшие дни — от него зависит, переносить ли нам проект."
        ),

        new Paragraph({ spacing: { after: 160 }, children: [] }),

        p(null, "С уважением,"),
        p(null, "[Должность], [ФИО]"),
        p(null, "ООО «МАВ»"),
        p(null, "[контактный e-mail] · [телефон]"),
      ],
    },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(process.argv[2], buf);
  console.log("готово:", process.argv[2]);
});
