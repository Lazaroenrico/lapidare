"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Compass, HelpCircle, XCircle } from "lucide-react";
import { useLocale } from "@/components/locale-provider";
import { LessonProse } from "@/components/lesson-prose";
import { optionLetter } from "@/lib/session-wire";
import { recallQuiz } from "@/lib/quiz-memory";
import type { CalibrationResult, ProbeAssessment, QuizMode, QuizOption, TeachPhase } from "@/lib/types";

type Translations = ReturnType<typeof useLocale>["t"];

export function modeLabel(t: Translations, mode: QuizMode | null): string {
  if (mode === "PROBE") return t.qModeProbe;
  if (mode === "PREDICTION") return t.qModePrediction;
  if (mode === "CHECK") return t.qModeCheck;
  return t.qModeAsk;
}

const chip = "px-1.5 py-0.5 rounded border font-ui text-[10.5px] uppercase tracking-wider";

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="font-prose text-[14px] leading-relaxed text-foreground whitespace-pre-wrap select-text">{children}</div>
    </div>
  );
}

function Verdict({ answer }: { answer: CalibrationResult }) {
  const { t } = useLocale();
  if (answer.dismissed) {
    return <span className={`${chip} border-border text-muted-foreground`}>{t.uxAnswerDismissed}</span>;
  }
  if (answer.kind === "ask") return null;
  if (answer.is_dont_know) {
    return (
      <span className={`${chip} border-border text-muted-foreground flex items-center gap-1`}>
        <HelpCircle className="w-3 h-3" />
        {t.aDontKnow}
      </span>
    );
  }
  if (answer.kind === "explain") {
    if (!answer.grade) {
      return (
        <span className={`${chip} border-border text-muted-foreground flex items-center gap-1`}>
          <CircleDashed className="w-3 h-3" />
          {t.aAwaitingGrade}
        </span>
      );
    }
    const tone =
      answer.grade === "correct"
        ? "border-success/60 text-success"
        : answer.grade === "partial"
          ? "border-warning/60 text-warning"
          : "border-danger/60 text-danger";
    return <span className={`${chip} ${tone}`}>{t.aGrade(answer.grade)}</span>;
  }
  if (answer.correct === null) return null;
  return answer.correct ? (
    <span className={`${chip} border-success/60 text-success flex items-center gap-1`}>
      <CheckCircle2 className="w-3 h-3" />
      {t.aCorrect}
    </span>
  ) : (
    <span className={`${chip} border-danger/60 text-danger flex items-center gap-1`}>
      <XCircle className="w-3 h-3" />
      {t.aIncorrect}
    </span>
  );
}

/** Card for an answered question in the transcript (and the dock after submitting). */
export function AnsweredQuestionCard({ answer, className = "" }: { answer: CalibrationResult; className?: string }) {
  const { t } = useLocale();
  const [remembered, setRemembered] = useState<{ question?: string; choices?: QuizOption[] }>({});
  useEffect(() => {
    if (answer.choices && answer.question) return;
    const found = recallQuiz(answer.quiz_id);
    if (found) setRemembered({ question: found.question, choices: found.choices });
  }, [answer.quiz_id, answer.choices, answer.question]);

  const question = answer.question ?? remembered.question;
  const choices = answer.choices ?? remembered.choices;
  const labelOf = (i: number) => choices?.[i]?.label || t.aOption(optionLetter(i));
  const chosen = answer.chosen_indices.map(labelOf);
  const showCorrect =
    answer.kind === "quiz" && answer.correct === false && answer.correct_indices.length > 0;
  const illusion = answer.calibration_band === "illusion_of_competence";

  return (
    <div
      className={`rounded-lg border bg-card p-4 flex flex-col gap-3 ${illusion ? "border-warning/70" : "border-border"} ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${chip} border-border bg-accent text-foreground font-semibold`}>
          {modeLabel(t, answer.kind === "ask" ? null : answer.mode)}
        </span>
        {answer.kind === "explain" && (
          <span className={`${chip} border-border text-muted-foreground`}>{t.qKindExplain}</span>
        )}
        <Verdict answer={answer} />
        {answer.confidence !== null && !answer.is_dont_know && answer.kind === "quiz" && (
          <span className={`${chip} border-border text-muted-foreground`}>{t.aConfidence(answer.confidence)}</span>
        )}
        {answer.calibration_band && (
          <span className={`${chip} ${illusion ? "border-warning/60 text-warning" : "border-border text-muted-foreground"}`}>
            {t.aBand(answer.calibration_band)}
          </span>
        )}
      </div>

      {question && <LessonProse content={question} className="text-[15px]" />}

      {chosen.length > 0 && (
        <Labeled label={t.aChoice}>
          <ul className="flex flex-col gap-0.5">
            {chosen.map((label, i) => (
              <li key={i}>
                <span className={answer.correct === false ? "text-danger" : ""}>{label}</span>
              </li>
            ))}
          </ul>
        </Labeled>
      )}
      {answer.other_text && <Labeled label={t.aOther}>{answer.other_text}</Labeled>}
      {showCorrect && (
        <Labeled label={t.aCorrectAnswer}>
          <span className="text-success">{answer.correct_indices.map(labelOf).join(" · ")}</span>
        </Labeled>
      )}
      {answer.text && <Labeled label={t.aAnswer}>{answer.text}</Labeled>}
      {answer.grade_feedback && <Labeled label={t.aGrade(answer.grade ?? "")}>{answer.grade_feedback}</Labeled>}
      {answer.learner_thinking && <Labeled label={t.aThinking}>{answer.learner_thinking}</Labeled>}
      {answer.reading_thinking && <Labeled label={t.aReadingThinking}>{answer.reading_thinking}</Labeled>}

      {answer.explanation && (
        <details className="group border-t border-accent pt-2">
          <summary className="cursor-pointer list-none flex items-center gap-1 font-ui text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
            <ChevronRight className="w-3 h-3 group-open:rotate-90 transition-transform" />
            {t.aExplanation}
          </summary>
          <LessonProse content={answer.explanation} className="mt-2 text-[14px]" />
        </details>
      )}
    </div>
  );
}

/** Result of `probe_done`: per-strand assessment, collapsible. */
export function ProbeDoneCard({ assessment }: { assessment: ProbeAssessment }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left cursor-pointer hover:bg-accent rounded-lg transition-colors"
      >
        <span className="flex items-center gap-2">
          <Compass className="w-4 h-4 text-muted-foreground" />
          <span className="font-ui text-[12.5px] font-semibold text-foreground">{t.probeDoneTitle}</span>
          <span className="font-ui text-[11px] text-muted-foreground">{t.probeDoneStrands(assessment.strands.length)}</span>
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
      </button>
      {assessment.summary && (
        <p className="px-4 pb-3 font-prose text-[14px] leading-relaxed text-foreground select-text">{assessment.summary}</p>
      )}
      {open && (
        <ul className="px-4 pb-4 flex flex-col gap-3 border-t border-accent pt-3">
          {assessment.strands.map((s, i) => (
            <li key={`${s.strand}-${i}`} className="flex flex-col gap-0.5">
              <span className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{s.strand}</span>
              <span className="font-prose text-[14px] leading-relaxed text-foreground select-text">{s.assessment}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PhaseDivider({ phase }: { phase: TeachPhase }) {
  const { t } = useLocale();
  return (
    <div className="flex items-center gap-3 my-2 select-none" role="separator" aria-label={t.phaseName(phase)}>
      <span className="flex-1 h-px bg-border" />
      <span className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{t.phaseName(phase)}</span>
      <span className="flex-1 h-px bg-border" />
    </div>
  );
}

const CYCLE: TeachPhase[] = ["probing", "planning", "teaching"];

/** Header chip: Diagnóstico → Planejamento → Ensino with the current phase lit. */
export function PhaseChip({ phase }: { phase: TeachPhase }) {
  const { t } = useLocale();
  if (phase === "completed") {
    return (
      <span className={`${chip} border-success/60 text-success`} aria-label={t.phaseChipAria}>
        {t.phaseName(phase)}
      </span>
    );
  }
  const current = CYCLE.indexOf(phase);
  return (
    <span className="flex items-center gap-1 font-ui text-[10.5px] uppercase tracking-wider" aria-label={t.phaseChipAria}>
      {CYCLE.map((p, i) => (
        <React.Fragment key={p}>
          {i > 0 && <span className="text-border">→</span>}
          <span
            className={`px-1.5 py-0.5 rounded border ${
              i === current
                ? "border-foreground bg-accent text-foreground font-semibold"
                : i < current
                  ? "border-border text-muted-foreground"
                  : "border-accent text-muted-foreground/60"
            }`}
            aria-current={i === current ? "step" : undefined}
          >
            {t.phaseName(p)}
          </span>
        </React.Fragment>
      ))}
    </span>
  );
}
