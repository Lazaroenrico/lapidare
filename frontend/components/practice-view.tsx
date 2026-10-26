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

const RUNG_LABELS: Record<string, string> = {
  R0: "Isolar Subproblema",
  R1: "Relembrar Definição",
  R2: "Caso Limite Concreto (N=2)",
  R3: "Esqueleto de Solução",
  R4: "Contraexemplo Típico",
  R5: "Solução Canônica Comentada",
};

export function PracticeView({
  initialSetId,
  onClose,
  onSelectCitation,
  className = "",
}: PracticeViewProps) {
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
        setErrorMsg("Não foi possível carregar as séries de prática.");
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
      setErrorMsg("Falha ao gerar nova série de prática. Verifique a conexão com o backend.");
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
      setErrorMsg("Não foi possível obter a próxima dica.");
    } finally {
      setRequestingHint(false);
    }
  };

  // Submit learner solution for rubric grading
  const handleSubmitSolution = async () => {
    if (!activeSet || !currentProblem || submitting) return;
    if (!currentAnswer.trim()) {
      setErrorMsg("Escreva sua resposta antes de submeter para avaliação.");
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
      setErrorMsg("Falha ao avaliar resposta. Tente novamente.");
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
      <div className={`w-full h-full flex flex-col items-center justify-center bg-[#141414] text-[#8d8d8d] ${className}`}>
        <Loader2 className="w-6 h-6 animate-spin mb-3 text-[#e6e6e6]" />
        <span className="font-ui text-xs tracking-wider">CARREGANDO SÉRIES DE PRÁTICA...</span>
      </div>
    );
  }

  return (
    <div className={`w-full h-full flex flex-col bg-[#141414] text-[#e6e6e6] overflow-y-auto ${className}`}>
      {/* 1. Header Toolbar */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-6 py-4 border-b border-[#434343] bg-[#141414]/95 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-[#e6e6e6]" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-ui text-[11px] tracking-wider uppercase text-[#8d8d8d]">
                TREINO FRIO · PRACTICE
              </span>
              {activeSet && (
                <span className="font-ui text-[11px] text-[#8d8d8d] bg-[#1c1c1c] border border-[#434343] px-2 py-0.5 rounded">
                  {activeSet.problems.length} {activeSet.problems.length === 1 ? "problema" : "problemas"}
                </span>
              )}
            </div>
            <h1 className="font-title text-xl text-[#e6e6e6] tracking-tight">
              {activeSet ? activeSet.title : "Série de Prática"}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => handleGenerateSet()}
            disabled={generating}
            className="flex items-center gap-2 px-3 py-1.5 rounded border border-[#434343] bg-[#1c1c1c] hover:bg-[#2a2a2a] text-[#e6e6e6] font-ui text-[12px] transition-colors disabled:opacity-50"
            title="Gerar nova série focada nos erros do quiz-log"
          >
            {generating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}
            <span>+ Nova Série de Prática</span>
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded hover:bg-[#2a2a2a] text-[#8d8d8d] hover:text-[#e6e6e6] transition-colors"
              title="Fechar Prática"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </header>

      {/* Error notification banner if any */}
      {errorMsg && (
        <div className="mx-6 mt-4 p-3 rounded border border-[#f87171]/40 bg-[#f87171]/10 text-[#f87171] text-xs font-ui flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-[#8d8d8d] hover:text-[#e6e6e6]"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 2. Main Body: Empty State OR Active Problem Set */}
      {!activeSet || activeSet.problems.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-md mx-auto">
          <div className="w-12 h-12 rounded-full border border-[#434343] bg-[#1c1c1c] flex items-center justify-center mb-4 text-[#8d8d8d]">
            <Award className="w-6 h-6" />
          </div>
          <h2 className="font-title text-xl text-[#e6e6e6] mb-2">
            Nenhuma Série de Prática Ativa
          </h2>
          <p className="font-prose text-sm text-[#8d8d8d] mb-6">
            O gerador LangGraph extrai tópicos prioritários do seu histórico (como
            ilusões de competência e lacunas de retenção) e formula problemas com
            solução canônica pré-fixada (*commit-before-pose*).
          </p>
          <button
            type="button"
            onClick={() => handleGenerateSet()}
            disabled={generating}
            className="flex items-center gap-2 px-5 py-2.5 rounded bg-[#e6e6e6] hover:bg-white text-[#141414] font-ui font-semibold text-xs transition-colors disabled:opacity-50"
          >
            {generating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            <span>Gerar Série Baseada em Erros</span>
          </button>
        </div>
      ) : (
        <div className="flex-1 px-6 py-6 max-w-5xl w-full mx-auto flex flex-col gap-6">
          {/* Problem Tabs Navigation */}
          <nav className="flex items-center gap-2 border-b border-[#434343] pb-3 overflow-x-auto">
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
                      ? "bg-[#2a2a2a] text-[#e6e6e6] border-[#8d8d8d]"
                      : "bg-[#1c1c1c] text-[#8d8d8d] border-[#434343] hover:text-[#e6e6e6]"
                  }`}
                >
                  {probGrade ? (
                    isPassed ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#34d399]" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-[#f87171]" />
                    )
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-[#8d8d8d]" />
                  )}
                  <span>
                    Problema {idx + 1}: {prob.title || prob.topic || `Exercício ${idx + 1}`}
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
              <article className="rounded-lg border border-[#434343] bg-[#1c1c1c] p-6 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4 border-b border-[#434343]/60 pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-ui text-[11px] uppercase tracking-wider text-[#8d8d8d] bg-[#141414] border border-[#434343] px-2 py-0.5 rounded">
                      {currentProblem.kind || "composition"}
                    </span>
                    {(currentProblem.target_concepts || [currentProblem.topic]).map((concept) => (
                      <span
                        key={concept}
                        className="font-ui text-[11px] text-[#e6e6e6] bg-[#2a2a2a] border border-[#434343] px-2 py-0.5 rounded"
                      >
                        [[{concept}]]
                      </span>
                    ))}
                  </div>

                  <span className="font-ui text-[11px] text-[#8d8d8d]">
                    Peso Máximo: 10 pontos
                  </span>
                </div>

                {/* Enunciado do Problema com KaTeX e LessonProse */}
                <div className="prose-container mb-6 font-prose text-[#e6e6e6] text-[15px] leading-relaxed">
                  <LessonProse
                    content={currentProblem.prompt}
                    onSelectCitation={onSelectCitation}
                  />
                </div>

                {/* Rubric Breakdown Preview */}
                {currentProblem.rubric && currentProblem.rubric.length > 0 && (
                  <div className="rounded border border-[#434343]/60 bg-[#141414] p-3 text-[12px]">
                    <div className="flex items-center gap-1.5 text-[#8d8d8d] font-ui text-[11px] uppercase tracking-wider mb-2">
                      <HelpCircle className="w-3.5 h-3.5" />
                      <span>Critérios de Avaliação (Rubrica 10 pts)</span>
                    </div>
                    <ul className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      {currentProblem.rubric.map((crit, cIdx) => (
                        <li
                          key={crit.name || crit.description || cIdx}
                          className="flex items-start justify-between gap-2 p-2 rounded bg-[#1c1c1c] border border-[#434343]/40"
                        >
                          <span className="text-[#8d8d8d] font-prose text-[12px] leading-snug">
                            {crit.description || crit.name}
                          </span>
                          <span className="font-ui text-[11px] text-[#e6e6e6] shrink-0">
                            {crit.weight || (crit as any).max_points || 3} pts
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>

              {/* Progressive Socratic Hint Ladder (R0 to R5) */}
              <section className="rounded-lg border border-[#434343] bg-[#1c1c1c] p-5">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <div className="flex items-center gap-2">
                    <Lightbulb className="w-4 h-4 text-[#e6e6e6]" />
                    <h3 className="font-ui text-xs uppercase tracking-wider text-[#e6e6e6] font-semibold">
                      Escada Socrática de Dicas (R0 – R5)
                    </h3>
                    <span className="font-ui text-[11px] text-[#8d8d8d]">
                      · {currentUnlockedHints.length} de 6 desbloqueadas
                    </span>
                  </div>

                  {/* Button to unlock next hint rung */}
                  <button
                    type="button"
                    onClick={handleRequestHint}
                    disabled={requestingHint || allHintsUnlocked}
                    className="flex items-center gap-2 px-3 py-1.5 rounded border border-[#434343] bg-[#2a2a2a] hover:bg-[#333333] text-[#e6e6e6] font-ui text-[12px] transition-colors disabled:opacity-50"
                  >
                    {requestingHint ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Lightbulb className="w-3.5 h-3.5 text-[#e6e6e6]" />
                    )}
                    <span>
                      {allHintsUnlocked
                        ? "Todas as dicas desbloqueadas (R0–R5)"
                        : `Pedir Dica (Próximo Nível: ${nextHintLevelName} · ${RUNG_LABELS[nextHintLevelName || ""] || "Pista"})`}
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
                          isUnlocked ? "bg-[#e6e6e6]" : "bg-[#2a2a2a] border border-[#434343]"
                        }`}
                        title={`${level}: ${RUNG_LABELS[level] || ""}`}
                      />
                    );
                  })}
                </div>

                {/* Unlocked Hint Cards */}
                {currentUnlockedHints.length === 0 ? (
                  <p className="font-prose text-xs text-[#8d8d8d] italic py-2">
                    Tente formular a solução de memória antes de solicitar pistas.
                    Se travar na invariante central, peça o nível R0 sem penalidade.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {currentUnlockedHints.map((hint) => {
                      const collapseKey = `${currentProblem.id}-${hint.level}`;
                      const isCollapsed = Boolean(collapsedHints[collapseKey]);

                      return (
                        <div
                          key={hint.level}
                          className="rounded border border-[#434343] bg-[#141414] overflow-hidden"
                        >
                          <button
                            type="button"
                            onClick={() => toggleHintCollapse(currentProblem.id, hint.level)}
                            className="w-full flex items-center justify-between px-3.5 py-2.5 bg-[#141414] hover:bg-[#1a1a1a] transition-colors text-left"
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-ui text-[11px] font-semibold text-[#141414] bg-[#e6e6e6] px-1.5 py-0.5 rounded">
                                {hint.level}
                              </span>
                              <span className="font-ui text-xs font-medium text-[#e6e6e6]">
                                {hint.title || (hint as any).label || RUNG_LABELS[hint.level] || "Orientação"}
                              </span>
                            </div>
                            {isCollapsed ? (
                              <ChevronRight className="w-4 h-4 text-[#8d8d8d]" />
                            ) : (
                              <ChevronDown className="w-4 h-4 text-[#8d8d8d]" />
                            )}
                          </button>

                          {!isCollapsed && (
                            <div className="px-3.5 py-3 border-t border-[#434343]/60 bg-[#141414] font-prose text-[14px] text-[#e6e6e6] leading-relaxed">
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
              <section className="rounded-lg border border-[#434343] bg-[#1c1c1c] p-5">
                <div className="flex items-center justify-between mb-3">
                  <label
                    htmlFor="practice-solution-input"
                    className="font-ui text-xs uppercase tracking-wider text-[#e6e6e6] font-semibold"
                  >
                    Sua Solução (Commit-Before-Pose)
                  </label>
                  <span className="font-ui text-[11px] text-[#8d8d8d]">
                    {currentAnswer.length} caracteres · {currentAnswer.trim() ? currentAnswer.trim().split(/\s+/).length : 0} palavras
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
                  placeholder="Escreva de memória a formulação matemática, diagrama textual ou implementação dos invariantes..."
                  className="w-full bg-[#141414] border border-[#434343] text-[#e6e6e6] placeholder-[#8d8d8d]/50 font-prose text-[15px] p-4 rounded-md focus:border-[#8d8d8d] transition-colors resize-y leading-relaxed"
                />

                <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-3 border-t border-[#434343]/60">
                  <span className="font-ui text-[11px] text-[#8d8d8d]">
                    Pressione <kbd className="px-1.5 py-0.5 bg-[#141414] border border-[#434343] rounded text-[#e6e6e6]">Ctrl + Enter</kbd> para submeter.
                  </span>

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleSubmitSolution}
                      disabled={submitting || !currentAnswer.trim()}
                      className="flex items-center gap-2 px-4 py-2 rounded bg-[#e6e6e6] hover:bg-white text-[#141414] font-ui font-semibold text-[12px] transition-colors disabled:opacity-50"
                    >
                      {submitting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                      <span>Submeter Solução para Avaliação</span>
                    </button>
                  </div>
                </div>
              </section>

              {/* Grading Scorecard (Displayed after submission) */}
              {currentGrade && (
                <article className="rounded-lg border border-[#434343] bg-[#1c1c1c] p-6 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-4 mb-5 border-b border-[#434343]/60 pb-4">
                    <div className="flex items-center gap-3">
                      <div className="font-title text-3xl text-[#e6e6e6]">
                        {currentGrade.score}
                        <span className="text-lg text-[#8d8d8d] font-normal"> / {currentGrade.max_score || 10}</span>
                      </div>

                      {currentGrade.score >= 7 || (currentGrade as any).passed ? (
                        <span className="flex items-center gap-1.5 font-ui text-xs font-semibold px-2.5 py-1 rounded bg-[#34d399]/10 text-[#34d399] border border-[#34d399]/30">
                          <Check className="w-3.5 h-3.5" />
                          <span>APROVADO</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 font-ui text-xs font-semibold px-2.5 py-1 rounded bg-[#f87171]/10 text-[#f87171] border border-[#f87171]/30">
                          <AlertCircle className="w-3.5 h-3.5" />
                          <span>NECESSITA REVISÃO</span>
                        </span>
                      )}
                    </div>

                    {activeProblemIdx < activeSet.problems.length - 1 && (
                      <button
                        type="button"
                        onClick={() => setActiveProblemIdx((prev) => prev + 1)}
                        className="flex items-center gap-2 px-3 py-1.5 rounded border border-[#434343] bg-[#2a2a2a] hover:bg-[#333333] text-[#e6e6e6] font-ui text-xs transition-colors"
                      >
                        <span>Próximo Problema</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Rubric Criterion Breakdown Scores */}
                  {currentGrade.rubric_scores && Object.keys(currentGrade.rubric_scores).length > 0 && (
                    <div className="mb-5">
                      <h4 className="font-ui text-xs uppercase tracking-wider text-[#8d8d8d] mb-2.5">
                        Pontuação Detalhada por Critério da Rubrica
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {Object.entries(currentGrade.rubric_scores).map(([critId, score]) => (
                          <div
                            key={critId}
                            className="p-3 rounded border border-[#434343] bg-[#141414] flex flex-col justify-between"
                          >
                            <span className="font-ui text-[11px] text-[#8d8d8d] uppercase mb-1">
                              {critId}
                            </span>
                            <div className="flex items-center justify-between">
                              <span className="font-ui text-sm font-semibold text-[#e6e6e6]">
                                {score} pts
                              </span>
                              <div className="w-16 h-1.5 bg-[#2a2a2a] rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-[#e6e6e6]"
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
                    <h4 className="font-ui text-xs uppercase tracking-wider text-[#8d8d8d] mb-2">
                      Diagnóstico Pedagógico
                    </h4>
                    <div className="p-4 rounded border border-[#434343] bg-[#141414] font-prose text-[14px] text-[#e6e6e6] leading-relaxed">
                      <LessonProse
                        content={currentGrade.feedback || "Avaliação registrada."}
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
