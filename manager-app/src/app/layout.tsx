import type { Metadata } from "next";
import { СТОРОЖ_ЧЁРНОГО_ЭКРАНА } from "@/lib/storozhEkrana";
import "./globals.css";

export const metadata: Metadata = {
  title: "Бэк-офис · Барвиха Невский",
  description: "Отчёты и исправления по чаевым",
};

// Шрифт не подгружаем со стороны: бэк-офис открывают на компьютере, где
// системный шрифт и так хорош, а лишняя внешняя зависимость — лишний способ
// не собраться в неудачный момент.
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" className="h-full antialiased">
      <head>
        <script dangerouslySetInnerHTML={{ __html: СТОРОЖ_ЧЁРНОГО_ЭКРАНА }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
