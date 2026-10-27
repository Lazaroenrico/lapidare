"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useLocale } from "@/components/locale-provider";
import { findInSegments, stepMatch, type MatchPiece } from "@/lib/session-ux";

const MATCH = "session-find";
const ACTIVE = "session-find-active";

interface HighlightRegistryLike {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

/** CSS Custom Highlight API, when the browser has it. */
function highlightApi(): { registry: HighlightRegistryLike; Highlight: new (...ranges: Range[]) => unknown } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return css?.highlights && Highlight ? { registry: css.highlights, Highlight } : null;
}

/** Text nodes of the transcript in document order, minus hidden MathML and form fields. */
function textNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (parent.closest(".katex-mathml, script, style, textarea, input, [data-find-skip]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** `<mark>` fallback: wraps pieces and remembers how to restore the original text nodes. */
interface Wrapped {
  head: Text;
  mark: HTMLElement;
  tail: Text;
}

function wrapPieces(nodes: Text[], matches: MatchPiece[][]): { marks: HTMLElement[][]; restore: () => void } {
  const marks: HTMLElement[][] = matches.map(() => []);
  const bySegment = new Map<number, { piece: MatchPiece; match: number }[]>();
  matches.forEach((pieces, match) =>
    pieces.forEach((piece) => bySegment.set(piece.segment, [...(bySegment.get(piece.segment) ?? []), { piece, match }])),
  );
  const wrapped: Wrapped[] = [];
  for (const [segment, list] of bySegment) {
    const head = nodes[segment];
    // Right to left, so earlier offsets stay valid in `head`.
    for (const { piece, match } of [...list].sort((a, b) => b.piece.start - a.piece.start)) {
      const tail = head.splitText(piece.end);
      const middle = head.splitText(piece.start);
      const mark = document.createElement("mark");
      mark.className = "find-mark";
      middle.replaceWith(mark);
      mark.appendChild(middle);
      marks[match].unshift(mark);
      wrapped.push({ head, mark, tail });
    }
  }
  const restore = () => {
    // Undo in reverse order: each step glues the mark and its tail back onto the head node,
    // which keeps the original Text node (the one React owns) in place.
    for (let i = wrapped.length - 1; i >= 0; i -= 1) {
      const { head, mark, tail } = wrapped[i];
      head.appendData((mark.textContent ?? "") + tail.data);
      mark.remove();
      tail.remove();
    }
  };
  return { marks, restore };
}

/**
 * ⌘F find bar for the session transcript: literal, case-insensitive, ↑/↓ (or Enter /
 * Shift+Enter) between matches, with a counter. Highlights use the CSS Custom Highlight
 * API; browsers without it get `<mark>` elements that are removed on every recompute.
 */
export function SessionFindBar({
  containerRef,
  version,
  focusSignal,
  onClose,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  /** Changes whenever the transcript content changes (recomputes the matches). */
  version: string;
  /** Bumped by ⌘F while the bar is already open: refocus and select the query. */
  focusSignal: number;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rangesRef = useRef<Range[]>([]);
  const marksRef = useRef<HTMLElement[][]>([]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  // Recompute the matches (layout effect: highlights land before paint).
  useLayoutEffect(() => {
    const root = containerRef.current;
    const api = highlightApi();
    rangesRef.current = [];
    marksRef.current = [];
    if (!root || !query) {
      setCount(0);
      setActive(-1);
      return;
    }
    const nodes = textNodes(root);
    const matches = findInSegments(nodes.map((n) => n.data), query);
    setCount(matches.length);
    setActive((prev) => (matches.length === 0 ? -1 : prev >= 0 && prev < matches.length ? prev : 0));
    if (api) {
      rangesRef.current = matches.map((pieces) => {
        const range = document.createRange();
        const first = pieces[0];
        const last = pieces[pieces.length - 1];
        range.setStart(nodes[first.segment], first.start);
        range.setEnd(nodes[last.segment], last.end);
        return range;
      });
      api.registry.set(MATCH, new api.Highlight(...rangesRef.current));
      return () => {
        api.registry.delete(MATCH);
        api.registry.delete(ACTIVE);
      };
    }
    const { marks, restore } = wrapPieces(nodes, matches);
    marksRef.current = marks;
    return () => {
      marksRef.current = [];
      restore();
    };
  }, [containerRef, query, version]);

  // Active match: its own highlight, scrolled into view.
  useLayoutEffect(() => {
    const api = highlightApi();
    if (active < 0) {
      api?.registry.delete(ACTIVE);
      return;
    }
    let target: Element | null = null;
    if (api) {
      const range = rangesRef.current[active];
      if (!range) return;
      api.registry.set(ACTIVE, new api.Highlight(range));
      target = range.startContainer.parentElement;
    } else {
      const marks = marksRef.current;
      marks.flat().forEach((m) => m.classList.remove("find-mark-active"));
      marks[active]?.forEach((m) => m.classList.add("find-mark-active"));
      target = marks[active]?.[0] ?? null;
    }
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active, count, query, version]);

  const step = (dir: 1 | -1) => setActive((cur) => stepMatch(cur, count, dir));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // Owns Esc: the abort chain must not see it.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if ((e.key === "Enter" && !e.nativeEvent.isComposing) || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      step(e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1);
    }
  };

  const counter = !query ? "" : count === 0 ? t.uxFindNone : t.uxFindCount(active + 1, count);

  return (
    <div
      role="search"
      data-find-skip
      className="absolute top-2 right-4 z-30 flex items-center gap-1 bg-card border border-border rounded-lg shadow-lg pl-2 pr-1 py-1 font-ui text-[11px]"
    >
      <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t.uxFindLabel}
        aria-label={t.uxFindLabel}
        className="w-44 bg-transparent text-[12px] text-foreground placeholder-muted-foreground px-1 py-0.5"
      />
      <span className="min-w-[56px] text-right tabular-nums text-muted-foreground" aria-live="polite">
        {counter}
      </span>
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={count === 0}
        title={t.uxFindPrev}
        aria-label={t.uxFindPrev}
        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={count === 0}
        title={t.uxFindNext}
        aria-label={t.uxFindNext}
        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onClose}
        title={t.uxFindClose}
        aria-label={t.uxFindClose}
        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
