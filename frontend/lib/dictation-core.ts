/**
 * Núcleo puro do ditado (Deepgram streaming). Sem rede, sem DOM, sem React:
 * URL do WebSocket, acúmulo de transcrição, máquina de estados e mapeamento de erros.
 */
import { dictationText } from "./dictation-i18n";

export const DICTATION_LANGUAGES = ["multi", "pt-BR", "pt", "en", "en-US", "es", "fr", "de", "it", "ja"] as const;
export type DictationLanguage = (typeof DICTATION_LANGUAGES)[number];

export const DICTATION_SAMPLE_RATE = 16000;
/** Teto de espera pelo fechamento do socket depois de CloseStream. */
export const FINISH_TIMEOUT_MS = 3000;

export function isDictationLanguage(value: unknown): value is DictationLanguage {
  return typeof value === "string" && (DICTATION_LANGUAGES as readonly string[]).includes(value);
}

export function listenUrl(language: string): string {
  const lang = isDictationLanguage(language) ? language : "multi";
  const params = new URLSearchParams({
    model: "nova-3",
    language: lang,
    encoding: "linear16",
    sample_rate: String(DICTATION_SAMPLE_RATE),
    channels: "1",
    smart_format: "true",
    endpointing: "300",
    interim_results: "false",
  });
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

/** Subprotocolos do WebSocket: o JWT temporário vai em Sec-WebSocket-Protocol. */
export const listenProtocols = (token: string): string[] => ["bearer", token];

export const CLOSE_STREAM_MESSAGE = JSON.stringify({ type: "CloseStream" });

/** Acumula `channel.alternatives[0].transcript` das mensagens Results finais. */
export function reduceTranscript(acc: string, message: unknown): string {
  if (typeof message !== "object" || message === null) return acc;
  const m = message as { type?: unknown; is_final?: unknown; channel?: { alternatives?: { transcript?: unknown }[] } };
  if (m.type !== "Results" || m.is_final !== true) return acc;
  const text = m.channel?.alternatives?.[0]?.transcript;
  if (typeof text !== "string") return acc;
  const clean = text.trim();
  if (!clean) return acc;
  return acc ? `${acc} ${clean}` : clean;
}

/** Decodifica um frame de texto do socket; null se não for JSON. */
export function parseMessage(data: unknown): unknown {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export type DictationState = "idle" | "requesting" | "listening" | "finishing" | "error";
export type DictationEvent = "start" | "ready" | "stop" | "closed" | "cancel" | "fail" | "reset";

/** idle → requesting → listening → finishing → idle; `fail` leva a error de qualquer estado. */
export function nextState(state: DictationState, event: DictationEvent): DictationState {
  if (event === "fail") return "error";
  if (event === "cancel" || event === "reset") return "idle";
  switch (state) {
    case "idle":
    case "error":
      return event === "start" ? "requesting" : state;
    case "requesting":
      return event === "ready" ? "listening" : event === "stop" ? "idle" : state;
    case "listening":
      return event === "stop" ? "finishing" : event === "closed" ? "idle" : state;
    case "finishing":
      return event === "closed" ? "idle" : state;
  }
}

/** Escutando ou prestes a: o mic está (ou vai estar) aberto. */
export const isActive = (state: DictationState) => state === "requesting" || state === "listening" || state === "finishing";

export function errorMessage(status: number, locale: string): string {
  const t = dictationText(locale);
  if (status === 401) return t.errInvalidKey;
  if (status === 403) return t.errRole;
  if (status === 409) return t.errNotConfigured;
  return t.errUnavailable;
}

/** RMS (0..1) do bloco de áudio para um nível 0..1 perceptual, quantizado em 5% para poupar renders. */
export function levelFromRms(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const level = Math.min(1, Math.sqrt(rms) * 1.6);
  return Math.round(level * 20) / 20;
}

export interface DictationSettings {
  configured: boolean;
  language: string;
}

export function decodeDictationSettings(raw: unknown): DictationSettings {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return { configured: o.configured === true, language: isDictationLanguage(o.language) ? o.language : "multi" };
}
