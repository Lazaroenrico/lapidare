"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, HelpCircle, Mic, MicOff, PenLine, Send } from "lucide-react";
import { useLocale } from "@/components/locale-provider";
import { InlineMath, LessonProse } from "@/components/lesson-prose";
import { AnsweredQuestionCard, modeLabel } from "@/components/transcript-cards";
import { appendDictation, useDictation } from "@/components/use-dictation";
import { submitQuizAnswer } from "@/lib/api";
import { rememberQuiz } from "@/lib/quiz-memory";
import { optionLetter } from "@/lib/session-wire";
import {
  DEFAULT_CONFIDENCE,
  allowsDontKnow,
  buildSubmission,
  canSubmit,
  moveRow,
  shuffleOrder,
  shufflesOptions,
  clampConfidence,
  stepConfidence,
  usesConfidence,
} from "@/lib/question-core";
import type { CalibrationResult, QuizPayload } from "@/lib/types";

interface QuestionDockProps {
  quiz: QuizPayload;
  sessionId: string;
  onAnswerSubmitted?: (result: CalibrationResult) => void;
  className?: string;
}

/** A selectable row: an option (by display position), "Não sei" or "Outro…". */
type Row = { type: "option"; display: number } | { type: "dont_know" } | { type: "other" };

/** Field that receives dictation. */
type Field = "reading" | "text" | "thinking" | "other";

const label = "font-ui text-[11px] uppercase tracking-wider text-muted-foreground";
const textarea =
  "w-full bg-background border border-border rounded p-2.5 text-[14px] font-prose text-foreground placeholder-muted-foreground focus:border-foreground transition-colors resize-none leading-relaxed";

export function QuestionDock({ quiz, sessionId, onAnswerSubmitted, className = "" }: QuestionDockProps) {
  const { locale, t } = useLocale();
  const kind = quiz.kind;
  const isCheck = quiz.mode === "CHECK" && kind !== "ask";

  const order = useMemo(
    () => (shufflesOptions(kind) ? shuffleOrder(quiz.choices.length, quiz.quiz_id) : quiz.choices.map((_, i) => i)),
    [kind, quiz.choices, quiz.quiz_id],
  );

  const [revealed, setRevealed] = useState(!isCheck);
  const [selected, setSelected] = useState<number[]>([]);
  const [dontKnow, setDontKnow] = useState(false);
  const [confidence, setConfidence] = useState(DEFAULT_CONFIDENCE);
  const [thinking, setThinking] = useState("");
  const [readingThinking, setReadingThinking] = useState("");
  const [text, setText] = useState("");
  const [otherSelected, setOtherSelected] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [focusRow, setFocusRow] = useState(-1);
  const [activeField, setActiveField] = useState<Field>(isCheck ? "reading" : kind === "explain" ? "text" : "thinking");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const thinkingRef = useRef<HTMLTextAreaElement | null>(null);
  const readingRef = useRef<HTMLTextAreaElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const otherRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => rememberQuiz(quiz), [quiz]);

  // Dictation follows the active field.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dictation = useDictation(locale, { field: rootRef, enabled: result === null });
  const setters: Record<Field, React.Dispatch<React.SetStateAction<string>>> = {
    reading: setReadingThinking,
    text: setText,
    thinking: setThinking,
    other: setOtherText,
  };
  dictation.setSink((spoken) => setters[activeField]((prev) => appendDictation(prev, spoken)));
  const fieldName: Record<Field, string> = {
    reading: t.qReadingThinking,
    text: t.qAnswerLabel,
    thinking: t.qThinkingLabel,
    other: t.qOther,
  };

  const rows: Row[] = useMemo(() => {
    const out: Row[] = kind === "explain" ? [] : order.map((_, display) => ({ type: "option" as const, display }));
    if (kind === "ask") out.push({ type: "other" });
    if (allowsDontKnow(kind)) out.push({ type: "dont_know" });
    return out;
  }, [kind, order]);

  const draft = { selected, dontKnow, confidence, thinking, readingThinking, text, otherSelected, otherText };
  const ready = canSubmit(kind, draft) && !submitting;

  const isPicked = (row: Row) =>
    row.type === "option" ? selected.includes(row.display) : row.type === "other" ? otherSelected : dontKnow;

  const pick = (row: Row) => {
    if (submitting || result) return;
    setError(null);
    if (row.type === "dont_know") {
      const next = !dontKnow;
      setDontKnow(next);
      if (next) {
        setSelected([]);
        setOtherSelected(false);
      }
      return;
    }
    setDontKnow(false);
    if (row.type === "other") {
      const next = quiz.multi_select ? !otherSelected : true;
      setOtherSelected(next);
      if (!quiz.multi_select) setSelected([]);
      if (next) {
        setActiveField("other");
        requestAnimationFrame(() => otherRef.current?.focus());
      }
      return;
    }
    if (quiz.multi_select) {
      setSelected((prev) =>
        prev.includes(row.display) ? prev.filter((d) => d !== row.display) : [...prev, row.display].sort((a, b) => a - b),
      );
    } else {
      setSelected([row.display]);
      setOtherSelected(false);
    }
  };

  const focusRowAt = (idx: number) => {
    const target = rowRefs.current[idx];
    if (target) {
      target.focus();
      setFocusRow(idx);
    }
  };

  const reveal = () => {
    setRevealed(true);
    setActiveField(kind === "explain" ? "text" : "thinking");
    requestAnimationFrame(() => (kind === "explain" ? textRef.current?.focus() : focusRowAt(0)));
  };

  const submit = async () => {
    if (!canSubmit(kind, draft) || submitting || result) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await submitQuizAnswer(sessionId, buildSubmission(quiz, sessionId, order, draft));
      const full: CalibrationResult = {
        ...res,
        question: res.question ?? quiz.question,
        choices: res.choices ?? quiz.choices,
        mode: res.mode ?? quiz.mode,
        kind: res.kind ?? kind,
      };
      setResult(full);
      onAnswerSubmitted?.(full);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t.answerSendFailed);
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (result) return;
    const target = e.target as HTMLElement;
    const rowIdx = rowRefs.current.findIndex((el) => el === target);
    const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;

    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (!revealed) {
        e.preventDefault();
        reveal();
        return;
      }
      if (ready) {
        e.preventDefault();
        void submit();
      } else if (rowIdx >= 0) {
        e.preventDefault();
        pick(rows[rowIdx]);
      }
      return;
    }
    if (!revealed) return;

    if (e.key === "Tab" && plain && rows.length > 0) {
      if (rowIdx >= 0) {
        e.preventDefault();
        thinkingRef.current?.focus();
      } else if (target === thinkingRef.current) {
        e.preventDefault();
        const firstPicked = rows.findIndex(isPicked);
        focusRowAt(focusRow >= 0 ? focusRow : Math.max(0, firstPicked));
      }
      return;
    }
    if (rowIdx < 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusRowAt(moveRow(rowIdx, e.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (e.key === " ") {
      e.preventDefault();
      pick(rows[rowIdx]);
    }
  };

  const micButton = dictation.supported ? (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault() /* keep focus in the active field */}
      onClick={dictation.toggle}
      className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-ui transition-colors cursor-pointer ${
        dictation.listening
          ? "bg-danger/10 text-danger border-danger animate-pulse"
          : "bg-background text-muted-foreground border-border hover:text-foreground"
      }`}
      title={t.qDictateInto(fieldName[activeField])}
      aria-label={t.qDictateInto(fieldName[activeField])}
      aria-pressed={dictation.listening}
    >
      {dictation.listening ? <MicOff className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
      <span>{dictation.listening ? t.listening : fieldName[activeField]}</span>
    </button>
  ) : null;

  const header = (
    <div className="px-4 py-2.5 bg-background border-b border-border flex items-center justify-between gap-2 font-ui text-[11px]">
      <div className="flex items-center gap-2 min-w-0">
        <span className="px-2 py-0.5 rounded bg-accent text-foreground border border-border font-semibold uppercase tracking-wider text-[10.5px]">
          {modeLabel(t, kind === "ask" ? null : quiz.mode)}
        </span>
        {kind === "explain" && <span className="text-muted-foreground uppercase tracking-wider">{t.qKindExplain}</span>}
        {quiz.topic && <span className="text-muted-foreground truncate hidden sm:inline">{t.dockTarget(quiz.topic)}</span>}
      </div>
      {micButton}
    </div>
  );

  if (result) {
    return <AnsweredQuestionCard answer={result} className={`my-4 ${className}`} />;
  }

  const readingField = (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`reading-${quiz.quiz_id}`} className={`${label} flex items-center gap-1.5`}>
        <PenLine className="w-3 h-3" />
        {t.qReadingThinking}
      </label>
      <textarea
        id={`reading-${quiz.quiz_id}`}
        ref={readingRef}
        rows={3}
        value={readingThinking}
        onChange={(e) => setReadingThinking(e.target.value)}
        onFocus={() => setActiveField("reading")}
        placeholder={t.qReadingThinkingPlaceholder}
        className={textarea}
      />
    </div>
  );

  // CHECK waits collapsed: the reading-thinking field is the only open input.
  if (!revealed) {
    return (
      <div ref={rootRef} className={`my-4 shrink-0 rounded-lg bg-card border border-border overflow-hidden ${className}`} onKeyDown={onKeyDown}>
        {header}
        <div className="p-4 flex flex-col gap-3">
          {readingField}
          <button
            type="button"
            onClick={reveal}
            className="group w-full flex items-center justify-between px-4 py-3 bg-background hover:bg-accent border border-border hover:border-muted-foreground rounded-lg cursor-pointer transition-colors text-left"
            aria-expanded={false}
          >
            <span className="flex flex-col">
              <span className="font-ui text-[12.5px] font-semibold text-foreground">{t.qCheckReveal}</span>
              <span className="font-prose text-[13px] text-muted-foreground">{t.qCheckRevealHint}</span>
            </span>
            <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground" />
          </button>
        </div>
      </div>
    );
  }

  const confidenceOn = usesConfidence(kind, dontKnow);
  const band = confidence < 50 ? t.confLow : confidence < 70 ? t.confMid : t.confHigh;
  const rovingIdx = focusRow >= 0 && focusRow < rows.length ? focusRow : 0;
  rowRefs.current.length = rows.length;

  return (
    <div ref={rootRef} className={`my-4 shrink-0 rounded-lg bg-card border border-border overflow-hidden ${className}`} onKeyDown={onKeyDown}>
      {header}
      <div className="p-5 flex flex-col gap-4">
        {isCheck && readingThinking.trim() && (
          <div className="border-l-2 border-border pl-3">
            <span className={label}>{t.qReadingThinking}</span>
            <p className="font-prose text-[13.5px] text-muted-foreground whitespace-pre-wrap">{readingThinking}</p>
          </div>
        )}

        <LessonProse content={quiz.question} className="text-[16px]" />
        {quiz.details && <LessonProse content={quiz.details} className="text-[14px] text-muted-foreground" />}

        {kind === "explain" && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`answer-${quiz.quiz_id}`} className={label}>
              {t.qAnswerLabel}
            </label>
            <textarea
              id={`answer-${quiz.quiz_id}`}
              ref={textRef}
              rows={4}
              value={text}
              disabled={dontKnow}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setActiveField("text")}
              placeholder={t.qAnswerPlaceholder}
              className={`${textarea} disabled:opacity-50`}
            />
          </div>
        )}

        {rows.length > 0 && (
          <div
            role={quiz.multi_select ? "group" : "radiogroup"}
            aria-label={t.qOptionsAria}
            className="flex flex-col gap-2"
          >
            {quiz.multi_select && kind !== "explain" && <span className={label}>{t.qKindMulti}</span>}
            {rows.map((row, idx) => {
              const picked = isPicked(row);
              const option = row.type === "option" ? quiz.choices[order[row.display]] : null;
              const marker =
                row.type === "option" ? optionLetter(row.display) : row.type === "other" ? "…" : "?";
              const rowText =
                row.type === "option" ? option?.label ?? "" : row.type === "other" ? t.qOther : t.qDontKnow;
              return (
                <div
                  key={row.type === "option" ? `o${row.display}` : row.type}
                  ref={(el) => {
                    rowRefs.current[idx] = el;
                  }}
                  role={quiz.multi_select || row.type === "dont_know" ? "checkbox" : "radio"}
                  aria-checked={picked}
                  tabIndex={idx === rovingIdx ? 0 : -1}
                  onFocus={() => setFocusRow(idx)}
                  onClick={() => pick(row)}
                  className={`flex items-start gap-3 p-3 rounded border cursor-pointer transition-colors focus:border-muted-foreground ${
                    picked
                      ? "bg-accent border-foreground text-foreground"
                      : "bg-background border-border text-foreground hover:bg-accent"
                  } ${row.type === "dont_know" ? "py-2" : ""}`}
                >
                  <span
                    className={`w-5 h-5 border flex items-center justify-center text-[11px] font-ui shrink-0 mt-0.5 ${
                      quiz.multi_select ? "rounded" : "rounded-full"
                    } ${picked ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground"}`}
                  >
                    {row.type === "dont_know" ? <HelpCircle className="w-3 h-3" /> : marker}
                  </span>
                  <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span
                      className={
                        row.type === "dont_know"
                          ? "font-ui text-[12.5px] text-muted-foreground"
                          : "font-prose text-[15px] leading-snug select-text"
                      }
                    >
                      {row.type === "dont_know" ? rowText : <InlineMath content={String(rowText ?? "")} />}
                    </span>
                    {option?.description && (
                      <span className="font-prose text-[13px] text-muted-foreground leading-snug">
                        <InlineMath content={option.description} />
                      </span>
                    )}
                    {row.type === "other" && otherSelected && (
                      <input
                        ref={otherRef}
                        type="text"
                        value={otherText}
                        onChange={(e) => setOtherText(e.target.value)}
                        onFocus={() => setActiveField("other")}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === " ") e.stopPropagation();
                        }}
                        placeholder={t.qOtherPlaceholder}
                        className="mt-1 w-full bg-card border border-border rounded px-2 py-1.5 text-[14px] font-prose text-foreground placeholder-muted-foreground focus:border-foreground"
                      />
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {kind === "quiz" && (
          <div className={`flex flex-col gap-1.5 ${confidenceOn ? "" : "opacity-40"}`}>
            <div className="flex items-center justify-between">
              <label htmlFor={`confidence-${quiz.quiz_id}`} className={label}>
                {t.qConfidence}
              </label>
              <span className="font-ui text-[11px] text-foreground">
                {confidenceOn ? band : t.qConfidenceOff}
              </span>
            </div>
            <input
              id={`confidence-${quiz.quiz_id}`}
              type="range"
              min={0}
              max={100}
              step={1}
              value={confidence}
              disabled={!confidenceOn}
              onChange={(e) => setConfidence(clampConfidence(Number(e.target.value)))}
              onKeyDown={(e) => {
                const up = e.key === "ArrowRight" || e.key === "ArrowUp";
                const down = e.key === "ArrowLeft" || e.key === "ArrowDown";
                if (up || down) {
                  e.preventDefault();
                  e.stopPropagation();
                  setConfidence((c) => stepConfidence(c, up ? 1 : -1));
                }
              }}
              aria-valuetext={band}
              className="w-full accent-foreground h-1.5 cursor-pointer disabled:cursor-not-allowed"
            />
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`thinking-${quiz.quiz_id}`} className={label}>
            {t.qThinkingLabel}
          </label>
          <textarea
            id={`thinking-${quiz.quiz_id}`}
            ref={thinkingRef}
            rows={2}
            value={thinking}
            onChange={(e) => setThinking(e.target.value)}
            onFocus={() => setActiveField("thinking")}
            placeholder={t.qThinkingPlaceholder}
            className={textarea}
          />
        </div>

        {error && (
          <p role="alert" className="text-danger text-xs font-ui">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-ui text-[10.5px] text-muted-foreground">{t.qKeyboardHint}</span>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void submit()}
            className={`flex items-center gap-2 py-2 px-4 rounded border font-ui text-[12px] uppercase tracking-wider font-semibold transition-colors ${
              ready
                ? "bg-accent hover:bg-border border-border text-foreground cursor-pointer"
                : "bg-background border-accent text-muted-foreground cursor-not-allowed"
            }`}
          >
            {submitting ? (
              <span className="w-3.5 h-3.5 border-2 border-t-transparent border-foreground rounded-full animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
            <span>{submitting ? t.qSending : t.qSubmit}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
