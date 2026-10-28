/**
 * Desktop update state (Fase 22). Pure: types, the `window.lapidare` bridge
 * contract (exposed by desktop/preload.cjs) and `bannerFor`.
 */
import { platformText } from "./platform-i18n";

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "staged" | "error" | "unsupported";

export interface UpdateState {
  status: UpdateStatus;
  mode: "auto" | "notify";
  autoUpdate: boolean;
  version?: string;
  error?: string;
}

export interface LapidareBridge {
  appVersion: string;
  updates: {
    getState(): Promise<UpdateState>;
    onState(cb: (state: UpdateState) => void): () => void;
    check(): Promise<unknown> | void;
    restart(): Promise<unknown> | void;
    openRelease(): Promise<unknown> | void;
    setAuto(on: boolean): Promise<unknown> | void;
  };
  /** Native folder picker (absent in builds before it existed and in the browser). */
  vault?: {
    pick(current: string): Promise<string | null>;
  };
}

declare global {
  interface Window {
    lapidare?: LapidareBridge;
  }
}

/** The bridge, or undefined outside the desktop app (and during SSR). */
export function getBridge(): LapidareBridge | undefined {
  return typeof window === "undefined" ? undefined : window.lapidare;
}

export interface BannerSpec {
  kind: "restart" | "download";
  message: string;
  action: string;
  settingsLabel: string;
}

export function bannerFor(state: UpdateState | null | undefined, locale: string): BannerSpec | null {
  if (!state) return null;
  const t = platformText(locale);
  if (state.status === "staged") {
    return { kind: "restart", message: t.bannerStaged, action: t.bannerStagedAction, settingsLabel: t.bannerSettings };
  }
  if (state.status === "available" && state.mode === "notify") {
    return {
      kind: "download",
      message: t.bannerAvailable(state.version ?? ""),
      action: t.bannerAvailableAction,
      settingsLabel: t.bannerSettings,
    };
  }
  return null;
}

/** One-line status text for Settings → Geral. */
export function statusLabel(state: UpdateState | null | undefined, locale: string): string {
  const t = platformText(locale);
  if (!state) return "";
  switch (state.status) {
    case "idle": return t.statusIdle;
    case "checking": return t.statusChecking;
    case "available": return t.statusAvailable;
    case "downloading": return t.statusDownloading;
    case "staged": return t.statusStaged;
    case "error": return state.error ? `${t.statusError} ${state.error}` : t.statusError;
    case "unsupported": return t.statusUnsupported;
  }
}
