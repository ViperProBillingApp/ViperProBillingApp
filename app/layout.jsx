import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { themeCss, THEME_BOOT_SCRIPT, DEFAULT_THEME } from "@/lib/brand";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata = {
  title: "ViperPro · Client Billing CRM",
  description: "Client Billing CRM and collections for VIP Event Resources",
};

export default function RootLayout({ children }) {
  return (
    // data-theme is rewritten before paint by THEME_BOOT_SCRIPT when a look
    // has been saved, so React must not complain about the mismatch.
    <html lang="en" className={cn("font-sans", geist.variable)} data-theme={DEFAULT_THEME} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <style dangerouslySetInnerHTML={{ __html: themeCss() }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Jost:wght@300;400;500;600;700&family=Hanken+Grotesk:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
