"use client";

import { useEffect, useRef, useState } from "react";

const ROADMAP_EVENT = "lapidare:roadmap-on";
let pending = false;

/**
 * Asks the graph view to turn ⇶ Roteiro on (Home vazia, Fase 18). Same shape as
 * `composer-focus`: an event when the graph is mounted, a pending flag otherwise.
 */
export function requestRoadmapOn() {
  pending = true;
  window.dispatchEvent(new Event(ROADMAP_EVENT));
}

const STATE_EVENT = "lapidare:roadmap-state";
let drawn = false;

/** Home side: whether ⇶ Roteiro is currently drawn (the empty Home moves aside for it). */
export function useRoadmapDrawn(): boolean {
  const [on, setOn] = useState(drawn);
  useEffect(() => {
    const sync = () => setOn(drawn);
    sync();
    window.addEventListener(STATE_EVENT, sync);
    return () => window.removeEventListener(STATE_EVENT, sync);
  }, []);
  return on;
}

/**
 * Graph side: takes the pending request once the roadmap can be drawn (`ready`) and
 * broadcasts whether it is drawn now (`isOn`).
 */
export function useRoadmapRequest(ready: boolean, isOn: boolean, turnOn: () => void) {
  const turnOnRef = useRef(turnOn);
  turnOnRef.current = turnOn;
  useEffect(() => {
    drawn = isOn;
    window.dispatchEvent(new Event(STATE_EVENT));
  }, [isOn]);
  useEffect(
    () => () => {
      drawn = false;
      window.dispatchEvent(new Event(STATE_EVENT));
    },
    [],
  );
  useEffect(() => {
    const take = () => {
      if (!pending || !ready) return;
      pending = false;
      turnOnRef.current();
    };
    take();
    window.addEventListener(ROADMAP_EVENT, take);
    return () => window.removeEventListener(ROADMAP_EVENT, take);
  }, [ready]);
}
