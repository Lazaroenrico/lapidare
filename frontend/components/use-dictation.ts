"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { registerCommandTarget, TOGGLE_DICTATION_EVENT } from "@/lib/command-events";
import {
  CLOSE_STREAM_MESSAGE,
  type DictationSettings,
  FINISH_TIMEOUT_MS,
  errorMessage,
  isActive,
  levelFromRms,
  listenProtocols,
  listenUrl,
  nextState,
  parseMessage,
  reduceTranscript,
  type DictationEvent,
  type DictationState,
} from "@/lib/dictation-core";
import { dictationText } from "@/lib/dictation-i18n";
import { ApiError, createDictationToken, getDictationSettings } from "@/lib/api";
import { useEventSubscription } from "@/components/server-events";
import { useShortcut } from "@/components/use-shortcut";

/**
 * Deepgram streaming dictation. The final transcript goes to the CURRENT sink
 * (`setSink`) once the stream closes, so the dock can redirect dictation to whichever
 * field is active. Flow: token → mic → AudioWorklet (16 kHz PCM) → WebSocket.
 */
export interface DictationOptions {
  /** Element whose focus claims ⌘D for this instance (focus inside wins over other docks). */
  field?: RefObject<HTMLElement | null>;
  /** False while the owner's field is not on screen (answered quiz, other mode): ⌘D skips it. */
  enabled?: boolean;
}

interface Run {
  stream: MediaStream | null;
  ctx: AudioContext | null;
  node: AudioWorkletNode | null;
  ws: WebSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
  queue: ArrayBuffer[];
  open: boolean;
  done: boolean;
  text: string;
}

const MAX_QUEUED_CHUNKS = 600; // ~60 s of audio while the socket is still opening

/** Cancels whichever dictation is active (only one mic at a time). Returns true if one was. */
let cancelActive: (() => boolean) | null = null;
export const cancelActiveDictation = (): boolean => (cancelActive ? cancelActive() : false);

function releaseAudio(run: Run) {
  run.stream?.getTracks().forEach((track) => track.stop());
  run.stream = null;
  if (run.node) {
    run.node.port.onmessage = null;
    try {
      run.node.disconnect();
    } catch {
      /* already disconnected */
    }
    run.node = null;
  }
  if (run.ctx) {
    void run.ctx.close().catch(() => undefined);
    run.ctx = null;
  }
}

function releaseAll(run: Run) {
  run.done = true;
  if (run.timer) clearTimeout(run.timer);
  run.timer = null;
  releaseAudio(run);
  if (run.ws) {
    run.ws.onopen = run.ws.onmessage = run.ws.onerror = run.ws.onclose = null;
    try {
      run.ws.close();
    } catch {
      /* already closed */
    }
    run.ws = null;
  }
  run.queue = [];
}

export function useDictation(locale: string, options: DictationOptions = {}) {
  const [settings, setSettings] = useState<DictationSettings>({ configured: false, language: "multi" });
  const [capable, setCapable] = useState(false);
  const [state, setStateValue] = useState<DictationState>("idle");
  const [level, setLevel] = useState(0);
  const stateRef = useRef<DictationState>("idle");
  const runRef = useRef<Run | null>(null);
  const sinkRef = useRef<(text: string) => void>(() => undefined);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const enabled = options.enabled ?? true;
  const supported = settings.configured && capable;
  const active = isActive(state);
  const stateInfo = useRef({ supported, active, enabled });
  stateInfo.current = { supported, active, enabled };
  const toggleRef = useRef<() => void>(() => undefined);
  const fieldRef = options.field;

  const apply = useCallback((event: DictationEvent) => {
    const next = nextState(stateRef.current, event);
    stateRef.current = next;
    setStateValue(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setSettings(await getDictationSettings());
    } catch {
      setSettings((prev) => (prev.configured ? { ...prev, configured: false } : prev));
    }
  }, []);

  useEffect(() => {
    void refresh();
    setCapable(
      typeof navigator !== "undefined" &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof AudioContext !== "undefined" &&
        typeof AudioWorkletNode !== "undefined" &&
        typeof WebSocket !== "undefined",
    );
  }, [refresh]);
  useEventSubscription(["config:updated"], () => void refresh());

  /** Frees mic, AudioContext and socket and returns to idle, discarding any text. */
  const cancel = useCallback((): boolean => {
    const run = runRef.current;
    if (!run) return false;
    runRef.current = null;
    releaseAll(run);
    setLevel(0);
    apply("cancel");
    return true;
  }, [apply]);

  const fail = useCallback(
    (run: Run, message: string) => {
      if (runRef.current !== run) return;
      runRef.current = null;
      releaseAll(run);
      setLevel(0);
      apply("fail");
      window.dispatchEvent(new CustomEvent("harness:error", { detail: message }));
      apply("reset");
    },
    [apply],
  );

  /** The stream is over: deliver the accumulated text to the sink, then release everything. */
  const finish = useCallback(
    (run: Run) => {
      if (runRef.current !== run || run.done) return;
      const text = run.text.trim();
      runRef.current = null;
      releaseAll(run);
      setLevel(0);
      apply("closed");
      if (text) sinkRef.current(text);
    },
    [apply],
  );

  const stop = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    if (stateRef.current === "requesting") {
      cancel();
      return;
    }
    if (stateRef.current !== "listening") return;
    apply("stop");
    setLevel(0);
    releaseAudio(run); // mic off right away; the socket stays open for the last results
    if (run.ws && run.open) {
      try {
        run.ws.send(CLOSE_STREAM_MESSAGE);
      } catch {
        finish(run);
        return;
      }
      run.timer = setTimeout(() => finish(run), FINISH_TIMEOUT_MS);
    } else {
      finish(run);
    }
  }, [apply, cancel, finish]);

  const begin = useCallback(async () => {
    cancelActiveDictation();
    const run: Run = { stream: null, ctx: null, node: null, ws: null, timer: null, queue: [], open: false, done: false, text: "" };
    runRef.current = run;
    cancelActive = cancel;
    apply("start");
    const stale = () => runRef.current !== run;
    const t = dictationText(localeRef.current);
    try {
      const { access_token } = await createDictationToken();
      if (stale()) return;
      try {
        run.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
      } catch (err) {
        const name = err instanceof DOMException ? err.name : "";
        fail(run, name === "NotFoundError" || name === "OverconstrainedError" ? t.errNoMic : t.errMicDenied);
        return;
      }
      if (stale()) return releaseAll(run);
      run.ctx = new AudioContext();
      await run.ctx.audioWorklet.addModule("/dictation-worklet.js");
      if (stale()) return releaseAll(run);
      const source = run.ctx.createMediaStreamSource(run.stream);
      const node = new AudioWorkletNode(run.ctx, "dictation-processor");
      run.node = node;
      // Muted sink: browsers only pull a worklet that is connected toward the destination.
      const mute = run.ctx.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(run.ctx.destination);

      const ws = new WebSocket(listenUrl(settingsRef.current.language), listenProtocols(access_token));
      ws.binaryType = "arraybuffer";
      run.ws = ws;
      node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
        if (stale()) return;
        setLevel(levelFromRms(event.data.rms));
        if (run.open && ws.readyState === WebSocket.OPEN) ws.send(event.data.pcm);
        else if (run.queue.length < MAX_QUEUED_CHUNKS) run.queue.push(event.data.pcm);
      };
      ws.onopen = () => {
        if (stale()) return;
        run.open = true;
        for (const chunk of run.queue) ws.send(chunk);
        run.queue = [];
        apply("ready");
      };
      ws.onmessage = (event) => {
        run.text = reduceTranscript(run.text, parseMessage(event.data));
      };
      ws.onerror = () => {
        if (!run.open) fail(run, errorMessage(502, localeRef.current));
      };
      ws.onclose = () => {
        if (stale()) return;
        if (run.open) finish(run);
        else fail(run, errorMessage(502, localeRef.current));
      };
    } catch (err) {
      fail(run, errorMessage(err instanceof ApiError ? err.status : 502, localeRef.current));
    }
  }, [apply, cancel, fail, finish]);

  const toggle = useCallback(() => {
    const s = stateRef.current;
    if (s === "finishing") return;
    if (s === "requesting" || s === "listening") stop();
    else void begin();
  }, [begin, stop]);
  toggleRef.current = toggle;

  // The field went away while listening (quiz answered, mode switched): drop the mic.
  useEffect(() => {
    if (!enabled && active) cancel();
  }, [enabled, active, cancel]);

  // Release mic, AudioContext and socket on unmount.
  useEffect(
    () => () => {
      if (runRef.current) {
        if (cancelActive === cancel) cancelActive = null;
        cancel();
      }
    },
    [cancel],
  );

  // Esc goes through the shortcut registry ("abort"): cancels and discards the text.
  useShortcut("abort", () => (cancel() ? undefined : false), active);

  // ⌘D (`learnharness:toggle-dictation`): the instance already listening stops; otherwise
  // the one whose field holds focus, else the most recently mounted, starts.
  useEffect(
    () =>
      registerCommandTarget(TOGGLE_DICTATION_EVENT, {
        run: () => toggleRef.current(),
        eligible: () => stateInfo.current.supported && (stateInfo.current.enabled || stateInfo.current.active),
        claims: () => stateInfo.current.active || !!fieldRef?.current?.contains(document.activeElement),
      }),
    [fieldRef],
  );

  const setSink = (sink: (text: string) => void) => {
    sinkRef.current = sink;
  };

  return {
    /** Configured (key saved) and the browser can capture audio: show the mic button. */
    supported,
    /** The mic is open and streaming. */
    listening: state === "listening",
    state,
    level,
    toggle,
    cancel,
    setSink,
  };
}

/** Appends dictated text to an existing draft with a single space. */
export const appendDictation = (prev: string, text: string) => (prev.trim() ? `${prev.replace(/\s+$/, "")} ${text}` : text);
