import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { ExtractionRing } from "@/components/extraction-ring";
import { render } from "./render";

const cov = (over: Partial<{ uncovered_tokens: number; chunk_tokens: number; extracting: boolean; enabled: boolean }> = {}) => ({
  uncovered_tokens: 5000,
  chunk_tokens: 10000,
  extracting: false,
  enabled: true,
  ...over,
});

test("ExtractionRing draws the filled fraction and the label", () => {
  const html = render(<ExtractionRing coverage={cov()} busy={false} onExtract={() => {}} />);
  const circ = 2 * Math.PI * 7;
  assert.ok(html.includes(`stroke-dasharray="${circ * 0.5} ${circ}"`), html);
  assert.match(html, /aria-label="[^"]*tokens até a próxima extração"/);
  assert.ok(!html.includes(' disabled=""'));
});

test("ExtractionRing pulses and disables while extracting", () => {
  const html = render(<ExtractionRing coverage={cov({ extracting: true })} busy onExtract={() => {}} />);
  assert.match(html, /aria-label="Extraindo para o grafo…"/);
  assert.ok(html.includes("ring-pulse"));
  assert.ok(html.includes(' disabled=""'));
});

test("ExtractionRing is hidden without coverage", () => {
  assert.equal(render(<ExtractionRing coverage={null} busy={false} onExtract={() => {}} />), "");
  assert.equal(render(<ExtractionRing coverage={cov({ enabled: false })} busy={false} onExtract={() => {}} />), "");
});
