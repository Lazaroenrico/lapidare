"use client";

import React, { useEffect, useMemo, useState } from "react";
import { fetchJson } from "@/lib/api";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Contrast,
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Maximize2,
  Search,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import { useLocale } from "@/components/locale-provider";
import { LessonProse } from "@/components/lesson-prose";
import { DemoIframe } from "@/components/demo-iframe";
import {
  dispatchLabel,
  formatPages,
  jobLabels,
  jobTitle,
  learnerSteerLabel,
  pdfFileName,
  svgDataUri,
  visualFileName,
  visualInvertKey,
  type JobResult,
  type JobSteer,
} from "@/lib/job-steer";
import type { SessionMessage } from "@/lib/types";

const chip = "px-1.5 py-0.5 rounded border font-ui text-[10.5px] uppercase tracking-wider";
const iconButton =
  "p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors";

// --- Shared pieces --------------------------------------------------------------------

/** "Despachado → concluído · 42 s": stands in for the (invisible) dispatching tool call. */
export function DispatchLabel({ job }: { job: JobSteer }) {
  const { locale } = useLocale();
  return (
    <span
      className="font-ui text-[11px] text-muted-foreground tracking-wide"
      title={job.startedAt && job.finishedAt ? `${job.startedAt} → ${job.finishedAt}` : undefined}
    >
      {dispatchLabel(job, locale)}
    </span>
  );
}

function KindIcon({ kind }: { kind: JobSteer["kind"] }) {
  const cls = "w-3.5 h-3.5 shrink-0";
  if (kind === "research") return <Search className={cls} />;
  if (kind === "pdf") return <FileText className={cls} />;
  if (kind === "visual") return <ImageIcon className={cls} />;
  if (kind === "demo") return <Sparkles className={cls} />;
  return <Workflow className={cls} />;
}

/** Collapsible card frame shared by every job result. */
function JobFrame({
  job,
  subtitle,
  defaultOpen,
  actions,
  check,
  children,
}: {
  job: JobSteer;
  subtitle?: string;
  defaultOpen: boolean;
  actions?: React.ReactNode;
  /** Verification badge (Fase 17): ok → success tone, false → warning, null/absent → none. */
  check?: { ok: boolean | null; label: string; title?: string | null };
  children: React.ReactNode;
}) {
  const { locale } = useLocale();
  const l = jobLabels(locale);
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="my-3 rounded-lg border border-border bg-card flex flex-col">
      <header className="flex items-center gap-2 px-3 py-2 select-none">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? l.collapse : l.expand}
          className="flex flex-1 min-w-0 items-center gap-2 text-left text-muted-foreground hover:text-foreground transition-colors"
        >
          {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
          <span className={`${chip} border-success/40 text-success flex items-center gap-1 shrink-0`}>
            <KindIcon kind={job.kind} />
            {jobTitle(job, locale)}
          </span>
          {subtitle && <span className="font-ui text-[12.5px] text-foreground truncate">{subtitle}</span>}
        </button>
        {check && check.ok !== null && (
          <span
            title={check.title || undefined}
            className={`${chip} shrink-0 ${check.ok ? "border-success/40 text-success" : "border-warning/40 text-warning"}`}
          >
            {check.label}
          </span>
        )}
        {actions}
        <DispatchLabel job={job} />
      </header>
      {open && <div className="border-t border-accent px-4 py-3 flex flex-col gap-3">{children}</div>}
    </section>
  );
}

// --- Research / PDF ---------------------------------------------------------------------

export function ResearchCard({ job, result }: { job: JobSteer; result: Extract<JobResult, { kind: "research" }> }) {
  const { locale } = useLocale();
  const l = jobLabels(locale);
  return (
    <JobFrame job={job} defaultOpen={false} subtitle={result.sources.length ? `${result.sources.length} · ${l.sources.toLowerCase()}` : undefined}>
      {result.brief && <LessonProse content={result.brief} className="text-[15px]" />}
      {result.sources.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{l.sources}</span>
          <ol className="flex flex-col gap-1 list-decimal pl-5 font-prose text-[14px] text-foreground">
            {result.sources.map((s, i) => (
              <li key={`${s.url}-${i}`}>
                {s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="underline underline-offset-2 decoration-muted-foreground hover:decoration-foreground inline-flex items-center gap-1 break-all"
                  >
                    {s.title || s.url}
                    <ExternalLink className="w-3 h-3 shrink-0 text-muted-foreground" />
                  </a>
                ) : (
                  s.title
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </JobFrame>
  );
}

export function PdfCard({ job, result }: { job: JobSteer; result: Extract<JobResult, { kind: "pdf" }> }) {
  const { locale } = useLocale();
  const l = jobLabels(locale);
  const name = result.path ? pdfFileName(result.path) : "";
  const pages = formatPages(result.pages);
  const subtitle = [name, pages && l.pages(pages)].filter(Boolean).join(" · ");
  return (
    <JobFrame job={job} defaultOpen={false} subtitle={subtitle || undefined}>
      {result.question && (
        <div className="flex flex-col gap-1">
          <span className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{l.question}</span>
          <p className="font-prose text-[14px] italic text-foreground select-text">{result.question}</p>
        </div>
      )}
      <LessonProse content={result.brief} className="text-[15px]" />
      {result.path && <code className="font-ui text-[11px] text-muted-foreground break-all">{result.path}</code>}
    </JobFrame>
  );
}

// --- Visual -------------------------------------------------------------------------------

function readInvert(jobId: string): boolean {
  try {
    return window.localStorage.getItem(visualInvertKey(jobId)) === "1";
  } catch {
    return false;
  }
}

function writeInvert(jobId: string, on: boolean) {
  try {
    if (on) window.localStorage.setItem(visualInvertKey(jobId), "1");
    else window.localStorage.removeItem(visualInvertKey(jobId));
  } catch {
    // Storage unavailable (private window, blocked site data): the toggle stays per-view.
  }
}

type VisualResult = Extract<JobResult, { kind: "visual" }>;

/** Visuals live in the vault: the SVG text is fetched by slug (re-validated server-side). */
export function VisualCard({ job, result }: { job: JobSteer; result: VisualResult }) {
  const [svg, setSvg] = useState(result.svg);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (result.svg.trim() || !result.slug) return;
    let cancelled = false;
    fetchJson<{ svg?: string }>(`/api/visuals/${encodeURIComponent(result.slug)}`)
      .then((body) => {
        if (!cancelled) {
          if (body?.svg) setSvg(body.svg);
          else setFailed(true);
        }
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [result.svg, result.slug]);
  if (failed) return <FailedJobChip job={{ ...job, status: "failed", error: job.error ?? "" }} />;
  if (!svg.trim()) return null;
  return <VisualFigure job={job} result={{ ...result, svg }} />;
}

function VisualFigure({ job, result }: { job: JobSteer; result: VisualResult }) {
  const { locale } = useLocale();
  const l = jobLabels(locale);
  // The SVG is only ever an <img> source: scripts and links inside it never run.
  const src = useMemo(() => svgDataUri(result.svg), [result.svg]);
  const [inverted, setInverted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (job.jobId) setInverted(readInvert(job.jobId));
  }, [job.jobId]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fullscreen]);

  const toggleInvert = () => {
    const next = !inverted;
    setInverted(next);
    if (job.jobId) writeInvert(job.jobId, next);
  };

  const filter = inverted ? "invert hue-rotate-180" : "";
  const fileName = visualFileName(result.path, job.jobId);
  const actions = (
    <div className="flex items-center gap-0.5 shrink-0">
      <button
        type="button"
        onClick={toggleInvert}
        aria-pressed={inverted}
        title={l.invert}
        aria-label={l.invert}
        className={`${iconButton} ${inverted ? "text-foreground bg-accent" : ""}`}
      >
        <Contrast className="w-3.5 h-3.5" />
      </button>
      <a href={src} download={fileName} title={l.download} aria-label={l.download} className={iconButton}>
        <Download className="w-3.5 h-3.5" />
      </a>
      <button type="button" onClick={() => setFullscreen(true)} title={l.fullscreen} aria-label={l.fullscreen} className={iconButton}>
        <Maximize2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  return (
    <>
      <JobFrame
        job={job}
        defaultOpen
        subtitle={result.path ? pdfFileName(result.path) : undefined}
        actions={actions}
        check={{ ok: result.checked, label: result.checked ? l.visualChecked : l.visualUnchecked, title: result.checkNotes }}
      >
        <div className="flex justify-center rounded border border-accent bg-background p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- data: URI, not an optimizable asset */}
          <img src={src} alt={result.notes || l.visualAlt} className={`max-w-full max-h-[480px] h-auto ${filter}`} />
        </div>
        {result.notes && <p className="font-prose text-[14px] text-muted-foreground select-text">{result.notes}</p>}
      </JobFrame>
      {fullscreen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={jobTitle(job, locale)}
          className="fixed inset-0 z-50 flex flex-col bg-background/95"
          onClick={() => setFullscreen(false)}
        >
          <div className="flex items-center justify-end gap-1 p-3" onClick={(e) => e.stopPropagation()}>
            {actions}
            <button type="button" onClick={() => setFullscreen(false)} title={l.closeFullscreen} aria-label={l.closeFullscreen} className={iconButton}>
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 flex items-center justify-center p-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={result.notes || l.visualAlt}
              onClick={(e) => e.stopPropagation()}
              className={`max-w-full max-h-full object-contain ${filter}`}
            />
          </div>
        </div>
      )}
    </>
  );
}

// --- Demo -----------------------------------------------------------------------------------

export function DemoCard({ job, result }: { job: JobSteer; result: Extract<JobResult, { kind: "demo" }> }) {
  const { locale } = useLocale();
  const l = jobLabels(locale);
  return (
    <JobFrame
      job={job}
      defaultOpen
      subtitle={result.title || result.slug || undefined}
      check={{ ok: result.verified, label: result.verified ? l.demoVerified : l.demoUnverified }}
    >
      <DemoIframe
        slug={result.slug ?? undefined}
        apiUrl={result.slug ? undefined : result.url ?? undefined}
        title={result.title || undefined}
        height={480}
      />
    </JobFrame>
  );
}

// --- Failure / unknown ------------------------------------------------------------------------

/** Discreet chip for a job that failed: the title, the reason and the dispatch label. */
export function FailedJobChip({ job }: { job: JobSteer }) {
  const { locale } = useLocale();
  const l = jobLabels(locale);
  return (
    <div className="my-2 flex flex-wrap items-center gap-2" role="status">
      <span className={`${chip} border-danger/50 text-danger flex items-center gap-1`}>
        <AlertCircle className="w-3 h-3" />
        {jobTitle(job, locale)}
      </span>
      <span className="font-ui text-[11px] text-muted-foreground break-words min-w-0">{job.error || l.unknownError}</span>
      <DispatchLabel job={job} />
    </div>
  );
}

function GenericJobCard({ job, summary }: { job: JobSteer; summary: string }) {
  return (
    <JobFrame job={job} defaultOpen={false} subtitle={job.rawKind || undefined}>
      <code className="font-ui text-[11px] text-muted-foreground whitespace-pre-wrap break-words">{summary || "—"}</code>
    </JobFrame>
  );
}

/** Renders a job steer by its kind; a failure becomes a chip, anything unrecognized a generic card. */
export function JobCard({ job, message }: { job: JobSteer; message?: SessionMessage }) {
  const body = (() => {
    if (job.status === "failed") return <FailedJobChip job={job} />;
    const result = job.result;
    switch (result?.kind) {
      case "research":
        return <ResearchCard job={job} result={result} />;
      case "pdf":
        return <PdfCard job={job} result={result} />;
      case "visual":
        return <VisualCard job={job} result={result} />;
      case "demo":
        return <DemoCard job={job} result={result} />;
      default:
        return <GenericJobCard job={job} summary={result?.kind === "unknown" ? result.summary : ""} />;
    }
  })();
  return (
    <div id={message ? `message-${message.id}` : undefined} className="scroll-mt-24">
      {body}
    </div>
  );
}

// --- Learner steer ----------------------------------------------------------------------------

/** "enviada durante o turno" / "na fila" on a learner message sent while a turn ran. */
export function LearnerSteerBadge({ message }: { message: Pick<SessionMessage, "steer_kind" | "delivered"> }) {
  const { locale } = useLocale();
  const label = learnerSteerLabel(message, locale);
  if (!label) return null;
  const queued = message.delivered === false;
  return (
    <span className={`${chip} ml-2 normal-case ${queued ? "border-warning/50 text-warning" : "border-border text-muted-foreground"}`}>
      {label}
    </span>
  );
}
