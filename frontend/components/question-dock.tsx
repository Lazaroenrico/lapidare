"use client";

import { useLocale } from "@/components/locale-provider";
import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Mic,
  MicOff,
  Send,
  Sparkles,
} from "lucide-react";
import type {
  CalibrationBand,
  CalibrationResult,
  QuizOption,
  QuizPayload,
  QuizSubmission,
} from "@/lib/types";
import { submitQuizAnswer } from "@/lib/api";

interface QuestionDockProps {
  quiz: QuizPayload;
  sessionId: string;
  onAnswerSubmitted?: (result: CalibrationResult) => void;
  initialResult?: CalibrationResult | null;
  className?: string;
}

export function QuestionDock({
  quiz,
  sessionId,
  onAnswerSubmitted,
  initialResult = null,
  className = "",
}: QuestionDockProps) {
  // Modes: PREDICTION starts open, CHECK starts collapsed as a compact pill
  const {locale, t} = useLocale();
  const [isExpanded, setIsExpanded] = useState<boolean>(() => {
    return quiz.mode === "PREDICTION" || initialResult !== null;
  });

  const [selectedChoice, setSelectedChoice] = useState<number | null>(() => {
    return initialResult ? initialResult.chosen_index : null;
  });
  const [confidence, setConfidence] = useState<number>(() => {
    return initialResult ? initialResult.confidence : 50;
  });
  const [learnerThinking, setLearnerThinking] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [result, setResult] = useState<CalibrationResult | null>(initialResult);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Dictation state (Web Speech API)
  const [isListening, setIsListening] = useState<boolean>(false);
  const [speechSupported, setSpeechSupported] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const hasSpeech =
        "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
      setSpeechSupported(hasSpeech);
    }
  }, []);

  // Update when initialResult changes from props
  useEffect(() => {
    if (initialResult) {
      setResult(initialResult);
      setSelectedChoice(initialResult.chosen_index);
      setConfidence(initialResult.confidence);
      setIsExpanded(true);
    }
  }, [initialResult]);

  // Confidence bands
  const getConfidenceBand = (val: number): { label: string; color: string } => {
    if (val < 50) {
      return { label: t.confLow, color: "text-muted-foreground" };
    }
    if (val < 70) {
      return { label: t.confMid, color: "text-foreground" };
    }
    return { label: t.confHigh, color: "text-warning" };
  };

  const currentBand = getConfidenceBand(confidence);

  // Speech recognition dictation handler
  const handleToggleDictation = () => {
    if (typeof window === "undefined") return;

    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert(t.speechUnsupported);
      return;
    }

    if (isListening) {
      setIsListening(false);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = locale === "en" ? "en-US" : "pt-BR";
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setLearnerThinking((prev) =>
          prev ? `${prev} ${transcript}` : transcript
        );
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.start();
    } catch {
      setIsListening(false);
    }
  };

  // Submission handler
  const handleSubmit = async () => {
    if (selectedChoice === null) return;
    setIsSubmitting(true);
    setErrorMsg(null);

    const submission: QuizSubmission = {
      quiz_id: quiz.id,
      chosen_index: selectedChoice,
      confidence,
      learner_thinking: learnerThinking.trim() || undefined,
    };

    try {
      const res = await submitQuizAnswer(sessionId, submission);
      setResult(res);
      if (onAnswerSubmitted) {
        onAnswerSubmitted(res);
      }
    } catch (err: any) {
      console.error("Failed to submit quiz answer:", err);
      setErrorMsg(
        err?.message || t.answerSendFailed
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // Special index for "Não sei — me ensina / I don't know"
  const DONT_KNOW_INDEX = -1;

  // Render collapsed compact pill for CHECK mode
  if (!isExpanded && !result) {
    return (
      <div className={`my-4 ${className}`}>
        <button
          type="button"
          onClick={() => setIsExpanded(true)}
          className="w-full group flex items-center justify-between px-4 py-3 bg-card hover:bg-accent border border-border hover:border-muted-foreground rounded-lg cursor-pointer transition-all active:scale-[0.99] text-left shadow-md"
        >
          <div className="flex items-center gap-2.5">
            <span className="w-5 h-5 rounded-full bg-accent group-hover:bg-border border border-border flex items-center justify-center text-[11px] text-foreground font-ui transition-colors">
              ✓
            </span>
            <div className="flex flex-col">
              <span className="text-[13px] font-semibold text-foreground font-ui tracking-wide group-hover:text-foreground">
                {t.dockCollapsedTitle}
              </span>
              <span className="text-[11px] text-muted-foreground font-prose">
                {t.dockCollapsedHint}
              </span>
            </div>
          </div>
          <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
        </button>
      </div>
    );
  }

  // Render calibration feedback badge
  const renderCalibrationBadge = (band: CalibrationBand) => {
    switch (band) {
      case "calibrated":
        return (
          <div className="p-3 rounded-lg border border-success/60 bg-success/10 text-success flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" />
            <div>
              <p className="font-ui text-[12px] font-bold tracking-wide">
                {t.bandCalibratedTitle}
              </p>
              <p className="font-prose text-[13px] text-success/90 mt-0.5 leading-relaxed">
                {t.bandCalibratedBody}
              </p>
            </div>
          </div>
        );
      case "illusion_of_competence":
        return (
          <div className="p-3.5 rounded-lg border-2 border-warning bg-warning/10 text-warning shadow-[0_0_20px_color-mix(in_srgb,var(--warning)_20%,transparent)] flex items-start gap-2.5">
            <AlertTriangle className="w-5 h-5 text-warning mt-0.5 shrink-0 animate-pulse" />
            <div>
              <p className="font-ui text-[12.5px] font-bold tracking-wide text-warning">
                {t.bandIllusionTitle}
              </p>
              <p className="font-prose text-[13.5px] text-warning mt-1 leading-relaxed">
                {t.bandIllusionBody}
              </p>
            </div>
          </div>
        );
      case "fragile_intuition":
        return (
          <div className="p-3 rounded-lg border border-warning/40 bg-card text-foreground flex items-start gap-2.5">
            <Sparkles className="w-4 h-4 text-warning mt-0.5 shrink-0" />
            <div>
              <p className="font-ui text-[12px] font-bold tracking-wide text-warning">
                {t.bandFragileTitle}
              </p>
              <p className="font-prose text-[13px] text-foreground/90 mt-0.5 leading-relaxed">
                {t.bandFragileBody}
              </p>
            </div>
          </div>
        );
      case "conscious_gap":
        return (
          <div className="p-3 rounded-lg border border-border bg-card text-foreground flex items-start gap-2.5">
            <HelpCircle className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="font-ui text-[12px] font-bold tracking-wide text-foreground">
                {t.bandGapTitle}
              </p>
              <p className="font-prose text-[13px] text-foreground/90 mt-0.5 leading-relaxed">
                {t.bandGapBody}
              </p>
            </div>
          </div>
        );
    }
  };

  return (
    <div
      className={`my-5 rounded-lg bg-card border transition-all duration-200 shadow-xl overflow-hidden ${
        result?.band === "illusion_of_competence"
          ? "border-warning/80 shadow-[0_0_24px_color-mix(in_srgb,var(--warning)_15%,transparent)]"
          : "border-border"
      } ${className}`}
    >
      {/* Header bar */}
      <div className="px-4 py-2.5 bg-background border-b border-border flex items-center justify-between text-xs font-ui">
        <div className="flex items-center gap-2">
          {quiz.mode === "PREDICTION" ? (
            <span className="px-2 py-0.5 rounded bg-warning/15 text-warning border border-warning/30 font-bold uppercase tracking-wider text-[10.5px]">
              {t.dockPrediction}
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded bg-accent text-foreground border border-border font-bold uppercase tracking-wider text-[10.5px]">
              {t.dockCheck}
            </span>
          )}
          {quiz.target_concept && (
            <span className="text-muted-foreground hidden sm:inline">
              {t.dockTarget(quiz.target_concept)}
            </span>
          )}
        </div>

        {quiz.mode === "CHECK" && !result && (
          <button
            type="button"
            onClick={() => setIsExpanded(false)}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            title={t.dockCollapse}
            aria-label={t.dockCollapse}
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="p-5 flex flex-col gap-4">
        {/* Question Stem */}
        <div className="font-prose text-[16.5px] leading-relaxed text-foreground select-text">
          {quiz.question}
        </div>

        {/* Choices (2 to 6 options + fixed "Não sei — me ensina") */}
        <div className="flex flex-col gap-2">
          {quiz.options.map((option) => {
            const isSelected = selectedChoice === option.index;
            const isCorrect = result && result.correct_index === option.index;
            const isChosen = result && result.chosen_index === option.index;

            let optionStyle =
              "bg-background border-border text-foreground hover:bg-accent hover:border-muted-foreground";

            if (result) {
              if (isCorrect) {
                optionStyle =
                  "bg-success/10 border-success/80 text-success font-semibold";
              } else if (isChosen && !isCorrect) {
                optionStyle =
                  "bg-danger/10 border-danger/80 text-danger line-through";
              } else {
                optionStyle = "bg-background/50 border-accent text-muted-foreground";
              }
            } else if (isSelected) {
              optionStyle =
                "bg-accent border-foreground text-foreground shadow-sm";
            }

            return (
              <button
                key={option.index}
                type="button"
                disabled={result !== null || isSubmitting}
                onClick={() => setSelectedChoice(option.index)}
                className={`flex items-start gap-3 p-3 rounded border text-left cursor-pointer transition-all ${optionStyle} ${
                  result !== null ? "cursor-default" : ""
                }`}
              >
                <span className="w-5 h-5 rounded-full bg-card border border-border flex items-center justify-center text-[11px] font-ui text-muted-foreground shrink-0 mt-0.5">
                  {option.label || String.fromCharCode(65 + option.index)}
                </span>
                <span className="font-prose text-[15px] leading-snug flex-1 select-text">
                  {option.text}
                </span>
                {result && isCorrect && (
                  <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
                )}
              </button>
            );
          })}

          {/* Fixed final option: "Não sei — me ensina / I don't know" */}
          {quiz.has_dont_know !== false && (
            <button
              type="button"
              disabled={result !== null || isSubmitting}
              onClick={() => {
                setSelectedChoice(DONT_KNOW_INDEX);
                setConfidence(0);
              }}
              className={`flex items-center gap-3 p-2.5 rounded border text-left cursor-pointer transition-all ${
                selectedChoice === DONT_KNOW_INDEX
                  ? "bg-accent border-foreground text-foreground"
                  : "bg-background border-border text-muted-foreground hover:text-foreground hover:bg-accent"
              } ${result !== null ? "cursor-default" : ""}`}
            >
              <span className="w-5 h-5 rounded-full bg-card border border-border flex items-center justify-center text-[10.5px] font-ui text-muted-foreground shrink-0">
                ?
              </span>
              <span className="font-ui text-[12.5px] tracking-wide">
                {t.dontKnow}
              </span>
            </button>
          )}
        </div>

        {/* Only show Confidence Slider and Thinking Input before submission */}
        {!result && (
          <div className="flex flex-col gap-4 pt-2 border-t border-accent">
            {/* Confidence Slider: 0% to 100% */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs font-ui">
                <span className="text-muted-foreground uppercase tracking-wider text-[11px]">
                  {t.confidence}
                </span>
                <span className={`font-bold ${currentBand.color}`}>
                  {confidence}% · {currentBand.label}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={confidence}
                onChange={(e) => setConfidence(Number(e.target.value))}
                className="w-full accent-foreground bg-accent h-1.5 rounded cursor-pointer transition-all"
              />
              <div className="flex justify-between text-[10px] font-ui text-muted-foreground px-0.5">
                <span>{t.confScale0}</span>
                <span>{t.confScale50}</span>
                <span>{t.confScale100}</span>
              </div>
            </div>

            {/* YOUR THINKING Input with Mic Dictation Button */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs font-ui">
                <label
                  htmlFor={`thinking-${quiz.id}`}
                  className="text-muted-foreground uppercase tracking-wider text-[11px]"
                >
                  {t.thinking}
                </label>
                {speechSupported && (
                  <button
                    type="button"
                    onClick={handleToggleDictation}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-ui transition-colors cursor-pointer ${
                      isListening
                        ? "bg-danger/10 text-danger border-danger animate-pulse"
                        : "bg-background text-muted-foreground border-border hover:text-foreground"
                    }`}
                    title={t.dictateThinking}
                  >
                    {isListening ? (
                      <>
                        <MicOff className="w-3 h-3 text-danger" />
                        <span>{t.listening}</span>
                      </>
                    ) : (
                      <>
                        <Mic className="w-3 h-3" />
                        <span>{t.dictation}</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              <div className="relative">
                <textarea
                  id={`thinking-${quiz.id}`}
                  rows={2}
                  value={learnerThinking}
                  onChange={(e) => setLearnerThinking(e.target.value)}
                  placeholder={t.thinkingPrompt}
                  className="w-full bg-background border border-border rounded p-2.5 text-[13px] font-prose text-foreground placeholder-muted-foreground focus:border-foreground transition-colors resize-none leading-relaxed"
                />
              </div>
            </div>

            {errorMsg && (
              <p className="text-danger text-xs font-ui">{errorMsg}</p>
            )}

            {/* Submit Button */}
            <button
              type="button"
              disabled={selectedChoice === null || isSubmitting}
              onClick={handleSubmit}
              className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded border font-ui text-[12px] uppercase tracking-wider font-bold transition-all cursor-pointer ${
                selectedChoice === null || isSubmitting
                  ? "bg-background border-accent text-muted-foreground cursor-not-allowed"
                  : "bg-accent hover:bg-border border-border text-foreground active:scale-[0.99] shadow-md"
              }`}
            >
              {isSubmitting ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-t-transparent border-foreground rounded-full animate-spin" />
                  <span>{t.evaluating}</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>{t.confirmCalibrate}</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Display Feedback Prose & Calibration Result after submission */}
        {result && (
          <div className="flex flex-col gap-3 pt-3 border-t border-accent">
            {renderCalibrationBadge(result.band)}

            {result.feedback_prose && (
              <div className="p-3.5 rounded bg-background border border-accent font-prose text-[14px] leading-relaxed text-foreground select-text">
                <span className="font-ui text-[10.5px] uppercase tracking-wider text-muted-foreground block mb-1">
                  {t.pedagogicalAnalysis}
                </span>
                {result.feedback_prose}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
