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

  // Keyboard Navigation: Enter submits (Shift+Enter for new line)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
            className="group flex items-center gap-2 bg-[#1c1c1c]/95 hover:bg-[#2a2a2a] backdrop-blur border border-[#434343] hover:border-[#8d8d8d] rounded-full px-3.5 py-1.5 shadow-lg transition-all cursor-pointer text-xs font-ui text-[#8d8d8d] hover:text-[#e6e6e6]"
            title={`Continuar etapa da trilha: ${nextTrackStep.title}`}
          >
            <Route className="w-3.5 h-3.5 text-[#34d399]" />
            <span className="text-[#8d8d8d]">⇶ Trilha ativa · Próximo:</span>
            <span className="text-[#e6e6e6] font-medium max-w-xs truncate">
              {nextTrackStep.title}
            </span>
            <span className="flex items-center gap-1 bg-[#2a2a2a] group-hover:bg-[#333333] px-2 py-0.5 rounded-full text-[11px] text-[#e6e6e6] border border-[#434343]">
              Continuar ↵
            </span>
          </button>
        </div>
      )}

      {/* Main Elevated Composer Container */}
      <div className="w-full bg-[#1c1c1c] border border-[#434343] focus-within:border-[#8d8d8d] rounded-2xl shadow-2xl transition-all duration-200 p-3">
        {/* Top Controls: STRICTLY TWO MODES (TEACH and PRACTICE) */}
        <div className="flex items-center justify-between pb-2 border-b border-[#2a2a2a] mb-2 px-1">
          <div className="flex items-center gap-1 bg-[#141414] p-1 rounded-lg border border-[#2a2a2a]">
            {/* TEACH Mode */}
            <button
              type="button"
              onClick={() => setMode("TEACH")}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-ui font-medium transition-colors cursor-pointer ${
                mode === "TEACH"
                  ? "bg-[#2a2a2a] text-[#e6e6e6] border border-[#434343] shadow-sm"
                  : "text-[#8d8d8d] hover:text-[#e6e6e6]"
              }`}
            >
              <BookOpen className="w-3.5 h-3.5 text-[#34d399]" />
              <span>TEACH</span>
            </button>

            {/* PRACTICE Mode */}
            <button
              type="button"
              onClick={() => setMode("PRACTICE")}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-ui font-medium transition-colors cursor-pointer ${
                mode === "PRACTICE"
                  ? "bg-[#2a2a2a] text-[#e6e6e6] border border-[#434343] shadow-sm"
                  : "text-[#8d8d8d] hover:text-[#e6e6e6]"
              }`}
            >
              <Target className="w-3.5 h-3.5 text-[#fbbf24]" />
              <span>PRACTICE</span>
            </button>
          </div>

          <div className="flex items-center gap-2 text-[11px] font-ui text-[#8d8d8d]">
            <span>Shift + Enter para nova linha</span>
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
            className="w-full bg-transparent text-[#e6e6e6] placeholder-[#666666] font-prose text-[15px] resize-none border-none outline-none focus:outline-none focus:ring-0 leading-relaxed block"
          />
        </div>

        {/* Bottom Toolbar */}
        <div className="flex items-center justify-between pt-2 border-t border-[#2a2a2a] mt-2 px-1">
          <div className="flex items-center gap-2">
            {/* Voice Dictation (🎙) */}
            {speechSupported && (
              <button
                type="button"
                onClick={toggleListening}
                className={`p-1.5 rounded-lg border transition-colors cursor-pointer ${
                  isListening
                    ? "bg-[#f87171]/20 border-[#f87171] text-[#f87171] animate-pulse"
                    : "bg-[#141414] border-[#434343] text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#2a2a2a]"
                }`}
                title={
                  isListening
                    ? "Gravando voz... clique para parar"
                    : "Ditar por voz (pt-BR)"
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
              <span className="text-[11px] font-ui text-[#f87171] flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#f87171] animate-ping" />
                Ouvindo...
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
                ? "bg-[#e6e6e6] text-[#141414] hover:bg-[#ffffff] shadow-md"
                : "bg-[#2a2a2a] text-[#666666] border border-[#434343] cursor-not-allowed"
            }`}
          >
            {submitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Iniciando...</span>
              </>
            ) : (
              <>
                <span>Enviar</span>
                <Send className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
