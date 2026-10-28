import { palette } from "@/lib/palette";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServerEventsProvider } from "@/components/server-events";
import { LocaleProvider } from "@/components/locale-provider";
import { Sidebar } from "@/components/sidebar";
import { SetupGate } from "@/components/setup-gate";
import { AppearanceApplier } from "@/components/appearance-applier";
import { UpdateBanner } from "@/components/update-banner";
import { GlobalShortcuts } from "@/components/global-shortcuts";

export const metadata: Metadata = {
  title: "Lapidare",
  description:
    "Lapidare — estudo ativo local-first com o ecossistema Google e persistência no Vault Obsidian",
  // Icons come from the file convention: app/favicon.ico, app/icon.png, app/apple-icon.png.
};

export const viewport: Viewport = {
  themeColor: palette.background,
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className="dark">
      <body className="bg-background text-foreground min-h-screen antialiased select-text">
        <AppearanceApplier />
        <ServerEventsProvider>
          <LocaleProvider>
          <div className="flex h-screen w-screen overflow-hidden bg-background">
            <Sidebar />
            <div className="flex flex-1 min-w-0 h-screen flex-col">
              <UpdateBanner />
              <main className="flex-1 min-h-0 overflow-y-auto flex flex-col bg-background">
                {children}
              </main>
            </div>
          </div>
          <SetupGate />
          <GlobalShortcuts />
          </LocaleProvider>
        </ServerEventsProvider>
      </body>
    </html>
  );
}
