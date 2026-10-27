"use client";

import { useEffect, type RefObject } from "react";

const FOCUS_EVENT = "learnharness:focus-composer";
let pending = false;

/**
 * `newSession` shortcut: asks the Home composer for the focus. Works whether the
 * composer is already mounted (event) or mounts after the navigation (pending flag).
 */
export function requestComposerFocus() {
  pending = true;
  window.dispatchEvent(new Event(FOCUS_EVENT));
}

export function useComposerFocusRequest(ref: RefObject<HTMLTextAreaElement | null>) {
  useEffect(() => {
    const take = () => {
      if (!pending || !ref.current) return;
      pending = false;
      ref.current.focus();
    };
    take();
    window.addEventListener(FOCUS_EVENT, take);
    return () => window.removeEventListener(FOCUS_EVENT, take);
  }, [ref]);
}
