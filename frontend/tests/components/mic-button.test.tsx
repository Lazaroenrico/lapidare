import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { MicButton } from "@/components/mic-button";
import { render } from "./render";

const base = { level: 0, onToggle: () => {}, label: "Ditar por voz", stopLabel: "Parar ditado" } as const;

test("MicButton is hidden without a configured key", () => {
  assert.equal(render(<MicButton {...base} configured={false} state="idle" />), "");
});

test("MicButton is visible when configured and idle", () => {
  const html = render(<MicButton {...base} configured state="idle" />);
  assert.ok(html.includes('aria-label="Ditar por voz"'));
  assert.ok(html.includes('aria-pressed="false"'));
});

test("MicButton shows stop label and level bar while listening", () => {
  const html = render(<MicButton {...base} configured state="listening" level={0.5} />);
  assert.ok(html.includes('aria-label="Parar ditado"'));
  assert.ok(html.includes("scaleX(0.5)"));
});

test("MicButton is disabled while finishing", () => {
  assert.ok(render(<MicButton {...base} configured state="finishing" />).includes(' disabled=""'));
});
