"use client";

import { useEventSubscription } from "@/components/server-events";
import React, { useEffect, useState } from "react";
import { GraphView } from "@/components/graph-view";
import { Composer } from "@/components/composer";
import { ImportDialog } from "@/components/import-dialog";
import { SetupDialog } from "@/components/setup-dialog";
import { getSetupStatus } from "@/lib/api";
import type { HarnessConfig, SetupStatusResponse } from "@/lib/types";

export default function HomePage() {
  const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);
  const [isSetupOpen, setIsSetupOpen] = useState<boolean>(false);
  const [isImportOpen, setIsImportOpen] = useState<boolean>(false);
  const [pendingTopic, setPendingTopic] = useState<string>("");

  const [setupError, setSetupError] = useState<string | null>(null);
  useEventSubscription(["config:updated", "vault:changed"], () => {
    getSetupStatus().then(setSetupStatus).catch(e => setSetupError(e.message));
  });

  // Fetch initial setup status on boot
  useEffect(() => {
    let mounted = true;
    const checkSetup = async () => {
      try {
        const status = await getSetupStatus();
        if (mounted) {
          setSetupStatus(status);
        }
      } catch (err) {
        setSetupError(err instanceof Error ? err.message : "Setup unavailable");
      }
    };

    void checkSetup();

    return () => {
      mounted = false;
    };
  }, []);

  const isInitialized = setupStatus?.initialized ?? false;
  const trackConfig = setupStatus?.config?.track;

  // Intercept submission when uninitialized: preserve typed text and open Setup
  const handleOpenSetupWithTopic = (text?: string) => {
    if (text) {
      setPendingTopic(text);
    }
    setIsSetupOpen(true);
  };

  const handleSetupComplete = (newConfig: HarnessConfig) => {
    setSetupStatus((prev) => ({
      initialized: true,
      config: newConfig,
      connectors: prev?.connectors || [],
    }));
    setIsSetupOpen(false);
  };

  return (
    <div className="relative w-full h-full flex flex-col overflow-hidden bg-[#141414]">
      {setupError && <p role="alert" className="p-4 font-ui text-xs">{setupError}</p>}
      {/* Center 100%: Single Unified 2D Knowledge Graph (No Macro/Micro Toggle) */}
      <main className="flex-1 w-full h-full relative">
        <GraphView onOpenImport={() => setIsImportOpen(true)} />
      </main>

      {/* Floating Composer at Bottom-Center with Contextual Track Chip above it */}
      <div className="absolute bottom-6 left-0 right-0 px-4 pointer-events-none z-20">
        <div className="pointer-events-auto">
          <Composer
            initialized={isInitialized}
            trackConfig={trackConfig}
            initialTopic={pendingTopic}
            onOpenSetup={handleOpenSetupWithTopic}
          />
        </div>
      </div>

      {/* Import Modal guided by MCP / local notes */}
      <ImportDialog
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
      />

      {/* Onboarding / Setup Wizard Dialog */}
      <SetupDialog
        isOpen={isSetupOpen}
        onClose={() => setIsSetupOpen(false)}
        onComplete={handleSetupComplete}
      />
    </div>
  );
}
