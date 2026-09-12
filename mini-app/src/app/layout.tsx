import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { СТОРОЖ_ЧЁРНОГО_ЭКРАНА } from "@/lib/storozhEkrana";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "cyrillic"],
});

export const metadata: Metadata = {
  title: "Чаевые · Барвиха Невский",
  description: "Учёт наличных чаевых по столам",
};

export const viewport: Viewport = {
  themeColor: "#0c0c0e",
  // Экран не должен ездить при быстрых нажатиях по клавиатуре.
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" className={`${geistSans.variable} h-full antialiased`}>
      {/* ⚠️ Сторож чёрного экрана — до всего остального и прямо в HTML.
          Ночью администратору некому сказать «почистите данные сайта»:
          пустой экран посреди смены означает, что чаевые не внести вовсе. */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: СТОРОЖ_ЧЁРНОГО_ЭКРАНА }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
