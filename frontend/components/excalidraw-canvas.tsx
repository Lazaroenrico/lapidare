"use client";

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import "@excalidraw/excalidraw/index.css";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react";
import { getDrawing, saveDrawing } from "@/lib/api";
import { useEventSubscription } from "./server-events";

// Dynamically import Excalidraw with ssr: false so Next.js SSR builds cleanly without "window is not defined"
const ExcalidrawComponent = dynamic(
  async () => {
    const mod = await import("@excalidraw/excalidraw");
    return mod.Excalidraw;
  },
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center bg-[#141414] text-[#8d8d8d] font-ui text-xs">
        <div className="flex flex-col items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#434343] border-t-[#e6e6e6]" />
          <span>Carregando canvas Excalidraw...</span>
        </div>
      </div>
    ),
  }
);

export interface ExcalidrawCanvasHandle {
  /** Explicitly save scene and export PNG preview to Vault */
  save: () => Promise<boolean>;
  /** Retrieve latest scene elements and appState */
  getSceneData: () => { elements: unknown[]; appState: unknown } | null;
  /** Generate a PNG data-URL base64 export */
  generatePngBase64: () => Promise<string | null>;
  /** Reload scene from Vault */
  reload: () => Promise<void>;
  /** Check if there are unsaved modifications */
  isDirty: () => boolean;
  /** Check if a save operation is in flight */
  isSaving: () => boolean;
}

export interface DrawingLoadedMeta {
  slug: string;
  title: string;
  prompt?: string;
  filePath: string;
  elements: unknown[];
  appState?: unknown;
}

export interface ExcalidrawCanvasProps {
  slug: string;
  onDrawingLoaded?: (meta: DrawingLoadedMeta) => void;
  onSaveSuccess?: () => void;
  onSaveError?: (error: Error) => void;
  autoSaveDebounceMs?: number;
  showToolbarControls?: boolean;
  className?: string;
}

export const ExcalidrawCanvas = forwardRef<
  ExcalidrawCanvasHandle,
  ExcalidrawCanvasProps
>(function ExcalidrawCanvas(
  {
    slug,
    onDrawingLoaded,
    onSaveSuccess,
    onSaveError,
    autoSaveDebounceMs = 2500,
    showToolbarControls = true,
    className = "",
  },
  ref
) {
  const [initialDataLoaded, setInitialDataLoaded] = useState<boolean>(false);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [externalEditDetected, setExternalEditDetected] = useState<boolean>(false);

  // Imperative Excalidraw API and state references
  const [excalidrawAPI, setExcalidrawAPI] = useState<any>(null);
  const apiRef = useRef<any>(null);
  const initialElementsRef = useRef<any[]>([]);
  const latestElementsRef = useRef<readonly any[]>([]);
  const latestAppStateRef = useRef<any>({
    theme: "dark",
    viewBackgroundColor: "#141414",
  });
  const latestFilesRef = useRef<any>({});
  const filePathRef = useRef<string>("");
  const isDirtyRef = useRef<boolean>(false);
  const isSavingRef = useRef<boolean>(false);
  const initialLoadDoneRef = useRef<boolean>(false);
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Synchronize refs
  isDirtyRef.current = isDirty;
  isSavingRef.current = isSaving;

  /**
   * Generates a PNG data URL (base64) using Excalidraw's exportToBlob
   * with dark theme background #141414, falling back to HTML5 canvas.
   */
  const generatePngBase64 = useCallback(async (): Promise<string | null> => {
    if (typeof window === "undefined") return null;

    try {
      const elements =
        apiRef.current?.getSceneElements?.() || latestElementsRef.current || [];
      const appState =
        apiRef.current?.getAppState?.() || latestAppStateRef.current || {};
      const files =
        apiRef.current?.getFiles?.() || latestFilesRef.current || {};

      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const activeElements = Array.isArray(elements)
        ? elements.filter((el: any) => !el.isDeleted)
        : [];

      const blob = await exportToBlob({
        elements: activeElements,
        appState: {
          ...appState,
          exportBackground: true,
          viewBackgroundColor: "#141414",
          exportWithDarkMode: true,
        },
        files: files || {},
        mimeType: "image/png",
      });

      if (!blob) return null;

      return new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(reader.result as string);
        };
        reader.onerror = () => resolve("");
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      console.warn("exportToBlob failed, attempting HTML5 canvas fallback:", err);
      try {
        const canvas = document.querySelector(
          ".excalidraw__canvas"
        ) as HTMLCanvasElement | null;
        if (canvas) {
          return canvas.toDataURL("image/png");
        }
      } catch {
        // Fallback failed
      }
      return null;
    }
  }, []);

  /**
   * Saves scene elements, appState, and exported PNG preview back to the Vault.
   */
  const executeSave = useCallback(async (): Promise<boolean> => {
    if (!slug || !initialLoadDoneRef.current || isSavingRef.current) return false;
    isSavingRef.current = true;

    setIsSaving(true);
    setSaveError(null);

    // Cancel pending auto-save timeout if any
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    try {
      const elements =
        apiRef.current?.getSceneElements?.() ||
        latestElementsRef.current ||
        [];
      const appState =
        apiRef.current?.getAppState?.() || latestAppStateRef.current || {};

      let pngBase64: string | undefined = undefined;
      try {
        const png = await generatePngBase64();
        if (png && png.length > 0) {
          pngBase64 = png;
        }
      } catch (err) {
        console.warn("Could not generate PNG export preview:", err);
      }

      await saveDrawing(slug, {
        elements: Array.isArray(elements) ? [...elements] : [],
        appState: {
          ...(typeof appState === "object" && appState !== null ? appState : {}),
          theme: "dark",
          viewBackgroundColor: "#141414",
        },
        files: apiRef.current?.getFiles?.() || latestFilesRef.current,
        pngBase64,
      });

      setIsDirty(false);
      setLastSavedAt(new Date());
      setExternalEditDetected(false);
      onSaveSuccess?.();
      return true;
    } catch (err: any) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      const msg = errorObj.message || "Falha ao salvar desenho no Vault";
      setSaveError(msg);
      onSaveError?.(errorObj);
      return false;
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [slug, generatePngBase64, onSaveSuccess, onSaveError]);

  /**
   * Loads or reloads drawing data from the backend / Vault.
   */
  const loadDrawingData = useCallback(async () => {
    if (!slug) return;
    setLoadingError(null);

    try {
      const data = await getDrawing(slug);
      const elements = Array.isArray(data.elements) ? data.elements : [];
      const appState = (data as any).appState ||
        (data as any).scene?.appState || {
          theme: "dark",
          viewBackgroundColor: "#141414",
        };

      filePathRef.current = data.file_path || `Desenhos/${slug}.excalidraw.md`;
      initialElementsRef.current = elements;
      latestElementsRef.current = elements;
      latestAppStateRef.current = appState;
      latestFilesRef.current = data.files || {};

      if (apiRef.current) {
        apiRef.current.addFiles(Object.values(latestFilesRef.current));
        apiRef.current.updateScene({
          elements,
          appState: {
            ...appState,
            theme: "dark",
            viewBackgroundColor: "#141414",
          },
        });
        if (elements.length > 0 && typeof apiRef.current.scrollToContent === "function") {
          try {
            apiRef.current.scrollToContent(elements, { fitToContent: true });
          } catch {
            // Ignore scroll error
          }
        }
      }

      setInitialDataLoaded(true);
      setIsDirty(false);
      setExternalEditDetected(false);
      initialLoadDoneRef.current = true;

      onDrawingLoaded?.({
        slug,
        title: data.title || slug,
        prompt: data.prompt,
        filePath: filePathRef.current,
        elements,
        appState,
      });
    } catch (err: any) {
      console.error("Failed to load drawing from Vault:", err);
      const msg = err?.message || "Não foi possível carregar o arquivo de desenho.";
      setLoadingError(msg);
      setInitialDataLoaded(false);
      initialLoadDoneRef.current = false;
    }
  }, [slug, onDrawingLoaded]);

  // Initial load on mount or when slug changes
  useEffect(() => {
    initialLoadDoneRef.current = false;
    setInitialDataLoaded(false);
    void loadDrawingData();

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [loadDrawingData]);

  /**
   * Subscribes to vault:changed SSE notifications.
   * If external edits in Obsidian happen, notifies or refreshes on demand.
   */
  useEventSubscription("vault:changed", (event) => {
    const eventPath =
      (event.data as any)?.path || (event.data as any)?.file_path || "";

    const isMatch =
      !eventPath ||
      eventPath.includes(slug) ||
      (filePathRef.current && eventPath.includes(filePathRef.current)) ||
      eventPath.includes("Desenhos");

    if (isMatch) {
      if (isDirtyRef.current) {
        // Unsaved edits in browser: warn user and offer reload button
        setExternalEditDetected(true);
      } else {
        // Pristine: reload automatically without losing work
        void loadDrawingData();
      }
    }
  });

  /**
   * Handles user canvas edits and triggers debounced auto-save.
   */
  const handleSceneChange = useCallback(
    (elements: readonly any[], appState: any, files: any) => {
      latestElementsRef.current = elements;
      latestAppStateRef.current = appState;
      latestFilesRef.current = files;

      // Ignore changes fired during initial mount hydration
      if (!initialLoadDoneRef.current) return;

      setIsDirty(true);

      if (autoSaveDebounceMs > 0) {
        if (autoSaveTimerRef.current) {
          clearTimeout(autoSaveTimerRef.current);
        }
        autoSaveTimerRef.current = setTimeout(() => {
          void executeSave();
        }, autoSaveDebounceMs);
      }
    },
    [autoSaveDebounceMs, executeSave]
  );

  // Expose imperative handle to parent components
  useImperativeHandle(
    ref,
    () => ({
      save: executeSave,
      getSceneData: () => ({
        elements: Array.isArray(latestElementsRef.current)
          ? [...latestElementsRef.current]
          : [],
        appState: latestAppStateRef.current,
      }),
      generatePngBase64,
      reload: loadDrawingData,
      isDirty: () => isDirtyRef.current,
      isSaving: () => isSavingRef.current,
    }),
    [executeSave, generatePngBase64, loadDrawingData]
  );

  return (
    <div
      className={`relative h-full w-full bg-[#141414] overflow-hidden select-none ${className}`}
    >
      {/* External change detection banner */}
      {externalEditDetected && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 bg-[#1c1c1c] border border-amber-600/80 text-[#e6e6e6] px-3.5 py-2 rounded shadow-2xl font-ui text-xs animate-in fade-in slide-in-from-top duration-200">
          <span className="flex items-center gap-1.5 text-amber-400 font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Arquivo modificado no Obsidian
          </span>
          <button
            type="button"
            onClick={() => {
              setExternalEditDetected(false);
              void loadDrawingData();
            }}
            className="flex items-center gap-1 bg-[#2a2a2a] hover:bg-[#383838] border border-[#434343] text-[#e6e6e6] px-2.5 py-1 rounded transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Recarregar do Vault
          </button>
          <button
            type="button"
            onClick={() => setExternalEditDetected(false)}
            className="text-[#8d8d8d] hover:text-[#e6e6e6] text-[11px] underline ml-1 transition-colors"
          >
            Manter edição local
          </button>
        </div>
      )}

      {/* Floating Canvas Save & Status Overlay Toolbar */}
      {showToolbarControls && initialDataLoaded && (
        <div className="absolute top-3 right-3 z-20 flex items-center gap-2 bg-[#1c1c1c]/90 backdrop-blur border border-[#434343] px-3 py-1.5 rounded shadow-lg font-ui text-xs">
          {/* Status badge */}
          {isSaving ? (
            <span className="flex items-center gap-1.5 text-[#8d8d8d]">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#e6e6e6]" />
              <span>Salvando no Vault...</span>
            </span>
          ) : saveError ? (
            <span
              className="flex items-center gap-1 text-rose-400 truncate max-w-[200px]"
              title={saveError}
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>Erro ao salvar</span>
            </span>
          ) : isDirty ? (
            <span className="flex items-center gap-1.5 text-amber-400">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              <span>Modificado</span>
            </span>
          ) : lastSavedAt ? (
            <span
              className="flex items-center gap-1 text-[#8d8d8d]"
              title={`Último salvamento: ${lastSavedAt.toLocaleTimeString()}`}
            >
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              <span>Salvo</span>
            </span>
          ) : (
            <span className="text-[#8d8d8d]">Pronto</span>
          )}

          <div className="h-3 w-px bg-[#434343] mx-1" />

          {/* Explicit Save Button */}
          <button
            type="button"
            onClick={() => void executeSave()}
            disabled={isSaving}
            className="flex items-center gap-1.5 bg-[#2a2a2a] hover:bg-[#383838] border border-[#434343] text-[#e6e6e6] px-2.5 py-1 rounded text-[11px] font-medium transition-colors disabled:opacity-50"
            title="Salvar alterações e gerar visualização PNG no Vault"
          >
            {isSaving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            <span>Salvar no Vault</span>
          </button>
        </div>
      )}

      {/* Main Excalidraw Component */}
      {initialDataLoaded ? (
        <div className="h-full w-full">
          <ExcalidrawComponent
            theme="dark"
            excalidrawAPI={(api) => {
              setExcalidrawAPI(api);
              apiRef.current = api;
              if (initialElementsRef.current.length > 0) {
                try {
                  api.updateScene({
                    elements: initialElementsRef.current,
                    appState: {
                      theme: "dark",
                      viewBackgroundColor: "#141414",
                    },
                  });
                } catch {
                  // Scene update safe fallback
                }
              }
            }}
            initialData={{
              elements: initialElementsRef.current as any,
              files: latestFilesRef.current,
              appState: {
                theme: "dark",
                viewBackgroundColor: "#141414",
                currentItemStrokeColor: "#e6e6e6",
                currentItemBackgroundColor: "transparent",
                currentItemFillStyle: "hachure",
                currentItemStrokeWidth: 1,
                currentItemRoughness: 1,
              },
            }}
            onChange={handleSceneChange}
            gridModeEnabled={false}
            zenModeEnabled={false}
            viewModeEnabled={false}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                export: false,
                saveAsImage: false,
                toggleTheme: false,
              },
            }}
          />
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[#141414] text-[#8d8d8d] font-ui text-xs">
          {loadingError ? (
            <div className="flex flex-col items-center gap-3 max-w-sm text-center p-6 bg-[#1c1c1c] border border-[#434343] rounded">
              <AlertCircle className="h-6 w-6 text-rose-400" />
              <p className="text-[#e6e6e6]">{loadingError}</p>
              <button
                type="button"
                onClick={() => void loadDrawingData()}
                className="flex items-center gap-1.5 bg-[#2a2a2a] hover:bg-[#383838] border border-[#434343] text-[#e6e6e6] px-3 py-1.5 rounded font-ui text-xs transition-colors"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Tentar novamente
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#434343] border-t-[#e6e6e6]" />
              <span>Carregando dados do desenho...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
