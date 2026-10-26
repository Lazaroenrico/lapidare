"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Award,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  Lightbulb,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import { useEventSubscription } from "./server-events";
import { useLocale } from "./locale-provider";
import { LessonProse } from "@/components/lesson-prose";
import {
  generatePracticeSet,
  getPracticeSets,
  submitPracticeAttempt,
} from "@/lib/api";
import type {
  HintLevel,
  HintStep,
  PracticeAttemptGrade,
  PracticeProblem,
  PracticeSet,
  RubricCriterion,
} from "@/lib/types";

export interface PracticeViewProps {
  initialSetId?: string;
  onClose?: () => void;
  onSelectCitation?: (sourceName: string, paragraphId: string) => void;
  className?: string;
}

export function PracticeView({
  initialSetId,
  onClose,
  onSelectCitation,
  className = "",
}: PracticeViewProps) {
  const { t } = useLocale();
  const RUNG_LABELS: Record<string, string> = t.rungLabels;
  const [practiceSets, setPracticeSets] = useState<PracticeSet[]>([]);
  const [activeSetId, setActiveSetId] = useState<string>(initialSetId || "");
  const [activeProblemIdx, setActiveProblemIdx] = useState<number>(0);

  // Per-problem state
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [grades, setGrades] = useState<Record<string, PracticeAttemptGrade>>({});
  const [unlockedHints, setUnlockedHints] = useState<Record<string, HintStep[]>>({});
  const [collapsedHints, setCollapsedHints] = useState<Record<string, boolean>>({});

  // Interaction loading states
  const [loadingSets, setLoadingSets] = useState<boolean>(true);
  const [generating, setGenerating] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [requestingHint, setRequestingHint] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Load practice sets on boot
  useEffect(() => {
    let mounted = true;
    async function loadSets() {
      setLoadingSets(true);
      setErrorMsg(null);
      try {
        const sets = await getPracticeSets();
        if (!mounted) return;
        setPracticeSets(sets);

        if (sets.length > 0) {
          const matched = initialSetId
            ? sets.find((s) => s.id === initialSetId)
            : sets[0];
          setActiveSetId(matched ? matched.id : sets[0].id);
        }
      } catch (err: any) {
        if (!mounted) return;
        console.error("[PracticeView] Erro ao carregar séries:", err);
        setErrorMsg(t.practiceLoadFailed);
      } finally {
        if (mounted) setLoadingSets(false);
      }
    }
    void loadSets();
    return () => {
      mounted = false;
    };
  }, [initialSetId]);

  useEventSubscription(["jobs:updated", "vault:changed"], () => {
    getPracticeSets().then(sets => {
      setPracticeSets(sets);
      if (sets.length && !activeSetId) setActiveSetId(sets[0].id);
    }).catch(e => setErrorMsg(e.message));
  });

  // Current active set and problem
  const activeSet = useMemo(() => {
    return practiceSets.find((s) => s.id === activeSetId) || null;
  }, [practiceSets, activeSetId]);

  const currentProblem: PracticeProblem | null = useMemo(() => {
    if (!activeSet || !activeSet.problems || activeSet.problems.length === 0) {
      return null;
    }
    const idx = Math.min(Math.max(activeProblemIdx, 0), activeSet.problems.length - 1);
    return activeSet.problems[idx] || null;
  }, [activeSet, activeProblemIdx]);

  // Current answer, grade, and hints for active problem
  const currentAnswer = currentProblem ? answers[currentProblem.id] || "" : "";
  const currentGrade = currentProblem ? grades[currentProblem.id] || null : null;
  const currentUnlockedHints = currentProblem ? unlockedHints[currentProblem.id] || [] : [];

  // Generate new practice set (prioritizing quiz mistakes)
  const handleGenerateSet = async (topics?: string[]) => {
    setGenerating(true);
    setErrorMsg(null);
    try {
      const newSet = await generatePracticeSet(topics);
      if ("job_id" in newSet) return;
      setPracticeSets((prev) => [newSet, ...prev]);
      setActiveSetId(newSet.id);
      setActiveProblemIdx(0);
    } catch (err: any) {
      console.error("[PracticeView] Erro ao gerar série:", err);
      setErrorMsg(t.practiceGenerateFailed);
    } finally {
      setGenerating(false);
    }
  };

  // Step hint ladder without grading or revealing final solution
  const handleRequestHint = async () => {
    if (!activeSet || !currentProblem || requestingHint) return;
    setRequestingHint(true);
    setErrorMsg(null);
    try {
      const res = await submitPracticeAttempt(
        activeSet.id,
        currentProblem.id,
        currentAnswer,
        true
      );
      if (res.next_hint) {
        const hint = res.next_hint;
        setUnlockedHints((prev) => {
          const list = prev[currentProblem.id] || [];
          if (list.some((h) => h.level === hint.level)) return prev;
          return {
            ...prev,
            [currentProblem.id]: [...list, hint],
          };
        });
        // Auto-expand newly unlocked hint
        setCollapsedHints((prev) => ({
          ...prev,
          [`${currentProblem.id}-${hint.level}`]: false,
        }));
      }
    } catch (err: any) {
      console.error("[PracticeView] Erro ao pedir dica:", err);
      setErrorMsg(t.practiceHintFailed);
    } finally {
      setRequestingHint(false);
    }
  };

  // Submit learner solution for rubric grading
  const handleSubmitSolution = async () => {
    if (!activeSet || !currentProblem || submitting) return;
    if (!currentAnswer.trim()) {
      setErrorMsg(t.practiceWriteFirst);
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await submitPracticeAttempt(
        activeSet.id,
        currentProblem.id,
        currentAnswer,
        false
      );
      if (res.grade) {
        setGrades((prev) => ({
          ...prev,
          [currentProblem.id]: res.grade!,
        }));
      }
    } catch (err: any) {
      console.error("[PracticeView] Erro ao submeter solução:", err);
      setErrorMsg(t.practiceGradeFailed);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleHintCollapse = (problemId: string, level: string) => {
    const key = `${problemId}-${level}`;
    setCollapsedHints((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  // Next hint level index: 0 -> R0, 1 -> R1, ..., 5 -> R5
  const nextHintLevelIndex = currentUnlockedHints.length;
  const allHintsUnlocked = nextHintLevelIndex >= 6;
  const nextHintLevelName = !allHintsUnlocked ? `R${nextHintLevelIndex}` : null;

  if (loadingSets) {
    return (
      <div className={`w-full h-full flex flex-col items-center justify-center bg-background text-muted-foreground ${className}`}>
        <Loader2 className="w-6 h-6 animate-spin mb-3 text-foreground" />
        <span className="font-ui text-xs tracking-wider">{t.practiceLoading}</span>
      </div>
    );
  }

  return (
    <div className={`w-full h-full flex flex-col bg-background text-foreground overflow-y-auto ${className}`}>
      {/* 1. Header Toolbar */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-6 py-4 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-foreground" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-ui text-[11px] tracking-wider uppercase text-muted-foreground">
                {t.practiceKicker}
              </span>
              {activeSet && (
                <span className="font-ui text-[11px] text-muted-foreground bg-card border border-border px-2 py-0.5 rounded">
                  {t.problemCount(activeSet.problems.length)}
                </span>
              )}
            </div>
            <h1 className="font-title text-xl text-foreground tracking-tight">
              {activeSet ? activeSet.title : t.practiceSet}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => handleGenerateSet()}
            disabled={generating}
            className="flex items-center gap-2 px-3 py-1.5 rounded border border-border bg-card hover:bg-accent text-foreground font-ui text-[12px] transition-colors disabled:opacity-50"
            title={t.practiceNewTitle}
          >
            {generating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}
            <span>{t.practiceNew}</span>
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title={t.practiceClose}
              aria-label={t.practiceClose}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </header>

      {/* Error notification banner if any */}
      {errorMsg && (
        <div className="mx-6 mt-4 p-3 rounded border border-danger/40 bg-danger/10 text-danger text-xs font-ui flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-muted-foreground hover:text-foreground"
            title={t.dismiss}
            aria-label={t.dismiss}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 2. Main Body: Empty State OR Active Problem Set */}
      {!activeSet || activeSet.problems.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-md mx-auto">
          <div className="w-12 h-12 rounded-full border border-border bg-card flex items-center justify-center mb-4 text-muted-foreground">
            <Award className="w-6 h-6" />
          </div>
          <h2 className="font-title text-xl text-foreground mb-2">
            {t.practiceEmptyTitle}
          </h2>
          <p className="font-prose text-sm text-muted-foreground mb-6">
            {t.practiceEmptyBody}
          </p>
          <button
            type="button"
            onClick={() => handleGenerateSet()}
            disabled={generating}
            className="flex items-center gap-2 px-5 py-2.5 rounded bg-foreground hover:bg-foreground/90 text-background font-ui font-semibold text-xs transition-colors disabled:opacity-50"
          >
            {generating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            <span>{t.practiceGenerateFromErrors}</span>
          </button>
        </div>
      ) : (
        <div className="flex-1 px-6 py-6 max-w-5xl w-full mx-auto flex flex-col gap-6">
          {/* Problem Tabs Navigation */}
          <nav className="flex items-center gap-2 border-b border-border pb-3 overflow-x-auto">
            {activeSet.problems.map((prob, idx) => {
              const isSelected = idx === activeProblemIdx;
              const probGrade = grades[prob.id];
              const isPassed = probGrade?.score && probGrade.score >= 7;

              return (
                <button
                  key={prob.id}
                  type="button"
                  onClick={() => setActiveProblemIdx(idx)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded font-ui text-[12px] transition-colors whitespace-nowrap border ${
                    isSelected
                      ? "bg-accent text-foreground border-muted-foreground"
                      : "bg-card text-muted-foreground border-border hover:text-foreground"
                  }`}
                >
                  {probGrade ? (
                    isPassed ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-danger" />
                    )
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground" />
                  )}
                  <span>
                    {t.problemTab(idx + 1, prob.title || prob.topic || t.exercise(idx + 1))}
                  </span>
                  {probGrade && (
                    <span className="text-[10px] opacity-75">
                      ({probGrade.score}/10)
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {currentProblem && (
            <div className="flex flex-col gap-6">
              {/* Problem Statement Card */}
              <article className="rounded-lg border border-border bg-card p-6 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4 border-b border-border/60 pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground bg-background border border-border px-2 py-0.5 rounded">
                      {currentProblem.kind || "composition"}
                    </span>
                    {(currentProblem.target_concepts || [currentProblem.topic]).map((concept) => (
                      <span
                        key={concept}
                        className="font-ui text-[11px] text-foreground bg-accent border border-border px-2 py-0.5 rounded"
                      >
                        [[{concept}]]
                      </span>
                    ))}
                  </div>

                  <span className="font-ui text-[11px] text-muted-foreground">
                    {t.maxWeight}
                  </span>
                </div>

                {/* Enunciado do Problema com KaTeX e LessonProse */}
                <div className="prose-container mb-6 font-prose text-foreground text-[15px] leading-relaxed">
                  <LessonProse
                    content={currentProblem.prompt}
                    onSelectCitation={onSelectCitation}
                  />
                </div>

                {/* Rubric Breakdown Preview */}
                {currentProblem.rubric && currentProblem.rubric.length > 0 && (
                  <div className="rounded border border-border/60 bg-background p-3 text-[12px]">
                    <div className="flex items-center gap-1.5 text-muted-foreground font-ui text-[11px] uppercase tracking-wider mb-2">
                      <HelpCircle className="w-3.5 h-3.5" />
                      <span>{t.rubricHeading}</span>
                    </div>
                    <ul className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      {currentProblem.rubric.map((crit, cIdx) => (
                        <li
                          key={crit.name || crit.description || cIdx}
                          className="flex items-start justify-between gap-2 p-2 rounded bg-card border border-border/40"
                        >
                          <span className="text-muted-foreground font-prose text-[12px] leading-snug">
                            {crit.description || crit.name}
                          </span>
                          <span className="font-ui text-[11px] text-foreground shrink-0">
                            {t.points(crit.weight || (crit as any).max_points || 3)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>

              {/* Progressive Socratic Hint Ladder (R0 to R5) */}
              <section className="rounded-lg border border-border bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <div className="flex items-center gap-2">
                    <Lightbulb className="w-4 h-4 text-foreground" />
                    <h3 className="font-ui text-xs uppercase tracking-wider text-foreground font-semibold">
                      {t.hintLadder}
                    </h3>
                    <span className="font-ui text-[11px] text-muted-foreground">
                      {t.hintsUnlocked(currentUnlockedHints.length)}
                    </span>
                  </div>

                  {/* Button to unlock next hint rung */}
                  <button
                    type="button"
                    onClick={handleRequestHint}
                    disabled={requestingHint || allHintsUnlocked}
                    className="flex items-center gap-2 px-3 py-1.5 rounded border border-border bg-accent hover:bg-border text-foreground font-ui text-[12px] transition-colors disabled:opacity-50"
                  >
                    {requestingHint ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Lightbulb className="w-3.5 h-3.5 text-foreground" />
                    )}
                    <span>
                      {allHintsUnlocked
                        ? t.allHintsUnlocked
                        : t.requestHint(nextHintLevelName || "", RUNG_LABELS[nextHintLevelName || ""] || t.hintFallback)}
                    </span>
                  </button>
                </div>

                {/* Hint Ladder Progress Indicators */}
                <div className="grid grid-cols-6 gap-1 mb-4">
                  {(["R0", "R1", "R2", "R3", "R4", "R5"] as HintLevel[]).map((level, idx) => {
                    const isUnlocked = idx < currentUnlockedHints.length;
                    return (
                      <div
                        key={level}
                        className={`h-1.5 rounded-full transition-colors ${
                          isUnlocked ? "bg-foreground" : "bg-accent border border-border"
                        }`}
                        title={`${level}: ${RUNG_LABELS[level] || ""}`}
                      />
                    );
                  })}
                </div>

                {/* Unlocked Hint Cards */}
                {currentUnlockedHints.length === 0 ? (
                  <p className="font-prose text-xs text-muted-foreground italic py-2">
                    {t.hintsEmpty}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {currentUnlockedHints.map((hint) => {
                      const collapseKey = `${currentProblem.id}-${hint.level}`;
                      const isCollapsed = Boolean(collapsedHints[collapseKey]);

                      return (
                        <div
                          key={hint.level}
                          className="rounded border border-border bg-background overflow-hidden"
                        >
                          <button
                            type="button"
                            onClick={() => toggleHintCollapse(currentProblem.id, hint.level)}
                            className="w-full flex items-center justify-between px-3.5 py-2.5 bg-background hover:bg-card transition-colors text-left"
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-ui text-[11px] font-semibold text-background bg-foreground px-1.5 py-0.5 rounded">
                                {hint.level}
                              </span>
                              <span className="font-ui text-xs font-medium text-foreground">
                                {hint.title || (hint as any).label || RUNG_LABELS[hint.level] || t.guidance}
                              </span>
                            </div>
                            {isCollapsed ? (
                              <ChevronRight className="w-4 h-4 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="w-4 h-4 text-muted-foreground" />
                            )}
                          </button>

                          {!isCollapsed && (
                            <div className="px-3.5 py-3 border-t border-border/60 bg-background font-prose text-[14px] text-foreground leading-relaxed">
                              <LessonProse
                                content={hint.content || (hint as any).prompt || ""}
                                onSelectCitation={onSelectCitation}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Answer Composer */}
              <section className="rounded-lg border border-border bg-card p-5">
                <div className="flex items-center justify-between mb-3">
                  <label
                    htmlFor="practice-solution-input"
                    className="font-ui text-xs uppercase tracking-wider text-foreground font-semibold"
                  >
                    {t.yourSolution}
                  </label>
                  <span className="font-ui text-[11px] text-muted-foreground">
                    {t.charWordCount(currentAnswer.length, currentAnswer.trim() ? currentAnswer.trim().split(/\s+/).length : 0)}
                  </span>
                </div>

                <textarea
                  id="practice-solution-input"
                  value={currentAnswer}
                  onChange={(e) =>
                    setAnswers((prev) => ({
                      ...prev,
                      [currentProblem.id]: e.target.value,
                    }))
                  }
                  rows={8}
                  placeholder={t.solutionPlaceholder}
                  className="w-full bg-background border border-border text-foreground placeholder-muted-foreground/50 font-prose text-[15px] p-4 rounded-md focus:border-muted-foreground transition-colors resize-y leading-relaxed"
                />

                <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-3 border-t border-border/60">
                  <span className="font-ui text-[11px] text-muted-foreground">
                    {t.pressBefore}<kbd className="px-1.5 py-0.5 bg-background border border-border rounded text-foreground">Ctrl + Enter</kbd>{t.pressAfter}
                  </span>

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleSubmitSolution}
                      disabled={submitting || !currentAnswer.trim()}
                      className="flex items-center gap-2 px-4 py-2 rounded bg-foreground hover:bg-foreground/90 text-background font-ui font-semibold text-[12px] transition-colors disabled:opacity-50"
                    >
                      {submitting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                      <span>{t.submitSolution}</span>
                    </button>
                  </div>
                </div>
              </section>

              {/* Grading Scorecard (Displayed after submission) */}
              {currentGrade && (
                <article className="rounded-lg border border-border bg-card p-6 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-4 mb-5 border-b border-border/60 pb-4">
                    <div className="flex items-center gap-3">
                      <div className="font-title text-3xl text-foreground">
                        {currentGrade.score}
                        <span className="text-lg text-muted-foreground font-normal"> / {currentGrade.max_score || 10}</span>
                      </div>

                      {currentGrade.score >= 7 || (currentGrade as any).passed ? (
                        <span className="flex items-center gap-1.5 font-ui text-xs font-semibold px-2.5 py-1 rounded bg-success/10 text-success border border-success/30">
                          <Check className="w-3.5 h-3.5" />
                          <span>{t.passed}</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 font-ui text-xs font-semibold px-2.5 py-1 rounded bg-danger/10 text-danger border border-danger/30">
                          <AlertCircle className="w-3.5 h-3.5" />
                          <span>{t.needsReview}</span>
                        </span>
                      )}
                    </div>

                    {activeProblemIdx < activeSet.problems.length - 1 && (
                      <button
                        type="button"
                        onClick={() => setActiveProblemIdx((prev) => prev + 1)}
                        className="flex items-center gap-2 px-3 py-1.5 rounded border border-border bg-accent hover:bg-border text-foreground font-ui text-xs transition-colors"
                      >
                        <span>{t.nextProblem}</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Rubric Criterion Breakdown Scores */}
                  {currentGrade.rubric_scores && Object.keys(currentGrade.rubric_scores).length > 0 && (
                    <div className="mb-5">
                      <h4 className="font-ui text-xs uppercase tracking-wider text-muted-foreground mb-2.5">
                        {t.rubricScores}
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {Object.entries(currentGrade.rubric_scores).map(([critId, score]) => (
                          <div
                            key={critId}
                            className="p-3 rounded border border-border bg-background flex flex-col justify-between"
                          >
                            <span className="font-ui text-[11px] text-muted-foreground uppercase mb-1">
                              {critId}
                            </span>
                            <div className="flex items-center justify-between">
                              <span className="font-ui text-sm font-semibold text-foreground">
                                {t.points(score)}
                              </span>
                              <div className="w-16 h-1.5 bg-accent rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-foreground"
                                  style={{ width: `${Math.min(100, (Number(score) / 4) * 100)}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Detailed Pedagogical Feedback */}
                  <div>
                    <h4 className="font-ui text-xs uppercase tracking-wider text-muted-foreground mb-2">
                      {t.pedagogicalDiagnosis}
                    </h4>
                    <div className="p-4 rounded border border-border bg-background font-prose text-[14px] text-foreground leading-relaxed">
                      <LessonProse
                        content={currentGrade.feedback || t.gradeRecorded}
                        onSelectCitation={onSelectCitation}
                      />
                    </div>
                  </div>
                </article>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
