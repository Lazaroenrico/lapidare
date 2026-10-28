"use client";

import { useLocale } from "@/components/locale-provider";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Target, X } from "lucide-react";
import type { EffortLevel, ModelSlotConfig, SessionMode, TrackConfig } from "@/lib/types";
import { createChat } from "@/lib/api";
import { findActiveTrack } from "@/lib/tracks";
import { TrackChip, type TrackStep } from "./track-chip";
import { useTracks } from "./use-tracks";
import { differsFromSlot, modelChoicePayload, pinnedEffort, type ModelChoice } from "@/lib/model-choice";
import { graphContextPayload, MAX_GRAPH_CONTEXT } from "@/lib/graph-selection";
import { appendDictation, useDictation } from "./use-dictation";
import { MicButton } from "./mic-button";
import { dictationText } from "@/lib/dictation-i18n";
import { ModelPicker } from "./model-picker";
import { ComposerControls, ComposerField, ComposerSendButton, EffortMenu, ModeToggle } from "./composer-parts";
import { useShortcut } from "./use-shortcut";
import { useCycleEffort } from "./use-cycle-effort";
import { useComposerFocusRequest } from "./composer-focus";

export interface SelectedNodeRef {
  id: string;
  name: string;
}

export interface ComposerProps {
  initialized: boolean;
  trackConfig?: TrackConfig;
  /** `config.slots.strong`: default model/effort and the engine whose models are listed. */
  strongSlot?: ModelSlotConfig;
  /** Nodes selected on the graph (Shift/⌘-click, "Selecionar", Chains checkboxes). */
  selectedNodes?: SelectedNodeRef[];
  onClearSelection?: () => void;
  onOpenSetup?: (pendingText?: string) => void;
  onSubmit?: (text: string, mode: SessionMode) => Promise<void> | void;
  initialTopic?: string;
  className?: string;
}

const slotChoice = (slot?: ModelSlotConfig): ModelChoice => ({
  model: slot?.model?.trim() || "auto",
  effort: (slot?.effort as EffortLevel | undefined) ?? "medium",
});

const joinNames = (nodes: SelectedNodeRef[], max = 4) =>
  nodes.length <= max ? nodes.map((n) => n.name).join(", ") : `${nodes.slice(0, max).map((n) => n.name).join(", ")} +${nodes.length - max}`;

export function Composer({
  initialized,
  trackConfig,
  strongSlot,
  selectedNodes = [],
  onClearSelection,
  onOpenSetup,
  onSubmit,
  initialTopic = "",
  className = "",
}: ComposerProps) {
  const router = useRouter();
  const { locale, t } = useLocale();
  const [mode, setMode] = useState<SessionMode>("TEACH");
  const [text, setText] = useState<string>(initialTopic);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useComposerFocusRequest(textareaRef);
  const dictation = useDictation(locale);
  const dt = dictationText(locale);
  dictation.setSink((spoken) => setText((prev) => appendDictation(prev, spoken)));

  // Model choice: follows the strong slot until the learner picks something else.
  const [choice, setChoice] = useState<ModelChoice>(() => slotChoice(strongSlot));
  const [choiceTouched, setChoiceTouched] = useState(false);
  useEffect(() => {
    if (!choiceTouched) setChoice(slotChoice(strongSlot));
  }, [strongSlot, choiceTouched]);
  const modelFields = choiceTouched && differsFromSlot(choice, strongSlot) ? modelChoicePayload(choice) : {};

  useEffect(() => {
    if (initialTopic) setText(initialTopic);
  }, [initialTopic]);

  // Fase 14: several tracks, one in focus. `trackConfig` (old shape = active track)
  // only supplies `source_path` and the fallback when GET /api/tracks is unavailable.
  const tracksState = useTracks();
  const activeTrack = findActiveTrack(tracksState.tracks);
  const legacyMode = tracksState.tracks.length === 0 && tracksState.error !== null;
  const nextTrackStep = useMemo<TrackStep | null>(() => {
    const items = trackConfig?.items ?? [];
    if (activeTrack) {
      const next = activeTrack.next_item;
      if (!next) return null;
      const legacy = items.find((it) => it.id === next.id);
      return { id: next.id, title: next.title, trackId: activeTrack.id, sourcePath: legacy?.source_path };
    }
    if (!legacyMode || !trackConfig?.active || items.length === 0) return null;
    const current = trackConfig.current_step_id ? items.find((it) => it.id === trackConfig.current_step_id) : undefined;
    const step = current && !current.completed ? current : items.find((it) => !it.completed);
    return step ? { id: step.id, title: step.title, trackId: null, sourcePath: step.source_path } : null;
  }, [activeTrack, legacyMode, trackConfig]);

  const startSession = async (payload: Parameters<typeof createChat>[0], clearText: boolean) => {
    try {
      setSubmitting(true);
      const session = await createChat({ ...payload, ...modelFields });
      if (clearText) setText("");
      router.push(`/chat/${session.id}`);
    } catch (err) {
      console.error("[Composer] Failed to create session:", err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    // INVARIANT: if not initialized, preserve the text and open Setup.
    if (!initialized) {
      onOpenSetup?.(trimmed);
      return;
    }
    if (onSubmit) {
      await onSubmit(trimmed, mode);
      setText("");
      return;
    }
    await startSession(
      { mode, topic: trimmed, ...(selectedNodes.length > 0 ? { graph_context: graphContextPayload(selectedNodes.map((n) => n.id)) } : {}) },
      true,
    );
  };

  /** "Ensinar a partir daqui" / "Praticar estes": the selection goes as graph_context. */
  const handleSelectionAction = async (actionMode: SessionMode) => {
    if (selectedNodes.length === 0 || submitting) return;
    const names = joinNames(selectedNodes);
    const typed = text.trim();
    const topic = typed || (actionMode === "TEACH" ? t.selectionTeachTopic(names) : t.selectionPracticeTopic(names));
    if (!initialized) {
      onOpenSetup?.(topic);
      return;
    }
    await startSession(
      { mode: actionMode, topic, graph_context: graphContextPayload(selectedNodes.map((n) => n.id)) },
      Boolean(typed),
    );
    onClearSelection?.();
  };

  const handleContinueTrack = async () => {
    if (!nextTrackStep) return;
    if (!initialized) {
      onOpenSetup?.(nextTrackStep.title);
      return;
    }
    await startSession(
      {
        mode: "TEACH",
        topic: nextTrackStep.title,
        track_item_id: nextTrackStep.id,
        ...(nextTrackStep.trackId ? { track_id: nextTrackStep.trackId } : {}),
        ...(nextTrackStep.sourcePath ? { source_file: nextTrackStep.sourcePath } : {}),
      },
      false,
    );
  };

  // Global shortcut (`continueTrack`, Ctrl/⌘+Enter by default, rebindable in Settings):
  // with an empty composer it triggers "Continuar ↵".
  useShortcut("continueTrack", () => {
    if (text.trim() || !nextTrackStep || submitting) return false;
    const active = document.activeElement as HTMLElement | null;
    const typingElsewhere =
      active &&
      active !== textareaRef.current &&
      (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName));
    if (typingElsewhere) return false;
    void handleContinueTrack();
  });

  // Shift+Tab: cycle the effort of the local choice (not persisted in the slot).
  const effortAnnouncement = useCycleEffort({
    engine: strongSlot?.engine ?? "agy",
    value: choice,
    disabled: submitting,
    apply: (next) => {
      setChoiceTouched(true);
      setChoice(next);
    },
  });

  // Enter submits (Shift+Enter = new line). Ctrl/⌘+Enter on empty text bubbles to the track shortcut.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !text.trim()) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const placeholderText = mode === "TEACH" ? t.composerPlaceholder : t.practicePrompt;
  const pill =
    "flex items-center gap-1 bg-accent hover:bg-border px-2 py-0.5 rounded-full text-[11px] text-foreground border border-border cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed";

  return (
    <div className={`w-full max-w-[860px] mx-auto flex flex-col items-center gap-2 z-20 ${className}`}>
      {/* Node selection chip */}
      {selectedNodes.length > 0 && (
        <div className="w-full flex justify-center">
          <div className="flex flex-wrap items-center justify-center gap-2 bg-card/95 backdrop-blur border border-success/40 rounded-full px-3.5 py-1.5 shadow-lg text-xs font-ui text-muted-foreground">
            <span className="text-foreground" title={selectedNodes.map((n) => n.name).join(", ")}>
              {t.selectionCount(selectedNodes.length)}
            </span>
            {selectedNodes.length > MAX_GRAPH_CONTEXT && (
              <span className="text-[10.5px] text-warning">{t.selectionCapped(MAX_GRAPH_CONTEXT)}</span>
            )}
            <span>·</span>
            <button type="button" disabled={submitting} onClick={() => void handleSelectionAction("TEACH")} className={pill}>
              <BookOpen className="w-3 h-3 text-success" />
              {t.selectionTeach}
            </button>
            <button type="button" disabled={submitting} onClick={() => void handleSelectionAction("PRACTICE")} className={pill}>
              <Target className="w-3 h-3 text-warning" />
              {t.selectionPractice}
            </button>
            <button type="button" onClick={onClearSelection} className={pill}>
              <X className="w-3 h-3" />
              {t.selectionClear}
            </button>
          </div>
        </div>
      )}

      {/* INVARIANT: contextual track chip directly above the composer (hidden without tracks) */}
      <TrackChip
        tracks={tracksState.tracks}
        legacyStep={legacyMode ? nextTrackStep : null}
        nextStep={nextTrackStep}
        busy={submitting}
        onContinue={() => void handleContinueTrack()}
      />

      {/* Large rounded input with the send button inside its right edge */}
      <ComposerField
        textareaRef={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholderText}
        aria-label={placeholderText}
        title={nextTrackStep ? t.composerHintTrack : t.composerHint}
        action={
          <ComposerSendButton
            onClick={() => void handleSubmit()}
            disabled={!text.trim() || submitting}
            busy={submitting}
            label={t.send}
          />
        }
      />

      {/* Controls below the input: mode · dictation (flexes) · model · effort */}
      <ComposerControls
        mode={<ModeToggle mode={mode} onChange={setMode} />}
        mic={
          dictation.supported ? (
            <MicButton
              variant="pill"
              configured
              state={dictation.state}
              level={dictation.level}
              onToggle={dictation.toggle}
              label={dt.start}
              stopLabel={dt.stop}
              text={dictation.state === "listening" ? dt.stop : dt.bar}
            />
          ) : null
        }
        model={
          <>
            <ModelPicker
              pill
              engine={strongSlot?.engine ?? "agy"}
              value={choice}
              defaultModel={strongSlot?.model}
              placement="up"
              disabled={submitting}
              className="shrink-0"
              onChange={(next) => {
                setChoiceTouched(true);
                setChoice(next);
              }}
            />
            <span className="sr-only" aria-live="polite">{effortAnnouncement}</span>
            <EffortMenu
              value={choice.effort}
              pinned={pinnedEffort(choice.model)}
              disabled={submitting}
              onChange={(effort) => {
                setChoiceTouched(true);
                setChoice((c) => ({ ...c, effort }));
              }}
            />
          </>
        }
      />
    </div>
  );
}
