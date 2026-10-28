/** PT-BR / EN strings for the desktop update banner and Settings → Geral (Fase 22). */
const ptBR = {
  bannerStaged: "Atualização pronta.",
  bannerStagedAction: "Reiniciar",
  bannerAvailable: (version: string) => (version ? `Versão ${version} disponível.` : "Nova versão disponível."),
  bannerAvailableAction: "Baixar",
  bannerSettings: "Configurações",
  updatesHeading: "Atualizações e versão",
  versionLabel: "Versão",
  versionUnknown: "desconhecida",
  autoUpdate: "Atualizar automaticamente",
  autoUpdateHint: "Verifica ao abrir e a cada 6 horas.",
  checkNow: "Verificar agora",
  statusIdle: "Você está na versão mais recente.",
  statusChecking: "Verificando…",
  statusAvailable: "Nova versão disponível.",
  statusDownloading: "Baixando atualização…",
  statusStaged: "Atualização pronta; reinicie para aplicar.",
  statusError: "Falha ao verificar atualizações.",
  statusUnsupported: "Atualizações indisponíveis neste modo.",
};
const en: typeof ptBR = {
  bannerStaged: "Update ready.",
  bannerStagedAction: "Restart",
  bannerAvailable: (version: string) => (version ? `Version ${version} available.` : "New version available."),
  bannerAvailableAction: "Download",
  bannerSettings: "Settings",
  updatesHeading: "Updates and version",
  versionLabel: "Version",
  versionUnknown: "unknown",
  autoUpdate: "Update automatically",
  autoUpdateHint: "Checks on launch and every 6 hours.",
  checkNow: "Check now",
  statusIdle: "You are on the latest version.",
  statusChecking: "Checking…",
  statusAvailable: "New version available.",
  statusDownloading: "Downloading update…",
  statusStaged: "Update ready; restart to apply.",
  statusError: "Could not check for updates.",
  statusUnsupported: "Updates are unavailable in this mode.",
};

export type PlatformText = typeof ptBR;

export function platformText(locale: string): PlatformText {
  return locale.toLowerCase().startsWith("en") ? en : ptBR;
}
