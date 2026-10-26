"use client";

import React, { useCallback, use, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Award,
  Check,
  CheckCircle2,
  ChevronRight,
  Eye,
  HelpCircle,
  Loader2,
  PenTool,
  RotateCcw,
  Save,
  Send,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import {
  reviewDrawing,
  submitQuizAnswer,
} from "@/lib/api";
import type {
  CalibrationBand,
  CalibrationResult,
  DrawingReviewResult,
  QuizPayload,
  QuizSubmission,
} from "@/lib/types";
import {
  DrawingLoadedMeta,
  ExcalidrawCanvas,
  ExcalidrawCanvasHandle,
} from "@/components/excalidraw-canvas";

interface DrawPageProps {
  params: Promise<{ slug: string }>;
}

export default function DrawSlugPage({ params }: DrawPageProps) {
  // Unwrap Next.js 15 route params
  const resolvedParams = use(params);
  const slug = resolvedParams.slug;

  const canvasRef = useRef<ExcalidrawCanvasHandle>(null);

  // Drawing metadata loaded from canvas / Vault
  const [drawingTitle, setDrawingTitle] = useState<string>(slug);
  const [drawingPrompt, setDrawingPrompt] = useState<string>("");
  const [vaultFilePath, setVaultFilePath] = useState<string>(
    `Desenhos/${slug}.excalidraw.md`
  );

  // Header & Canvas action state
  const [isHeaderSaving, setIsHeaderSaving] = useState<boolean>(false);
  const [headerSaveSuccess, setHeaderSaveSuccess] = useState<boolean>(false);

  // Multimodal Review state
  const [isReviewing, setIsReviewing] = useState<boolean>(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewResult, setReviewResult] = useState<DrawingReviewResult | null>(
    null
  );
  const [isReviewDrawerOpen, setIsReviewDrawerOpen] = useState<boolean>(false);

  // Interactive Conceptual Quiz state inside Review Drawer
  const [quizSelectedOption, setQuizSelectedOption] = useState<number | null>(
    null
  );
  const [quizConfidence, setQuizConfidence] = useState<number>(75);
  const [quizThinking, setQuizThinking] = useState<string>("");
  const [isSubmittingQuiz, setIsSubmittingQuiz] = useState<boolean>(false);
  const [quizCalibration, setQuizCalibration] =
    useState<CalibrationResult | null>(null);

  const handleDrawingLoaded = useCallback((meta: DrawingLoadedMeta) => {
    if (meta.title) setDrawingTitle(meta.title);
    if (meta.prompt) setDrawingPrompt(meta.prompt);
    if (meta.filePath) setVaultFilePath(meta.filePath);
  }, []);

  /**
   * Save button click handler from Header
   */
  const handleHeaderSave = async () => {
    if (!canvasRef.current || isHeaderSaving) return;
    setIsHeaderSaving(true);
    setHeaderSaveSuccess(false);

    try {
      const success = await canvasRef.current.save();
      if (success) {
        setHeaderSaveSuccess(true);
        setTimeout(() => setHeaderSaveSuccess(false), 2500);
      }
    } finally {
      setIsHeaderSaving(false);
    }
  };

  /**
   * Review button click handler:
   * 1. First saves current canvas state and exports preview to Vault
   * 2. Calls reviewDrawing(slug)
   * 3. Opens Multimodal Diagnosis drawer
   */
  const handleReviewDrawing = async () => {
    if (isReviewing) return;
    setIsReviewing(true);
    setReviewError(null);
    setQuizSelectedOption(null);
    setQuizCalibration(null);
    setQuizThinking("");

    try {
      // 1. Flush canvas scene + PNG to Vault first
      if (canvasRef.current) {
        if (!await canvasRef.current.save()) throw new Error("Save the drawing successfully before requesting review.");
      }

      // 2. Call multimodal vision review backend endpoint
      const result = await reviewDrawing(slug);
      setReviewResult(result);
      setIsReviewDrawerOpen(true);
    } catch (err: any) {
      console.error("Multimodal review error:", err);
      const msg =
        err?.message ||
        "Não foi possível processar a revisão multimodal do desenho. Verifique a conexão com o backend.";
      setReviewError(msg);
      // Still open drawer to show error diagnostic
      setIsReviewDrawerOpen(true);
    } finally {
      setIsReviewing(false);
    }
  };

  /**
   * Helper to resolve the active quiz payload:
   * Either from reviewResult.conceptual_quiz OR synthesized from what_is_incorrect.
   */
  const activeQuiz = reviewResult?.conceptual_quiz ?? null;

  /**
   * Interactive Quiz submission inside Review Drawer
   */
  const handleSubmitQuiz = async () => {
    if (!activeQuiz || quizSelectedOption === null || isSubmittingQuiz) return;
    setIsSubmittingQuiz(true);

    const submission: QuizSubmission = {
      quiz_id: activeQuiz.id,
      chosen_index: quizSelectedOption,
      confidence: quizConfidence,
      learner_thinking: quizThinking,
    };

    try {
      const res = await submitQuizAnswer(activeQuiz.session_id, submission);
      setQuizCalibration(res);
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : "Quiz submission failed.");
    } finally {
      setIsSubmittingQuiz(false);
    }
  };

  const getCalibrationBadge = (band: CalibrationBand) => {
    switch (band) {
      case "calibrated":
        return {
          label: "✓ Calibrado (Correto + Alta Confiança)",
          classes:
            "bg-[#16221a] text-emerald-300 border-emerald-800/80",
        };
      case "illusion_of_competence":
        return {
          label: "⚠ Ilusão de Competência (Incorreto + Alta Confiança)",
          classes:
            "bg-[#251517] text-rose-300 border-rose-800/80",
        };
      case "fragile_intuition":
        return {
          label: "⚡ Intuição Frágil (Correto + Baixa Confiança)",
          classes:
            "bg-[#221c14] text-amber-300 border-amber-800/80",
        };
      case "conscious_gap":
        return {
          label: "🔍 Lacuna Consciente (Incorreto + Baixa Confiança)",
          classes:
            "bg-[#1a1a1a] text-neutral-300 border-[#434343]",
        };
    }
  };

  return (
    <div className="flex h-screen w-full flex-col bg-[#141414] text-[#e6e6e6] overflow-hidden">
      {/* =========================================================================
          1. HEADER BAR (#1c1c1c, border-b #434343)
          ========================================================================= */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#434343] bg-[#1c1c1c] px-4 py-2.5 z-20 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/"
            className="flex items-center justify-center h-8 w-8 rounded border border-[#434343] bg-[#141414] text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#2a2a2a] transition-colors shrink-0"
            title="Voltar para a página inicial"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>

          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-title font-bold text-lg md:text-xl text-[#e6e6e6] truncate">
                {drawingTitle}
              </h1>
              {/* Vault file path badge */}
              <span
                className="hidden sm:inline-flex font-ui text-[11px] text-[#8d8d8d] bg-[#141414] border border-[#434343] px-2 py-0.5 rounded shrink-0 select-all"
                title="Caminho do arquivo sincronizado no Vault Obsidian"
              >
                {vaultFilePath}
              </span>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          {/* Explicit Save button */}
          <button
            type="button"
            onClick={handleHeaderSave}
            disabled={isHeaderSaving}
            className="flex items-center gap-1.5 bg-[#141414] hover:bg-[#252525] border border-[#434343] text-[#e6e6e6] px-3 py-1.5 rounded font-ui text-xs transition-colors disabled:opacity-50"
            title="Salvar desenho e exportar PNG no Vault"
          >
            {isHeaderSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : headerSaveSuccess ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            <span>
              {isHeaderSaving
                ? "Salvando..."
                : headerSaveSuccess
                ? "Salvo no Vault"
                : "Salvar no Vault"}
            </span>
          </button>

          {/* Multimodal Review Button */}
          <button
            type="button"
            onClick={handleReviewDrawing}
            disabled={isReviewing}
            className="flex items-center gap-1.5 bg-[#2a2a2a] hover:bg-[#383838] border border-[#434343] text-[#ffffff] px-3.5 py-1.5 rounded font-ui text-xs font-semibold shadow-sm transition-colors disabled:opacity-50"
            title="Salva o canvas e executa o diagnóstico multimodal com IA"
          >
            {isReviewing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#e6e6e6]" />
                <span>Analisando com Visão...</span>
              </>
            ) : (
              <>
                <Eye className="h-3.5 w-3.5 text-[#e6e6e6]" />
                <span>👁 Revisar meu desenho</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* =========================================================================
          2. RETRIEVAL PROMPT BANNER
             ("Desenhe de memória..." without giving away answers!)
          ========================================================================= */}
      <div className="bg-[#171717] border-b border-[#434343] px-4 py-2 flex items-start justify-between gap-3 shrink-0">
        <div className="flex items-start gap-2.5 min-w-0">
          <div className="flex items-center justify-center h-5 w-5 rounded bg-[#252525] border border-[#434343] text-[#8d8d8d] shrink-0 mt-0.5">
            <PenTool className="h-3 w-3" />
          </div>
          <div className="text-xs font-prose leading-tight">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="font-ui text-[10px] uppercase tracking-wider text-[#8d8d8d] font-semibold">
                Retrieval Practice · Desenhe de memória
              </span>
              <span className="font-ui text-[10px] text-[#8d8d8d]">
                (Esforço ativo sem consultar anotações prévias)
              </span>
            </div>
            <p className="text-[#e6e6e6] font-medium">
              {drawingPrompt ||
                "Desenhe de memória a arquitetura, fluxo causal e conexões entre os conceitos. Não consulte referências antes de testar sua recuperação ativa!"}
            </p>
          </div>
        </div>

        {/* Quick Review Drawer Toggle (if a review result already exists) */}
        {reviewResult && !isReviewDrawerOpen && (
          <button
            type="button"
            onClick={() => setIsReviewDrawerOpen(true)}
            className="flex items-center gap-1 font-ui text-xs text-[#8d8d8d] hover:text-[#e6e6e6] border border-[#434343] bg-[#1c1c1c] px-2.5 py-1 rounded transition-colors shrink-0"
          >
            <Eye className="h-3 w-3" />
            <span>Ver Diagnóstico</span>
          </button>
        )}
      </div>

      {/* =========================================================================
          3. MAIN CANVAS AREA + SLIDE-OVER REVIEW DRAWER
          ========================================================================= */}
      <div className="relative flex-1 min-h-0 w-full overflow-hidden flex">
        {/* Excalidraw Canvas Embedded in Dark Mode #141414 */}
        <div className="flex-1 h-full w-full relative">
          <ExcalidrawCanvas
            ref={canvasRef}
            slug={slug}
            onDrawingLoaded={handleDrawingLoaded}
            showToolbarControls={true}
            autoSaveDebounceMs={2500}
            className="h-full w-full"
          />
        </div>

        {/* =========================================================================
            4. DIAGNÓSTICO MULTIMODAL DRAWER (#1c1c1c, border-l #434343)
            ========================================================================= */}
        {isReviewDrawerOpen && (
          <aside className="w-full max-w-lg md:max-w-xl lg:max-w-2xl bg-[#1c1c1c] border-l border-[#434343] h-full flex flex-col z-30 shadow-2xl animate-in slide-in-from-right duration-250">
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-[#434343] px-5 py-3.5 bg-[#171717] shrink-0">
              <div className="flex flex-col">
                <div className="flex items-center gap-2">
                  <h2 className="font-title font-bold text-lg text-[#e6e6e6]">
                    Diagnóstico Multimodal
                  </h2>
                  <span className="font-ui text-[10px] uppercase tracking-wider bg-[#2a2a2a] border border-[#434343] text-[#8d8d8d] px-2 py-0.5 rounded">
                    Visão Multimodal
                  </span>
                </div>
                <p className="font-ui text-xs text-[#8d8d8d] mt-0.5">
                  Análise estruturada do diagrama em relação à verdade incondicional
                </p>
              </div>

              <button
                type="button"
                onClick={() => setIsReviewDrawerOpen(false)}
                className="flex items-center justify-center h-7 w-7 rounded text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#2a2a2a] transition-colors"
                title="Fechar painel de revisão"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Drawer Content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {reviewError && (
                <div className="flex items-start gap-3 bg-[#251517] border border-rose-800/80 text-rose-300 p-4 rounded text-xs font-ui">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-semibold mb-1">Falha na análise</p>
                    <p className="text-rose-200/90">{reviewError}</p>
                    <button
                      type="button"
                      onClick={handleReviewDrawing}
                      className="mt-2 flex items-center gap-1.5 bg-[#2a2a2a] hover:bg-[#383838] border border-[#434343] text-[#e6e6e6] px-2.5 py-1 rounded text-xs transition-colors"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Tentar novamente
                    </button>
                  </div>
                </div>
              )}

              {reviewResult && (
                <>
                  {/* Summary Callout */}
                  {reviewResult.summary && (
                    <div className="bg-[#141414] border border-[#434343] rounded p-3.5 font-prose text-sm text-[#e6e6e6] leading-relaxed">
                      <p>{reviewResult.summary}</p>
                    </div>
                  )}

                  {/* 1. O que está correto */}
                  <section className="bg-[#141414] border border-[#434343] rounded overflow-hidden">
                    <div className="bg-[#16221a] border-b border-emerald-900/50 px-4 py-2.5 flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                      <h3 className="font-title font-semibold text-sm text-emerald-300">
                        ✓ O que está correto
                      </h3>
                    </div>
                    <div className="p-4">
                      {reviewResult.what_is_correct &&
                      reviewResult.what_is_correct.length > 0 ? (
                        <ul className="space-y-2 font-prose text-sm text-[#e6e6e6]">
                          {reviewResult.what_is_correct.map((item, idx) => (
                            <li key={idx} className="flex items-start gap-2">
                              <span className="text-emerald-400 shrink-0 mt-0.5">
                                •
                              </span>
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="font-ui text-xs text-[#8d8d8d] italic">
                          Nenhum componente fundamental correto foi detectado nesta tentativa.
                        </p>
                      )}
                    </div>
                  </section>

                  {/* 2. O que faltou */}
                  <section className="bg-[#141414] border border-[#434343] rounded overflow-hidden">
                    <div className="bg-[#221c14] border-b border-amber-900/50 px-4 py-2.5 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                      <h3 className="font-title font-semibold text-sm text-amber-300">
                        △ O que faltou
                      </h3>
                    </div>
                    <div className="p-4">
                      {reviewResult.what_was_missed &&
                      reviewResult.what_was_missed.length > 0 ? (
                        <ul className="space-y-2 font-prose text-sm text-[#e6e6e6]">
                          {reviewResult.what_was_missed.map((item, idx) => (
                            <li key={idx} className="flex items-start gap-2">
                              <span className="text-amber-400 shrink-0 mt-0.5">
                                •
                              </span>
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="font-ui text-xs text-[#8d8d8d] italic">
                          Nenhum passo estrutural crítico foi omitido no diagrama.
                        </p>
                      )}
                    </div>
                  </section>

                  {/* 3. O que está incorreto */}
                  <section className="bg-[#141414] border border-[#434343] rounded overflow-hidden">
                    <div className="bg-[#251517] border-b border-rose-900/50 px-4 py-2.5 flex items-center gap-2">
                      <XCircle className="h-4 w-4 text-rose-400 shrink-0" />
                      <h3 className="font-title font-semibold text-sm text-rose-300">
                        ✕ O que está incorreto
                      </h3>
                    </div>
                    <div className="p-4">
                      {reviewResult.what_is_incorrect &&
                      reviewResult.what_is_incorrect.length > 0 ? (
                        <ul className="space-y-2 font-prose text-sm text-[#e6e6e6]">
                          {reviewResult.what_is_incorrect.map((item, idx) => (
                            <li key={idx} className="flex items-start gap-2">
                              <span className="text-rose-400 shrink-0 mt-0.5">
                                •
                              </span>
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="font-ui text-xs text-emerald-400/90 italic">
                          Nenhum erro conceitual ou direção causal incorreta foi detectada!
                        </p>
                      )}
                    </div>
                  </section>

                  {/* =========================================================================
                      INTERACTIVE CONCEPTUAL QUIZ CARD INSIDE REVIEW DRAWER
                      Resolves misconception immediately if present
                      ========================================================================= */}
                  {activeQuiz && (
                    <section className="bg-[#141414] border border-[#434343] rounded p-4 space-y-4">
                      <div className="flex items-center justify-between border-b border-[#434343] pb-2">
                        <div className="flex items-center gap-2">
                          <Sparkles className="h-4 w-4 text-amber-400" />
                          <h4 className="font-title font-semibold text-sm text-[#e6e6e6]">
                            Calibração Conceitual Imediata
                          </h4>
                        </div>
                        <span className="font-ui text-[10px] text-[#8d8d8d] uppercase">
                          Desafio de Correção
                        </span>
                      </div>

                      {/* Question */}
                      <p className="font-prose text-sm font-medium text-[#e6e6e6] leading-relaxed">
                        {activeQuiz.question}
                      </p>

                      {/* Multiple Choice Options */}
                      <div className="space-y-2">
                        {activeQuiz.options.map((opt) => {
                          const isSelected = quizSelectedOption === opt.index;
                          const showCorrect =
                            quizCalibration && opt.index === 0;
                          const showWrong =
                            quizCalibration &&
                            quizSelectedOption === opt.index &&
                            opt.index !== 0;

                          return (
                            <button
                              key={opt.index}
                              type="button"
                              disabled={Boolean(quizCalibration)}
                              onClick={() => setQuizSelectedOption(opt.index)}
                              className={`w-full text-left p-3 rounded border font-prose text-sm transition-all flex items-start gap-3 ${
                                showCorrect
                                  ? "bg-[#16221a] border-emerald-700/80 text-emerald-300"
                                  : showWrong
                                  ? "bg-[#251517] border-rose-700/80 text-rose-300"
                                  : isSelected
                                  ? "bg-[#2a2a2a] border-[#e6e6e6] text-[#ffffff]"
                                  : "bg-[#1c1c1c] border-[#434343] text-[#e6e6e6] hover:bg-[#252525]"
                              }`}
                            >
                              <span
                                className={`flex items-center justify-center h-5 w-5 rounded font-ui text-xs font-semibold shrink-0 ${
                                  isSelected
                                    ? "bg-[#e6e6e6] text-[#141414]"
                                    : "bg-[#2a2a2a] text-[#8d8d8d]"
                                }`}
                              >
                                {opt.label || String.fromCharCode(65 + opt.index)}
                              </span>
                              <span className="leading-snug">{opt.text}</span>
                            </button>
                          );
                        })}
                      </div>

                      {/* Confidence Rating & Submission Controls (before calibration) */}
                      {!quizCalibration ? (
                        <div className="pt-2 border-t border-[#434343] space-y-3">
                          <div>
                            <div className="flex items-center justify-between font-ui text-xs text-[#8d8d8d] mb-1.5">
                              <span>Sua convicção nesta resposta:</span>
                              <span className="font-semibold text-[#e6e6e6]">
                                {quizConfidence}%
                              </span>
                            </div>
                            <div className="grid grid-cols-4 gap-1.5">
                              {[
                                { val: 25, label: "25% (Chute)" },
                                { val: 50, label: "50% (Dúvida)" },
                                { val: 75, label: "75% (Provável)" },
                                { val: 100, label: "100% (Certeza)" },
                              ].map((lvl) => (
                                <button
                                  key={lvl.val}
                                  type="button"
                                  onClick={() => setQuizConfidence(lvl.val)}
                                  className={`py-1 text-center font-ui text-[10px] rounded border transition-colors ${
                                    quizConfidence === lvl.val
                                      ? "bg-[#2a2a2a] border-[#e6e6e6] text-[#ffffff]"
                                      : "bg-[#1c1c1c] border-[#434343] text-[#8d8d8d] hover:text-[#e6e6e6]"
                                  }`}
                                >
                                  {lvl.label}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Optional reasoning */}
                          <div>
                            <input
                              type="text"
                              value={quizThinking}
                              onChange={(e) => setQuizThinking(e.target.value)}
                              placeholder="Justifique seu raciocínio (opcional)..."
                              className="w-full bg-[#1c1c1c] border border-[#434343] rounded px-3 py-1.5 font-ui text-xs text-[#e6e6e6] placeholder:text-[#8d8d8d] focus:border-[#e6e6e6]"
                            />
                          </div>

                          {/* Submit Quiz Button */}
                          <button
                            type="button"
                            onClick={handleSubmitQuiz}
                            disabled={
                              quizSelectedOption === null || isSubmittingQuiz
                            }
                            className="w-full flex items-center justify-center gap-1.5 bg-[#2a2a2a] hover:bg-[#383838] border border-[#434343] text-[#ffffff] py-2 rounded font-ui text-xs font-semibold transition-colors disabled:opacity-40"
                          >
                            {isSubmittingQuiz ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="h-3.5 w-3.5" />
                            )}
                            <span>Submeter Calibração ↵</span>
                          </button>
                        </div>
                      ) : (
                        /* Calibration Result Feedback Card */
                        <div className="pt-2 border-t border-[#434343] space-y-3">
                          {(() => {
                            const badge = getCalibrationBadge(
                              quizCalibration.band
                            );
                            return (
                              <div
                                className={`border p-3 rounded space-y-2 ${badge.classes}`}
                              >
                                <div className="flex items-center justify-between font-ui text-xs font-semibold">
                                  <span>{badge.label}</span>
                                  <span>Confiança: {quizCalibration.confidence}%</span>
                                </div>
                                <p className="font-prose text-xs leading-relaxed text-[#e6e6e6]">
                                  {quizCalibration.feedback_prose}
                                </p>
                              </div>
                            );
                          })()}

                          {/* Action button to continue drawing */}
                          <button
                            type="button"
                            onClick={() => setIsReviewDrawerOpen(false)}
                            className="w-full flex items-center justify-center gap-1.5 bg-[#2a2a2a] hover:bg-[#383838] border border-[#434343] text-[#e6e6e6] py-2 rounded font-ui text-xs transition-colors"
                          >
                            <PenTool className="h-3.5 w-3.5" />
                            <span>Continuar Desenhando & Ajustar no Canvas</span>
                          </button>
                        </div>
                      )}
                    </section>
                  )}
                </>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
