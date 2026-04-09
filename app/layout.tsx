import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "leaflet/dist/leaflet.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"]
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "600"]
});

export const metadata: Metadata = {
  title: "VoltPath AI",
  description: "AI-driven EV routing based on distance, time of day, station availability, and dynamic charging prices."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${dmSans.variable} ${jetbrainsMono.variable}`}>
      <body className={dmSans.className}>{children}</body>
    </html>
  );
}
