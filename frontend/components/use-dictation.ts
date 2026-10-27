"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { registerCommandTarget, TOGGLE_DICTATION_EVENT } from "@/lib/command-events";

/**
 * Web Speech dictation. Each final transcript goes to the CURRENT sink
 * (`setSink`), so the dock can redirect dictation to whichever field is active
 * without restarting recognition.
 */
export interface DictationOptions {
  /** Element whose focus claims ⌘D for this instance (focus inside wins over other docks). */
  field?: RefObject<HTMLElement | null>;
  /** False while the owner's field is not on screen (answered quiz, other mode): ⌘D skips it. */
  enabled?: boolean;
}

export function useDictation(locale: string, options: DictationOptions = {}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const sinkRef = useRef<(text: string) => void>(() => undefined);
  const enabled = options.enabled ?? true;
  const stateRef = useRef({ supported, listening, enabled });
  stateRef.current = { supported, listening, enabled };
  const toggleRef = useRef<() => void>(() => undefined);
  const fieldRef = options.field;

  // The field went away while listening (quiz answered, mode switched): stop the mic.
  useEffect(() => {
    if (!enabled && listening) {
      recognitionRef.current?.stop();
      setListening(false);
    }
  }, [enabled, listening]);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window));
    return () => recognitionRef.current?.stop();
  }, []);

  // ⌘D (`learnharness:toggle-dictation`): the instance already listening stops; otherwise
  // the one whose field holds focus, else the most recently mounted, starts.
  useEffect(
    () =>
      registerCommandTarget(TOGGLE_DICTATION_EVENT, {
        run: () => toggleRef.current(),
        eligible: () => stateRef.current.supported && (stateRef.current.enabled || stateRef.current.listening),
        claims: () =>
          stateRef.current.listening || !!fieldRef?.current?.contains(document.activeElement),
      }),
    [fieldRef],
  );

  const setSink = (sink: (text: string) => void) => {
    sinkRef.current = sink;
  };

  const toggle = () => {
    if (typeof window === "undefined") return;
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const Recognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Recognition) return;
    try {
      const recognition = new Recognition();
      recognition.lang = locale === "en" ? "en-US" : "pt-BR";
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => setListening(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onresult = (event: any) => {
        const transcript = String(event.results?.[0]?.[0]?.transcript ?? "").trim();
        if (transcript) sinkRef.current(transcript);
      };
      recognition.onerror = () => setListening(false);
      recognition.onend = () => setListening(false);
      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      setListening(false);
    }
  };

  toggleRef.current = toggle;

  return { supported, listening, toggle, setSink };
}

/** Appends dictated text to an existing draft with a single space. */
export const appendDictation = (prev: string, text: string) => (prev.trim() ? `${prev.replace(/\s+$/, "")} ${text}` : text);
