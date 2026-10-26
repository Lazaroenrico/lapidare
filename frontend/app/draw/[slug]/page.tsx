"use client";

import React, { useCallback, use, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  Eye,
  Loader2,
  PenTool,
  RotateCcw,
  Save,
  X,
  XCircle,
} from "lucide-react";
import { reviewDrawing } from "@/lib/api";
import type { DrawingReviewResult } from "@/lib/types";
import {
  DrawingLoadedMeta,
  ExcalidrawCanvas,
  ExcalidrawCanvasHandle,
} from "@/components/excalidraw-canvas";
import { LessonProse } from "@/components/lesson-prose";
import { QuestionDock } from "@/components/question-dock";
import { palette } from "@/lib/palette";
import { useLocale } from "@/components/locale-provider";

interface DrawPageProps {
  params: Promise<{ slug: string }>;
}

export default function DrawSlugPage({ params }: DrawPageProps) {
  const { t } = useLocale();
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
  // Calibration of the follow-up quiz (answered through the session pipeline)
  const [quizAnswered, setQuizAnswered] = useState<boolean>(false);

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
   * 1. Saves the canvas and exports the PNG to the Vault (the review reads that PNG)
   * 2. Calls reviewDrawing(slug): the strong engine reviews the image + linked notes
   * 3. Opens the diagnosis drawer; a follow-up quiz (if any) opens in the QuestionDock
   */
  const handleReviewDrawing = async () => {
    if (isReviewing) return;
    setIsReviewing(true);
    setReviewError(null);
    setQuizAnswered(false);

    try {
      if (canvasRef.current) {
        if (!(await canvasRef.current.save())) {
          throw new Error(t.drawSaveBeforeReview);
        }
      }
      const result = await reviewDrawing(slug);
      setReviewResult(result);
      setIsReviewDrawerOpen(true);
    } catch (err) {
      setReviewError(
        err instanceof Error && err.message
          ? err.message
          : t.drawReviewFailed
      );
      setIsReviewDrawerOpen(true);
    } finally {
      setIsReviewing(false);
    }
  };

  const pendingQuiz = reviewResult?.pending_quiz ?? null;
  const reviewSessionId = reviewResult?.session_id ?? null;

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground overflow-hidden">
      {/* =========================================================================
          1. HEADER BAR (bg-card, border-b border-border)
          ========================================================================= */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-2.5 z-20 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/"
            className="flex items-center justify-center h-8 w-8 rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
            title={t.drawBackHomeTitle}
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>

          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-title font-bold text-lg md:text-xl text-foreground truncate">
                {drawingTitle}
              </h1>
              {/* Vault file path badge */}
              <span
                className="hidden sm:inline-flex font-ui text-[11px] text-muted-foreground bg-background border border-border px-2 py-0.5 rounded shrink-0 select-all"
                title={t.drawVaultPathTitle}
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
            className="flex items-center gap-1.5 bg-background hover:bg-accent border border-border text-foreground px-3 py-1.5 rounded font-ui text-xs transition-colors disabled:opacity-50"
            title={t.drawSaveTitle}
          >
            {isHeaderSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : headerSaveSuccess ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            <span>
              {isHeaderSaving
                ? t.saving
                : headerSaveSuccess
                ? t.drawSavedToVault
                : t.saveToVault}
            </span>
          </button>

          {/* Multimodal Review Button */}
          <button
            type="button"
            onClick={handleReviewDrawing}
            disabled={isReviewing}
            className="flex items-center gap-1.5 bg-accent hover:bg-border border border-border text-foreground px-3.5 py-1.5 rounded font-ui text-xs font-semibold shadow-sm transition-colors disabled:opacity-50"
            title={t.drawReviewTitle}
          >
            {isReviewing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground" />
                <span>{t.drawReviewing}</span>
              </>
            ) : (
              <>
                <Eye className="h-3.5 w-3.5 text-foreground" />
                <span>{t.drawReviewButton}</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* =========================================================================
          2. RETRIEVAL PROMPT BANNER
             ("Desenhe de memória..." without giving away answers!)
          ========================================================================= */}
      <div className="bg-background border-b border-border px-4 py-2 flex items-start justify-between gap-3 shrink-0">
        <div className="flex items-start gap-2.5 min-w-0">
          <div className="flex items-center justify-center h-5 w-5 rounded bg-accent border border-border text-muted-foreground shrink-0 mt-0.5">
            <PenTool className="h-3 w-3" />
          </div>
          <div className="text-xs font-prose leading-tight">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="font-ui text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                {t.drawBannerLabel}
              </span>
              <span className="font-ui text-[10px] text-muted-foreground">
                {t.drawBannerHint}
              </span>
            </div>
            <p className="text-foreground font-medium">
              {drawingPrompt ||
                t.drawDefaultPrompt}
            </p>
          </div>
        </div>

        {/* Quick Review Drawer Toggle (if a review result already exists) */}
        {reviewResult && !isReviewDrawerOpen && (
          <button
            type="button"
            onClick={() => setIsReviewDrawerOpen(true)}
            className="flex items-center gap-1 font-ui text-xs text-muted-foreground hover:text-foreground border border-border bg-card px-2.5 py-1 rounded transition-colors shrink-0"
          >
            <Eye className="h-3 w-3" />
            <span>{t.drawShowDiagnosis}</span>
          </button>
        )}
      </div>

      {/* =========================================================================
          3. MAIN CANVAS AREA + SLIDE-OVER REVIEW DRAWER
          ========================================================================= */}
      <div className="relative flex-1 min-h-0 w-full overflow-hidden flex">
        {/* Excalidraw Canvas Embedded in Dark Mode (bg-background) */}
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
            4. DIAGNÓSTICO MULTIMODAL DRAWER (bg-card, border-l border-border)
            ========================================================================= */}
        {isReviewDrawerOpen && (
          <aside className="w-full max-w-lg md:max-w-xl lg:max-w-2xl bg-card border-l border-border h-full flex flex-col z-30 shadow-2xl animate-in slide-in-from-right duration-250">
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5 bg-background shrink-0">
              <div className="flex flex-col">
                <div className="flex items-center gap-2">
                  <h2 className="font-title font-bold text-lg text-foreground">
                    {t.drawDiagnosisTitle}
                  </h2>
                  <span className="font-ui text-[10px] uppercase tracking-wider bg-accent border border-border text-muted-foreground px-2 py-0.5 rounded">
                    {t.drawVisionBadge}
                  </span>
                </div>
                <p className="font-ui text-xs text-muted-foreground mt-0.5">
                  {t.drawDiagnosisHint}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setIsReviewDrawerOpen(false)}
                className="flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title={t.drawCloseReviewTitle}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Drawer Content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {reviewError && (
                <div
                  role="alert"
                  className="flex items-start gap-3 bg-background border border-danger/60 text-danger p-4 rounded font-ui text-[12.5px]"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold mb-1">{t.drawVisionFailed}</p>
                    <p className="text-foreground break-words">{reviewError}</p>
                    <button
                      type="button"
                      onClick={handleReviewDrawing}
                      disabled={isReviewing}
                      className="mt-2 flex items-center gap-1.5 bg-accent hover:bg-border border border-border text-foreground px-2.5 py-1 rounded text-xs transition-colors disabled:opacity-50"
                    >
                      <RotateCcw className="h-3 w-3" />
                      {t.tryAgain}
                    </button>
                  </div>
                </div>
              )}

              {reviewResult && (
                <>
                  {reviewResult.summary_markdown && (
                    <div className="bg-background border border-border rounded p-4">
                      <LessonProse content={reviewResult.summary_markdown} />
                    </div>
                  )}

                  <ReviewSection
                    title={t.drawCorrectTitle}
                    accent={palette.success}
                    icon={<CheckCircle2 className="h-4 w-4 shrink-0" />}
                    items={reviewResult.correct_points}
                    empty={t.drawCorrectEmpty}
                  />
                  <ReviewSection
                    title={t.drawMissingTitle}
                    accent={palette.warning}
                    icon={<AlertTriangle className="h-4 w-4 shrink-0" />}
                    items={reviewResult.missing_points}
                    empty={t.drawMissingEmpty}
                  />
                  <ReviewSection
                    title={t.drawIncorrectTitle}
                    accent={palette.danger}
                    icon={<XCircle className="h-4 w-4 shrink-0" />}
                    items={reviewResult.incorrect_points}
                    empty={t.drawIncorrectEmpty}
                  />

                  {/* Follow-up quiz: the real QuestionDock, answered through the session pipeline */}
                  {pendingQuiz && reviewSessionId && (
                    <section className="space-y-3">
                      <QuestionDock
                        key={pendingQuiz.quiz_id}
                        quiz={pendingQuiz}
                        sessionId={reviewSessionId}
                        onAnswerSubmitted={() => setQuizAnswered(true)}
                      />
                      {quizAnswered && (
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/chat/${encodeURIComponent(reviewSessionId)}`}
                            className="flex items-center gap-1.5 bg-accent hover:bg-border border border-border text-foreground px-3 py-1.5 rounded font-ui text-xs transition-colors"
                          >
                            <span>{t.drawContinueSession}</span>
                            <ChevronRight className="h-3.5 w-3.5" />
                          </Link>
                          <button
                            type="button"
                            onClick={() => setIsReviewDrawerOpen(false)}
                            className="flex items-center gap-1.5 bg-background hover:bg-accent border border-border text-muted-foreground hover:text-foreground px-3 py-1.5 rounded font-ui text-xs transition-colors"
                          >
                            <PenTool className="h-3.5 w-3.5" />
                            <span>{t.drawAdjust}</span>
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

function ReviewSection({
  title,
  accent,
  icon,
  items,
  empty,
}: {
  title: string;
  accent: string;
  icon: React.ReactNode;
  items: string[];
  empty: string;
}) {
  return (
    <section
      className="bg-background border border-border rounded overflow-hidden"
      style={{ borderLeftColor: accent, borderLeftWidth: 2 }}
    >
      <div
        className="bg-card border-b border-border px-4 py-2 flex items-center gap-2"
        style={{ color: accent }}
      >
        {icon}
        <h3 className="font-title font-semibold text-sm">{title}</h3>
      </div>
      <div className="p-4">
        {items.length > 0 ? (
          <ul className="space-y-2 font-prose text-[16px] leading-[1.5] text-foreground">
            {items.map((item, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="shrink-0" style={{ color: accent }}>
                  •
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="font-ui text-xs text-muted-foreground italic">{empty}</p>
        )}
      </div>
    </section>
  );
}
