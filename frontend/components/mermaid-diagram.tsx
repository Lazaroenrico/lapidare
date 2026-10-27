"use client";

import React, { useEffect, useId, useState } from "react";
import { palette } from "@/lib/palette";

/**
 * Renders a fenced `mermaid` block as SVG. mermaid is loaded on demand (it is large) and
 * themed from `lib/palette` (it needs literal colors, not CSS variables). While the source
 * does not parse (a block still streaming in, or a broken diagram) the caller's fallback
 * (the plain code block) shows.
 */
type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      const { card, accent, border, foreground, mutedForeground: muted } = palette;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: '"Source Sans 3", system-ui, sans-serif',
        themeVariables: {
          darkMode: true,
          background: palette.background,
          primaryColor: accent,
          primaryTextColor: foreground,
          primaryBorderColor: border,
          secondaryColor: card,
          tertiaryColor: card,
          lineColor: muted,
          textColor: foreground,
          mainBkg: accent,
          nodeBorder: border,
          clusterBkg: card,
          clusterBorder: border,
          edgeLabelBackground: card,
          fontSize: "14px",
        },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

export function MermaidDiagram({ source, fallback }: { source: string; fallback: React.ReactNode }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Debounced: during streaming the source changes on every token.
    const timer = setTimeout(async () => {
      try {
        const mermaid = await loadMermaid();
        if (!(await mermaid.parse(source, { suppressErrors: true }))) {
          if (!cancelled) setSvg(null);
          return;
        }
        const { svg: rendered } = await mermaid.render(id, source);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setSvg(null);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, source]);

  if (svg === null) return <>{fallback}</>;
  return (
    <div
      className="my-4 p-4 rounded border border-border bg-card overflow-x-auto flex justify-center [&_svg]:max-w-full [&_svg]:h-auto"
      role="img"
      aria-label="mermaid"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
