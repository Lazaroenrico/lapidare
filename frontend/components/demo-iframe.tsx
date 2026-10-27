"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ExternalLink,
  Maximize2,
  Minimize2,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useLocale } from "@/components/locale-provider";

export interface DemoIframeProps {
  /** Slug of the saved simulator in viz/demos/<slug>.html */
  slug?: string;
  /** Human-readable title of the simulator */
  title?: string;
  /** Direct HTML content to render in srcDoc (overrides API fetch) */
  srcDoc?: string;
  /** Custom endpoint URL for fetching the HTML demo */
  apiUrl?: string;
  /** Container height when embedded (defaults to 540px) */
  height?: number | string;
  /** Optional additional CSS classes */
  className?: string;
  /** Whether to render a close button */
  showCloseButton?: boolean;
  /** Callback fired when close button is clicked */
  onClose?: () => void;
}

/**
 * Interactive Demo Iframe component for Lapidare.
 *
 * Renders self-contained visual simulators (`viz/demos/<slug>.html`) inside
 * a sandboxed iframe styled in the purple design system (`bg-background` tokens).
 * Supports reload, expand to fullscreen, loading spinners, and error retries.
 */
export function DemoIframe({
  slug,
  title,
  srcDoc,
  apiUrl,
  height = 540,
  className = "",
  showCloseButton = false,
  onClose,
}: DemoIframeProps) {
  const { t } = useLocale();
  const [htmlContent, setHtmlContent] = useState<string>(srcDoc || "");
  const [loading, setLoading] = useState<boolean>(!srcDoc && Boolean(slug));
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [reloadKey, setReloadKey] = useState<number>(0);

  // Determine fetch target URL
  const fetchUrl = apiUrl || (slug ? `/api/demos/${encodeURIComponent(slug)}` : null);

  const fetchDemoHtml = useCallback(async () => {
    if (srcDoc) {
      setHtmlContent(srcDoc);
      setLoading(false);
      setError(null);
      return;
    }

    if (!fetchUrl) {
      if (!htmlContent) {
        setError(t.demoNoSource);
      }
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(fetchUrl, {
        headers: { Accept: "application/json, text/html, */*" },
      });

      if (!response.ok) {
        throw new Error(
          t.demoHttpFailed(response.status, response.statusText)
        );
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await response.json();
        const rawHtml = data.html || data.content || data.srcDoc;
        if (!rawHtml) {
          throw new Error(t.demoNoHtml);
        }
        setHtmlContent(rawHtml);
      } else {
        const text = await response.text();
        setHtmlContent(text);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t.demoUnknownError;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [srcDoc, fetchUrl, htmlContent, t]);

  useEffect(() => {
    fetchDemoHtml();
  }, [fetchDemoHtml, reloadKey]);

  // Handle ESC key to exit fullscreen
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && isFullscreen) {
        setIsFullscreen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  const handleReload = () => {
    setReloadKey((prev) => prev + 1);
  };

  const handleOpenRaw = () => {
    if (!fetchUrl) return;
    // Served with a `CSP: sandbox allow-scripts` header, so the tab gets an opaque origin too.
    const rawUrl = slug ? `/api/demos/${encodeURIComponent(slug)}?raw=true` : fetchUrl;
    window.open(rawUrl, "_blank", "noopener,noreferrer");
  };

  const formattedHeight =
    typeof height === "number" ? `${height}px` : height;

  return (
    <div
      className={`
        flex flex-col bg-card border border-border rounded-md overflow-hidden transition-all duration-200
        ${isFullscreen ? "fixed inset-0 z-50 m-0 rounded-none border-none bg-background/98 p-3" : className}
      `}
      style={{
        height: isFullscreen ? "100vh" : formattedHeight,
        minHeight: isFullscreen ? "100vh" : "420px",
      }}
    >
      {/* Header Bar */}
      <header className="flex items-center justify-between px-3.5 py-2.5 bg-background border-b border-border select-none">
        {/* Left: Badge & Title */}
        <div className="flex items-center gap-2.5 overflow-hidden">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono tracking-wider font-semibold bg-success/10 text-success border border-success/30 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
            {t.demoBadge}
          </span>

          <span
            className="text-[14px] font-serif font-bold text-foreground truncate max-w-[320px] sm:max-w-[480px]"
            title={title || slug || t.demoSimulator}
          >
            {title || (slug ? `viz/demos/${slug}.html` : t.demoGraphicSimulator)}
          </span>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Reload Button */}
          <button
            type="button"
            onClick={handleReload}
            disabled={loading}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors disabled:opacity-40"
            title={t.demoReloadTitle}
            aria-label={t.demoReload}
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? "animate-spin text-success" : ""}`}
            />
          </button>

          {/* External Raw Link */}
          {fetchUrl && (
            <button
              type="button"
              onClick={handleOpenRaw}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
              title={t.demoOpenRawTitle}
              aria-label={t.demoNewTab}
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Fullscreen Toggle */}
          <button
            type="button"
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            title={isFullscreen ? t.demoRestoreTitle : t.demoFullscreenTitle}
            aria-label={isFullscreen ? t.demoMinimize : t.demoFullscreen}
          >
            {isFullscreen ? (
              <Minimize2 className="w-3.5 h-3.5 text-success" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>

          {/* Close Button */}
          {(showCloseButton || onClose) && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-muted-foreground hover:text-danger hover:bg-accent rounded transition-colors ml-1"
              title={t.demoCloseTitle}
              aria-label={t.close}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </header>

      {/* Main Viewer Area */}
      <div className="relative flex-1 w-full h-full bg-background overflow-hidden">
        {/* Loading Overlay */}
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/90 backdrop-blur-xs">
            <div className="relative w-8 h-8">
              <div className="absolute inset-0 border-2 border-border rounded-full" />
              <div className="absolute inset-0 border-2 border-t-success border-r-transparent border-b-transparent border-l-transparent rounded-full animate-spin" />
            </div>
            <span className="font-mono text-[11.5px] tracking-wider text-muted-foreground">
              {t.demoLoading}
            </span>
          </div>
        )}

        {/* Error State */}
        {error && !loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center p-6 text-center gap-3 bg-background">
            <div className="w-10 h-10 rounded-full bg-danger/10 border border-danger/40 flex items-center justify-center text-danger">
              <AlertCircle className="w-5 h-5" />
            </div>
            <div className="max-w-md flex flex-col gap-1">
              <span className="font-mono text-[12px] font-semibold text-danger uppercase">
                {t.demoLoadFailed}
              </span>
              <p className="text-[13px] text-muted-foreground">{error}</p>
            </div>
            <button
              type="button"
              onClick={handleReload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 mt-2 text-[12px] font-mono text-foreground bg-accent hover:bg-border border border-border rounded transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              {t.tryAgain}
            </button>
          </div>
        )}

        {/* Sandboxed Interactive Iframe: allow-scripts only, NEVER allow-same-origin (opaque origin). */}
        {htmlContent && !error && (
          <iframe
            key={reloadKey}
            sandbox="allow-scripts"
            srcDoc={htmlContent}
            title={title || t.demoIframeTitle}
            className="w-full h-full border-none bg-background block"
          />
        )}
      </div>
    </div>
  );
}

export default DemoIframe;
