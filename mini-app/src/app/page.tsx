"use client";

import dynamic from "next/dynamic";

/**
 * Экран рисуется только в браузере.
 *
 * Он опирается на текущее время и на память браузера — на сервере ни того,
 * ни другого нет, и попытка отрисовать заранее давала бы расхождение
 * между серверной и браузерной версиями страницы.
 */
const TipsScreen = dynamic(() => import("@/components/TipsScreen"), {
  ssr: false,
});

export default function Page() {
  return <TipsScreen />;
}
