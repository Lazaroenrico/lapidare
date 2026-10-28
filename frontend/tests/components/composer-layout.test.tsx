import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { ComposerControls, ComposerField, ComposerSendButton, EffortMenu, ModeToggle } from "@/components/composer-parts";
import { PracticeDock } from "@/components/practice-session";
import { dockState } from "@/lib/practice";
import { render } from "./render";

test("ModeToggle marks the current mode", () => {
  const html = render(<ModeToggle mode="PRACTICE" onChange={() => {}} />);
  assert.match(html, /aria-pressed="false"[^>]*>TEACH</);
  assert.match(html, /aria-pressed="true"[^>]*>PRACTICE</);
});

test("ComposerField puts the action inside the rounded box", () => {
  const html = render(
    <ComposerField
      placeholder="O que você quer aprender?"
      onChange={() => {}}
      value=""
      action={<ComposerSendButton onClick={() => {}} disabled label="Enviar" />}
    />,
  );
  assert.ok(html.includes("rounded-2xl"));
  assert.ok(html.indexOf("<textarea") < html.indexOf('aria-label="Enviar"'));
});

test("EffortMenu shows the pinned effort and disables the menu", () => {
  const html = render(<EffortMenu value="medium" pinned="low" disabled={false} onChange={() => {}} />);
  assert.ok(html.includes(' disabled=""'));
});

test("ComposerControls keeps the row order: mode · spacer · model", () => {
  const html = render(<ComposerControls mode={<i>mode</i>} mic={null} model={<b>model</b>} />);
  assert.ok(html.indexOf("mode") < html.indexOf("flex-1") && html.indexOf("flex-1") < html.indexOf("model"));
});

test("PracticeDock uses the Home composer layout with the chat's toggle and model slots", () => {
  const state = dockState({ activeProblemId: "p1", executionStatus: "idle", sending: false, pendingQuiz: false });
  const html = render(
    <PracticeDock
      state={state}
      pendingQuiz={false}
      onSubmit={async () => true}
      onRequestDismiss={() => {}}
      modeToggle={<ModeToggle mode="PRACTICE" onChange={() => {}} />}
      modelControls={<span>gemini-3.8-flash</span>}
    />,
  );
  assert.ok(html.includes('id="practice-dock-input"'));
  assert.ok(html.includes("rounded-2xl"));
  assert.match(html, /aria-pressed="true"[^>]*>PRACTICE</);
  assert.ok(html.includes("gemini-3.8-flash"));
});
