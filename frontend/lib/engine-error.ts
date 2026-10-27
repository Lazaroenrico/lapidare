/**
 * Classification of a failed run's error text (already redacted by the backend), so the chat
 * page can say what happened in plain words. Pure: no I/O.
 */

export type EngineErrorKind = "quota" | "other";

const QUOTA_PATTERN = /quota|limit|resets? in|rate/i;

export function classifyEngineError(message: string | null | undefined): EngineErrorKind {
  return message && QUOTA_PATTERN.test(message) ? "quota" : "other";
}

/** The card shows for a failed run that carries an error text. */
export function showsEngineErrorCard(session: {
  execution_status?: string | null;
  error?: string | null;
}): boolean {
  return session.execution_status === "failed" && Boolean(session.error?.trim());
}
