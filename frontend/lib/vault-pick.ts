/**
 * Vault folder choice in the setup: wire type of GET /api/setup/vault-check, PT-BR/EN
 * strings and `vaultHint`/`needsCreateConfirm`. Pure: no fetch, no React.
 */

export type VaultCheckError = "empty" | "relative" | "not_dir" | "not_writable";

export interface VaultCheck {
  ok: boolean;
  error: VaultCheckError | null;
  message: string | null;
  /** Absolute, resolved path (null when `ok` is false). */
  path: string | null;
  exists: boolean;
  obsidian: boolean;
  lapidare: boolean;
  warning?: string | null;
}

export interface VaultPickText {
  choose: string;
  checking: string;
  errors: Record<VaultCheckError, string>;
  lapidare: string;
  obsidian: string;
  folder: string;
  create: (path: string) => string;
  confirmCreate: (path: string) => string;
  confirmAction: string;
  cancel: string;
}

const ptBR: VaultPickText = {
  choose: "Escolher pasta…",
  checking: "Verificando a pasta…",
  errors: {
    empty: "Escolha uma pasta para o Vault.",
    relative: "Use um caminho absoluto (ex.: ~/Documents/MeuVault).",
    not_dir: "Esse caminho é um arquivo, não uma pasta.",
    not_writable: "O Lapidare não tem permissão para escrever nessa pasta.",
  },
  lapidare: "Vault do Lapidare encontrado: será reaberto como está.",
  obsidian: "Vault do Obsidian encontrado: será adotado sem apagar nem sobrescrever nada.",
  folder: "Pasta existente: será adotada sem apagar nem sobrescrever nada.",
  create: (path) => `A pasta ainda não existe. Um Vault novo será criado em ${path}.`,
  confirmCreate: (path) => `A pasta ${path} não existe. Criar um Vault novo nela?`,
  confirmAction: "Criar e concluir",
  cancel: "Voltar",
};

const en: VaultPickText = {
  choose: "Choose folder…",
  checking: "Checking the folder…",
  errors: {
    empty: "Choose a folder for the Vault.",
    relative: "Use an absolute path (e.g. ~/Documents/MyVault).",
    not_dir: "This path is a file, not a folder.",
    not_writable: "Lapidare is not allowed to write to this folder.",
  },
  lapidare: "Lapidare Vault found: it will be reopened as is.",
  obsidian: "Obsidian vault found: it will be adopted without deleting or overwriting anything.",
  folder: "Existing folder: it will be adopted without deleting or overwriting anything.",
  create: (path) => `The folder does not exist yet. A new Vault will be created at ${path}.`,
  confirmCreate: (path) => `The folder ${path} does not exist. Create a new Vault there?`,
  confirmAction: "Create and finish",
  cancel: "Back",
};

export function vaultPickText(locale: string): VaultPickText {
  return locale.toLowerCase().startsWith("en") ? en : ptBR;
}

export interface VaultHint {
  tone: "error" | "ok" | "info";
  message: string;
}

/** One line under the path field describing what finishing the setup will do. */
export function vaultHint(check: VaultCheck | null | undefined, locale: string): VaultHint | null {
  if (!check) return null;
  const t = vaultPickText(locale);
  if (!check.ok) return { tone: "error", message: t.errors[check.error ?? "empty"] ?? check.message ?? "" };
  if (!check.exists) return { tone: "info", message: t.create(check.path ?? "") };
  if (check.lapidare) return { tone: "ok", message: t.lapidare };
  return { tone: "ok", message: check.obsidian ? t.obsidian : t.folder };
}

/** A missing folder needs an explicit "create" before the setup bootstraps a new Vault there. */
export function needsCreateConfirm(check: VaultCheck, confirmedPath: string | null): boolean {
  return check.ok && !check.exists && check.path !== confirmedPath;
}
