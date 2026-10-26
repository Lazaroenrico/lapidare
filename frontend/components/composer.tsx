"use client";

import { useLocale } from "@/components/locale-provider";
import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  Loader2,
  Mic,
  MicOff,
  Route,
  Send,
  Target,
} from "lucide-react";
import type { SessionMode, TrackConfig, TrackItem } from "@/lib/types";
import { createChat } from "@/lib/api";

interface IWindow extends Window {
  webkitSpeechRecognition?: any;
  SpeechRecognition?: any;
}

export interface ComposerProps {
  initialized: boolean;
  trackConfig?: TrackConfig;
  onOpenSetup?: (pendingText?: string) => void;
  onSubmit?: (text: string, mode: SessionMode) => Promise<void> | void;
  initialTopic?: string;
  className?: string;
}

export function Composer({
  initialized,
  trackConfig,
  onOpenSetup,
  onSubmit,
  initialTopic = "",
  className = "",
}: ComposerProps) {
  const router = useRouter();
  const [mode, setMode] = useState<SessionMode>("TEACH");
  const {locale, t} = useLocale();
  const [text, setText] = useState<string>(initialTopic);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [speechSupported, setSpeechSupported] = useState<boolean>(false);
  const recognitionRef = useRef<any>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Sync initial topic
  useEffect(() => {
    if (initialTopic) {
      setText(initialTopic);
    }
  }, [initialTopic]);

  // Determine active track next item
  const nextTrackStep = React.useMemo<TrackItem | null>(() => {
    if (!trackConfig?.active || !trackConfig.items || trackConfig.items.length === 0) {
      return null;
    }
    if (trackConfig.current_step_id) {
      const current = trackConfig.items.find(
        (it) => it.id === trackConfig.current_step_id
      );
      if (current && !current.completed) return current;
    }
    const firstUnfinished = trackConfig.items.find((it) => !it.completed);
    return firstUnfinished || null;
  }, [trackConfig]);

  // Speech Recognition Setup
  useEffect(() => {
    if (typeof window === "undefined") return;

    const win = window as unknown as IWindow;
    const SpeechRecognition =
      win.SpeechRecognition || win.webkitSpeechRecognition;

    if (SpeechRecognition) {
      setSpeechSupported(true);
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = locale === "en" ? "en-US" : "pt-BR";

      recognition.onresult = (event: any) => {
        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          transcript += event.results[i][0].transcript;
        }
        if (transcript.trim()) {
          setText((prev) => (prev ? `${prev} ${transcript}` : transcript));
        }
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }
  }, []);

  const toggleListening = () => {
    if (!recognitionRef.current) return;
    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      try {
        recognitionRef.current.start();
        setIsListening(true);
      } catch {
        setIsListening(false);
      }
    }
  };

  // Submit Handler
  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || submitting) return;

    // INVARIANT: If not initialized, intercept, preserve text and open SetupDialog
    if (!initialized) {
      if (onOpenSetup) {
        onOpenSetup(trimmed);
      }
      return;
    }

    if (onSubmit) {
      await onSubmit(trimmed, mode);
      setText("");
      return;
    }

    // Default submission creates chat and routes
    try {
      setSubmitting(true);
      const session = await createChat({
        mode,
        topic: trimmed,
      });
      setText("");
      router.push(`/chat/${session.id}`);
    } catch (err) {
      console.error("[Composer] Failed to create session:", err);
    } finally {
      setSubmitting(false);
    }
  };

  // Track Step Click Handler
  const handleContinueTrack = async () => {
    if (!nextTrackStep) return;

    if (!initialized) {
      if (onOpenSetup) onOpenSetup(nextTrackStep.title);
      return;
    }

    try {
      setSubmitting(true);
      const session = await createChat({
        mode: "TEACH",
        topic: nextTrackStep.title,
        track_item_id: nextTrackStep.id,
        source_file: nextTrackStep.source_path,
      });
      router.push(`/chat/${session.id}`);
    } catch (err) {
      console.error("[Composer] Failed to start track step session:", err);
    } finally {
      setSubmitting(false);
    }
  };

  // Global shortcut: Ctrl/⌘+Enter with an empty composer triggers "Continuar ↵".
  const continueTrackRef = useRef(handleContinueTrack);
  continueTrackRef.current = handleContinueTrack;
  const shortcutStateRef = useRef({ empty: true, hasStep: false, busy: false });
  shortcutStateRef.current = { empty: !text.trim(), hasStep: !!nextTrackStep, busy: submitting };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
      const { empty, hasStep, busy } = shortcutStateRef.current;
      if (!empty || !hasStep || busy) return;
      const active = document.activeElement as HTMLElement | null;
      const typingElsewhere =
        active &&
        active !== textareaRef.current &&
        (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName));
      if (typingElsewhere) return;
      e.preventDefault();
      void continueTrackRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keyboard Navigation: Enter submits (Shift+Enter for new line).
  // Ctrl/⌘+Enter bubbles to the global track shortcut above.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !text.trim()) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const placeholderText = mode === "TEACH" ? t.teachPrompt : t.practicePrompt;

  return (
    <div className={`w-full max-w-3xl mx-auto flex flex-col items-center z-20 ${className}`}>
      {/* INVARIANT: Contextual Track Chip directly above the composer */}
      {nextTrackStep && (
        <div className="mb-2 w-full flex justify-center animate-in fade-in slide-in-from-bottom-2 duration-200">
          <button
            type="button"
            onClick={handleContinueTrack}
            disabled={submitting}
            className="group flex items-center gap-2 bg-card/95 hover:bg-accent backdrop-blur border border-border hover:border-muted-foreground rounded-full px-3.5 py-1.5 shadow-lg transition-all cursor-pointer text-xs font-ui text-muted-foreground hover:text-foreground"
            title={t.composerContinueTitle(nextTrackStep.title)}
            aria-keyshortcuts="Control+Enter Meta+Enter"
          >
            <Route className="w-3.5 h-3.5 text-success" />
            <span className="text-muted-foreground">{t.composerTrackActive}</span>
            <span className="text-foreground font-medium max-w-xs truncate">
              {nextTrackStep.title}
            </span>
            <span className="flex items-center gap-1 bg-accent group-hover:bg-border px-2 py-0.5 rounded-full text-[11px] text-foreground border border-border">
              {t.composerContinue}
            </span>
          </button>
        </div>
      )}

      {/* Main Elevated Composer Container */}
      <div className="w-full bg-card border border-border focus-within:border-muted-foreground rounded-2xl shadow-2xl transition-all duration-200 p-3">
        {/* Top Controls: STRICTLY TWO MODES (TEACH and PRACTICE) */}
        <div className="flex items-center justify-between pb-2 border-b border-accent mb-2 px-1">
          <div className="flex items-center gap-1 bg-background p-1 rounded-lg border border-accent">
            {/* TEACH Mode */}
            <button
              type="button"
              onClick={() => setMode("TEACH")}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-ui font-medium transition-colors cursor-pointer ${
                mode === "TEACH"
                  ? "bg-accent text-foreground border border-border shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <BookOpen className="w-3.5 h-3.5 text-success" />
              <span>TEACH</span>
            </button>

            {/* PRACTICE Mode */}
            <button
              type="button"
              onClick={() => setMode("PRACTICE")}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-ui font-medium transition-colors cursor-pointer ${
                mode === "PRACTICE"
                  ? "bg-accent text-foreground border border-border shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Target className="w-3.5 h-3.5 text-warning" />
              <span>PRACTICE</span>
            </button>
          </div>

          <div className="flex items-center gap-2 text-[11px] font-ui text-muted-foreground">
            <span>{nextTrackStep ? t.composerHintTrack : t.composerHint}</span>
          </div>
        </div>

        {/* Text Input Area */}
        <div className="px-1">
          <textarea
            ref={textareaRef}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholderText}
            className="w-full bg-transparent text-foreground placeholder-muted-foreground font-prose text-[15px] resize-none border-none outline-none focus:outline-none focus:ring-0 leading-relaxed block"
          />
        </div>

        {/* Bottom Toolbar */}
        <div className="flex items-center justify-between pt-2 border-t border-accent mt-2 px-1">
          <div className="flex items-center gap-2">
            {/* Voice Dictation (🎙) */}
            {speechSupported && (
              <button
                type="button"
                onClick={toggleListening}
                className={`p-1.5 rounded-lg border transition-colors cursor-pointer ${
                  isListening
                    ? "bg-danger/20 border-danger text-danger animate-pulse"
                    : "bg-background border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                }`}
                title={
                  isListening
                    ? t.micRecording
                    : t.micDictate
                }
              >
                {isListening ? (
                  <Mic className="w-4 h-4" />
                ) : (
                  <MicOff className="w-4 h-4" />
                )}
              </button>
            )}

            {isListening && (
              <span className="text-[11px] font-ui text-danger flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-danger animate-ping" />
                {t.listening}
              </span>
            )}
          </div>

          {/* Send Button */}
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!text.trim() || submitting}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-ui font-semibold transition-all cursor-pointer ${
              text.trim() && !submitting
                ? "bg-foreground text-background hover:bg-foreground/90 shadow-md"
                : "bg-accent text-muted-foreground border border-border cursor-not-allowed"
            }`}
          >
            {submitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{t.starting}</span>
              </>
            ) : (
              <>
                <span>{t.send}</span>
                <Send className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
