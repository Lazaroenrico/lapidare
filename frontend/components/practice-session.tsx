"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, Send, SkipForward } from "lucide-react";
import { useLocale } from "@/components/locale-provider";
import { LessonProse } from "@/components/lesson-prose";
import { QuestionDock } from "@/components/question-dock";
import { AnsweredQuestionCard } from "@/components/transcript-cards";
import { JobCard } from "@/components/job-cards";
import { appendDictation, useDictation } from "@/components/use-dictation";
import { MicButton } from "@/components/mic-button";
import { dictationText } from "@/lib/dictation-i18n";
import {
  dockKeyAction,
  dockSubmission,
  missClassLabel,
  outcomeLabel,
  outcomeTone,
  problemModeLabel,
  rungLabel,
  type DockState,
  type DockSubmission,
  type OutcomeTone,
  type PracticeTranscriptItem,
} from "@/lib/practice";
import type { PracticeProblem, SessionMessage } from "@/lib/types";

const chip = "px-1.5 py-0.5 rounded border font-ui text-[10.5px] uppercase tracking-wider";

const TONE: Record<OutcomeTone, string> = {
  success: "border-success/60 text-success",
  warning: "border-warning/60 text-warning",
  danger: "border-danger/60 text-danger",
  muted: "border-border text-muted-foreground",
};

/** Home URL that focuses a graph node (`/?focus=<id>`). */
export const graphFocusHref = (nodeId: string) => `/?focus=${encodeURIComponent(nodeId)}`;

// --- Cards -----------------------------------------------------------------------

export function ProblemCard({
  problem,
  index,
  active,
  nodeNames,
}: {
  problem: PracticeProblem;
  index: number;
  active: boolean;
  nodeNames: ReadonlyMap<string, string>;
}) {
  const { locale, t } = useLocale();
  const router = useRouter();
  return (
    <section
      id={`problem-${problem.id}`}
      className={`rounded-lg border bg-card p-4 flex flex-col gap-3 scroll-mt-24 ${active ? "border-muted-foreground" : "border-border"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-title font-bold text-[15px] text-foreground">{t.problemHeading(index)}</span>
        <span className={`${chip} border-border bg-accent text-foreground font-semibold`}>
          {problemModeLabel(problem.mode, locale)}
        </span>
        {active && <span className={`${chip} border-warning/60 text-warning`}>{t.problemOpen}</span>}
      </div>
      <LessonProse content={problem.statement} />
      {problem.target.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {problem.target.map((id) => {
            const name = nodeNames.get(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => router.push(graphFocusHref(id))}
                title={t.problemTargetTitle(name ?? id)}
                className={`px-2 py-0.5 rounded border border-border bg-background hover:bg-accent hover:border-muted-foreground font-ui text-[11px] cursor-pointer transition-colors ${name ? "text-foreground" : "text-muted-foreground"}`}
              >
                {name ?? id}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function AttemptCard({ text, id }: { text: string; id?: string }) {
  const { t } = useLocale();
  return (
    <div id={id} className="flex flex-col gap-1 border-l-2 border-muted-foreground pl-4 py-1 my-1 scroll-mt-24">
      <span className="font-ui text-[10.5px] uppercase tracking-wider text-muted-foreground">{t.attemptLabel}</span>
      <p className="font-prose italic text-[15.5px] leading-relaxed text-foreground whitespace-pre-wrap select-text">{text}</p>
    </div>
  );
}

export function ConcludeCard({ problem }: { problem: PracticeProblem }) {
  const { locale, t } = useLocale();
  if (!problem.outcome) return null;
  const tone = TONE[outcomeTone(problem.outcome)];
  return (
    <section className={`rounded-lg border bg-card p-4 flex flex-col gap-3 ${tone.split(" ")[0]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{t.concludeHeading}</span>
        <span className={`${chip} ${tone} font-semibold`}>{outcomeLabel(problem.outcome, locale)}</span>
        {problem.retest && (
          <span className={`${chip} border-warning/60 text-warning`} title={t.retestTitle}>
            {t.retestBadge}
          </span>
        )}
      </div>
      {problem.verdict && <p className="font-prose text-[15px] leading-relaxed text-foreground select-text">{problem.verdict}</p>}
      {problem.outcome !== "dismissed" && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-ui text-[11px]">
          <dt className="text-muted-foreground">{t.concludeRung}</dt>
          <dd className="text-foreground">{problem.rung ? rungLabel(problem.rung, locale) : t.concludeNoHints}</dd>
          {problem.miss_class && (
            <>
              <dt className="text-muted-foreground">{t.concludeMissClass}</dt>
              <dd className="text-foreground">{missClassLabel(problem.miss_class, locale)}</dd>
            </>
          )}
        </dl>
      )}
      {problem.model_solution && (
        <details className="group border-t border-accent pt-2">
          <summary className="cursor-pointer list-none flex items-center gap-1 font-ui text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
            <ChevronRight className="w-3 h-3 group-open:rotate-90 transition-transform" />
            {t.modelSolution}
          </summary>
          <div className="pt-2">
            <LessonProse content={problem.model_solution} className="text-[15px]" />
          </div>
        </details>
      )}
    </section>
  );
}

// --- Transcript ------------------------------------------------------------------

export function PracticeTranscript({
  items,
  sessionId,
  activeProblemId,
  nodeNames,
  onAnswerSubmitted,
  renderMessage,
}: {
  items: PracticeTranscriptItem[];
  sessionId: string;
  activeProblemId: string | null;
  nodeNames: ReadonlyMap<string, string>;
  onAnswerSubmitted: () => void;
  /** Same rendering as the TEACH transcript (user bubble / lesson prose). */
  renderMessage: (message: SessionMessage, key: string) => React.ReactNode;
}) {
  const { t } = useLocale();
  if (items.length === 0) {
    return <div className="py-16 text-center text-muted-foreground font-prose text-base">{t.practiceStarting}</div>;
  }
  let problemIndex = 0;
  return (
    <>
      {items.map((item) => {
        switch (item.type) {
          case "problem":
            problemIndex += 1;
            return (
              <ProblemCard
                key={item.key}
                problem={item.problem}
                index={problemIndex}
                active={item.problem.id === activeProblemId}
                nodeNames={nodeNames}
              />
            );
          case "attempt":
            return <AttemptCard key={item.key} text={item.text} id={item.messageId ? `message-${item.messageId}` : undefined} />;
          case "conclusion":
            return <ConcludeCard key={item.key} problem={item.problem} />;
          case "answer":
            return <AnsweredQuestionCard key={item.key} answer={item.answer} />;
          case "pending":
            return (
              <div key={item.key} data-pending-question>
                <QuestionDock quiz={item.quiz} sessionId={sessionId} onAnswerSubmitted={onAnswerSubmitted} />
              </div>
            );
          case "job":
            return <JobCard key={item.key} job={item.job} message={item.message} />;
          case "message":
            return renderMessage(item.message, item.key);
        }
      })}
    </>
  );
}

// --- Dock --------------------------------------------------------------------------

export function PracticeDock({
  state,
  pendingQuiz,
  onSubmit,
  onRequestDismiss,
  steerable = false,
}: {
  state: DockState;
  pendingQuiz: boolean;
  /** Fase 12: the agent is running; non-empty text goes to /steer as `{kind: "text"}`. */
  steerable?: boolean;
  /** Resolves true when sent (the draft is cleared), false to keep the draft. */
  onSubmit: (submission: DockSubmission) => Promise<boolean>;
  onRequestDismiss: () => void;
}) {
  const { locale, t } = useLocale();
  const [draft, setDraft] = useState("");
  const dockRef = useRef<HTMLElement | null>(null);
  const dictation = useDictation(locale, { field: dockRef, enabled: !pendingQuiz });
  const dt = dictationText(locale);
  dictation.setSink((text) => setDraft((prev) => appendDictation(prev, text)));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attempt = state.mode === "attempt";

  // A new problem (or the end of one) moves the focus back to the dock.
  useEffect(() => {
    if (!state.busy) textareaRef.current?.focus();
  }, [state.mode, state.busy]);

  const steerText = draft.trim();
  const submit = async () => {
    const submission: DockSubmission | null = steerable
      ? steerText ? { kind: "text", content: steerText } : null
      : dockSubmission(state, draft);
    if (!submission) return;
    if (await onSubmit(submission)) setDraft("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const action = dockKeyAction(state, e.key, { shift: e.shiftKey, composing: e.nativeEvent.isComposing });
    if (action === "submit") {
      e.preventDefault();
      void submit();
    } else if (action === "confirm-dismiss") {
      e.preventDefault();
      onRequestDismiss();
    }
  };

  const placeholder = pendingQuiz
    ? t.dockQuizPending
    : steerable
      ? t.uxSteerPlaceholder
    : state.busy && !attempt
      ? t.dockBusyPlaceholder
      : attempt
        ? t.dockAttemptPlaceholder
        : t.dockFreePlaceholder;
  const canSend = steerable ? steerText.length > 0 : !state.busy && (attempt ? draft.trim().length > 0 : true);

  return (
    <footer ref={dockRef} className="px-4 py-3 bg-background border-t border-border shrink-0 z-20">
      <div className="max-w-4xl mx-auto flex flex-col gap-2">
        {attempt && (
          <label htmlFor="practice-dock-input" className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">
            {t.dockAttemptLabel}
          </label>
        )}
        <div className="flex items-end gap-2">
          <MicButton
            variant="icon"
            configured={dictation.supported}
            state={dictation.state}
            level={dictation.level}
            onToggle={dictation.toggle}
            label={dt.start}
            stopLabel={dt.stop}
          />
          <textarea
            id="practice-dock-input"
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={attempt ? t.dockAttemptLabel : t.dockFreePlaceholder}
            rows={attempt ? 3 : 1}
            disabled={pendingQuiz}
            className={`flex-1 resize-none bg-card border border-border rounded-lg px-4 py-2.5 font-prose text-[15px] leading-relaxed text-foreground placeholder-muted-foreground focus:border-foreground transition-colors disabled:opacity-60 ${attempt ? "min-h-[84px]" : ""}`}
          />
          {state.awaitingAnswer && !steerable ? (
            <button
              type="button"
              onClick={() => document.querySelector("[data-pending-question]")?.scrollIntoView({ behavior: "smooth", block: "center" })}
              className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-border bg-accent hover:bg-border text-foreground font-ui text-[11.5px] font-semibold cursor-pointer active:scale-95 transition-all shrink-0"
            >
              <ChevronRight className="w-4 h-4 rotate-90" />
              <span>{t.dockGoToQuestion}</span>
            </button>
          ) : state.canNext && !draft.trim() ? (
            <button
              type="button"
              onClick={() => void submit()}
              className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-border bg-accent hover:bg-border text-foreground font-ui text-[11.5px] font-semibold cursor-pointer active:scale-95 transition-all shrink-0"
            >
              <SkipForward className="w-4 h-4" />
              <span>{t.dockNext}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend}
              className={`flex items-center gap-1.5 px-3 py-2.5 rounded-lg border font-ui text-[11.5px] font-semibold transition-all shrink-0 ${
                canSend
                  ? "bg-accent hover:bg-border border-border text-foreground cursor-pointer active:scale-95"
                  : "bg-card border-accent text-muted-foreground cursor-not-allowed"
              }`}
              aria-label={t.dockSend}
            >
              {state.working && !steerable ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              <span>{t.dockSend}</span>
            </button>
          )}
        </div>
        <span className="font-ui text-[10.5px] text-muted-foreground">{attempt ? t.dockAttemptHint : t.dockFreeHint}</span>
      </div>
    </footer>
  );
}

// --- Dismiss dialog ------------------------------------------------------------------

export function DismissProblemDialog({
  open,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLocale();
  if (!open) return null;
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4"
      role="presentation"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div role="alertdialog" aria-modal="true" aria-labelledby="dismiss-problem-title" className="w-full max-w-sm bg-card border border-border rounded-xl p-5 shadow-2xl font-ui">
        <h3 id="dismiss-problem-title" className="font-title text-base font-bold text-foreground mb-2">
          {t.dismissProblemTitle}
        </h3>
        <p className="font-prose text-[13px] text-muted-foreground mb-4">{t.dismissProblemBody}</p>
        {error && <p role="alert" className="text-[11px] text-danger mb-3">{error}</p>}
        <div className="flex justify-end gap-2 text-xs">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="px-3 py-1.5 rounded border border-border bg-background hover:bg-accent text-foreground cursor-pointer"
          >
            {t.cancel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-danger/60 bg-accent hover:bg-border text-danger font-semibold cursor-pointer disabled:opacity-60"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {busy ? t.dismissProblemBusy : t.dismissProblemConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
