"use client";

import React, { memo, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Check, Copy } from "lucide-react";
import { useLocale } from "./locale-provider";

interface LessonProseProps {
  content: string;
  sourceName?: string;
  onSelectCitation?: (sourceName: string, paragraphId: string) => void;
  className?: string;
}

/**
 * Preprocesses markdown string to transform Obsidian-style citations and wikilinks
 * into custom protocol links recognized by ReactMarkdown.
 *
 * Supported formats:
 * - [[Nome da Fonte#^p14]] or [[Nome da Fonte#p14]] -> lh-cite://Nome da Fonte/p14
 * - [[#^p14]] -> lh-cite://{defaultSource}/p14
 * - (#^p14) -> lh-cite://{defaultSource}/p14
 * - [[Conceito]] -> lh-concept://Conceito
 */
function preprocessCitations(raw: string, defaultSource?: string): string {
  if (!raw) return "";

  const fallback = defaultSource ? encodeURIComponent(defaultSource.trim()) : "";

  let processed = raw;

  // 1. [[Fonte#^p14]] or [[Fonte#p14]]
  processed = processed.replace(
    /\[\[([^\]#\n]+)#\^?([a-zA-Z0-9_-]+)\]\]/g,
    (_, src, p) => `[#^${p}](lh-cite://${encodeURIComponent(src.trim())}/${p})`
  );

  // 2. [[#^p14]] or [[^p14]]
  processed = processed.replace(
    /\[\[#?\^([a-zA-Z0-9_-]+)\]\]/g,
    (_, p) => `[#^${p}](lh-cite://${fallback || "default"}/${p})`
  );

  // 3. (#^p14) standalone in text
  processed = processed.replace(
    /\(#\^([a-zA-Z0-9_-]+)\)/g,
    (_, p) => `[#^${p}](lh-cite://${fallback || "default"}/${p})`
  );

  // 4. Obsidian wikilinks: [[Nome do Conceito]] (exclude already processed links)
  processed = processed.replace(
    /\[\[([a-zA-Z0-9_ -]+)\]\]/g,
    (_, concept) => `[${concept}](lh-concept://${encodeURIComponent(concept.trim())})`
  );

  return processed;
}

/**
 * Code block with copy button and themed styling
 */
function CodeBlock({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  const codeText = React.Children.toArray(children).join("");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard error
    }
  };

  return (
    <div className="relative group my-4 rounded border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-background border-b border-border text-[11px] font-ui text-muted-foreground">
        <span className="uppercase tracking-wider">
          {className ? className.replace("language-", "") : "code"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-foreground transition-colors p-1 rounded"
          title={t.copyCode}
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-success" />
              <span className="text-success text-[10px]">{t.copied}</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span className="text-[10px]">{t.copy}</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-3.5 font-ui text-[12.5px] leading-relaxed text-foreground overflow-x-auto selection:bg-border">
        <code>{children}</code>
      </pre>
    </div>
  );
}

// Module constants: new arrays per render would defeat ReactMarkdown's own work reuse.
const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];

/**
 * Memoized: a transcript re-renders on every keystroke and every session notify, and
 * re-parsing Markdown + KaTeX for every message is the chat's dominant cost. Only a
 * message whose text (or citation handler) changed renders again.
 */
export const LessonProse = memo(function LessonProse({
  content,
  sourceName,
  onSelectCitation,
  className = "",
}: LessonProseProps) {
  const { t } = useLocale();
  const processedContent = useMemo(
    () => preprocessCitations(content, sourceName),
    [content, sourceName]
  );
  const components = useMemo<Components>(() => ({
    h1: ({ children }) => (
      <h1 className="font-title font-bold text-2xl md:text-3xl text-foreground mt-7 mb-3 tracking-tight">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="font-title font-bold text-xl md:text-2xl text-foreground mt-6 mb-2.5 pb-1 border-b border-accent tracking-tight">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="font-title font-bold text-lg md:text-xl text-foreground mt-5 mb-2 tracking-tight">
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="font-title font-bold text-base text-foreground mt-4 mb-1.5 tracking-tight">
        {children}
      </h4>
    ),
    p: ({ children }) => (
      <p className="my-3 font-prose text-[length:var(--prose-size)] leading-[1.65] text-foreground">
        {children}
      </p>
    ),
    ul: ({ children }) => (
      <ul className="my-3 pl-5 list-disc space-y-1 font-prose text-[length:var(--prose-size)] leading-[1.6] text-foreground">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="my-3 pl-5 list-decimal space-y-1 font-prose text-[length:var(--prose-size)] leading-[1.6] text-foreground">
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li className="text-foreground my-0.5">{children}</li>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-3 pl-4 border-l-2 border-border text-muted-foreground italic font-prose">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="border-accent my-6" />,
    table: ({ children }) => (
      <div className="overflow-x-auto my-4 border border-border rounded bg-card">
        <table className="w-full text-left font-prose border-collapse text-sm">
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="bg-background border-b border-border">
        {children}
      </thead>
    ),
    th: ({ children }) => (
      <th className="px-3 py-2 font-ui text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-3 py-2 border-b border-accent text-foreground text-[14px]">
        {children}
      </td>
    ),
    pre: ({ children }) => <>{children}</>,
    code: ({
      inline,
      className: codeClassName,
      children,
    }: {
      inline?: boolean;
      className?: string;
      children?: React.ReactNode;
    }) => {
      if (inline) {
        return (
          <code className="px-1.5 py-0.5 rounded bg-card border border-border font-ui text-[12px] text-foreground mx-0.5">
            {children}
          </code>
        );
      }
      return <CodeBlock className={codeClassName}>{children}</CodeBlock>;
    },
    a: ({ href, children, ...props }) => {
      // Check for custom citation links
      if (href?.startsWith("lh-cite://")) {
        const urlPart = href.replace("lh-cite://", "");
        const slashIdx = urlPart.indexOf("/");
        let rawSource = "";
        let paragraphId = "";

        if (slashIdx !== -1) {
          rawSource = urlPart.slice(0, slashIdx);
          paragraphId = urlPart.slice(slashIdx + 1);
        } else {
          paragraphId = urlPart;
        }

        const resolvedSource =
          rawSource && rawSource !== "default"
            ? decodeURIComponent(rawSource)
            : sourceName || t.sourceFallback;

        return (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (onSelectCitation) {
                onSelectCitation(resolvedSource, paragraphId);
              }
            }}
            className="inline-flex items-center gap-1 mx-1 px-1.5 py-0.5 rounded bg-card hover:bg-accent border border-border hover:border-muted-foreground text-foreground text-[11px] font-ui transition-colors cursor-pointer select-none align-baseline group active:scale-95"
            title={t.viewSource(resolvedSource, paragraphId)}
          >
            <span className="text-muted-foreground group-hover:text-foreground">#^</span>
            <span className="font-semibold text-foreground">
              {paragraphId.replace(/^p/, "p")}
            </span>
          </button>
        );
      }

      // Check for Obsidian concept wikilinks
      if (href?.startsWith("lh-concept://")) {
        const conceptName = decodeURIComponent(
          href.replace("lh-concept://", "")
        );
        return (
          <span
            className="inline-block text-foreground underline decoration-dotted decoration-border hover:decoration-foreground font-medium cursor-help mx-0.5"
            title={t.conceptNoteTitle(conceptName)}
          >
            {children}
          </span>
        );
      }

      // Regular link
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline decoration-border hover:decoration-foreground transition-colors"
          {...props}
        >
          {children}
        </a>
      );
    },
  }), [sourceName, onSelectCitation, t]);

  return (
    <div className={`lesson-prose select-text font-prose text-[length:var(--prose-size)] text-foreground leading-[1.65] ${className}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {processedContent}
      </ReactMarkdown>
    </div>
  );
});

/**
 * Short text with inline Markdown and KaTeX (quiz options, descriptions, chosen answers):
 * no block margins, inherits the surrounding font and colour.
 */
const INLINE_COMPONENTS: Components = {
  p: ({ children }) => <span>{children}</span>,
  a: ({ children }) => <span>{children}</span>,
};

export function InlineMath({ content, className = "" }: { content: string; className?: string }) {
  return (
    <span className={`inline-math ${className}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={INLINE_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </span>
  );
}
