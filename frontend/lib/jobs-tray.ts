/**
 * Background-agents tray: which job records are "running" and which "failed" (pure).
 *
 * GET /api/jobs serves the raw append-only records, so one job may appear several times:
 * the last occurrence wins.
 */
import type { BackgroundJobStatus } from "./types";

export const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TrayJobs {
  running: BackgroundJobStatus[];
  failed: BackgroundJobStatus[];
}

const stamp = (job: BackgroundJobStatus): number => {
  const t = Date.parse(job.updated_at ?? job.created_at ?? "");
  return Number.isNaN(t) ? 0 : t;
};

export function partitionTrayJobs(jobs: readonly BackgroundJobStatus[], now: number, windowMs = FAILED_WINDOW_MS): TrayJobs {
  const latest = new Map<string, BackgroundJobStatus>();
  for (const job of jobs) {
    latest.delete(job.job_id); // re-insert so the map follows each job's last record
    latest.set(job.job_id, job);
  }
  const running: BackgroundJobStatus[] = [];
  const failed: BackgroundJobStatus[] = [];
  for (const job of latest.values()) {
    if (job.status === "queued" || job.status === "running") running.push(job);
    else if (job.status === "failed" || job.status === "interrupted") {
      const at = Date.parse(job.updated_at ?? job.created_at ?? "");
      // Missing or invalid dates still show: better a stale failure than a hidden one.
      if (Number.isNaN(at) || now - at <= windowMs) failed.push(job);
    }
  }
  failed.sort((a, b) => stamp(b) - stamp(a));
  return { running, failed };
}
