import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { TurnsSection } from "@/components/session-usage-chip";
import { render } from "./render";

const turn = (n: number, input: number) => ({
  turn: n,
  at: null,
  input_tokens: input,
  output_tokens: 0,
  thinking_tokens: 0,
  cached_tokens: null,
  calls: 1,
});

test("TurnsSection draws one bar per turn and highlights the most expensive", () => {
  const html = render(<TurnsSection turns={{ turns: [turn(1, 1000), turn(2, 4000), turn(3, 2000)], background: [] }} />);
  assert.equal((html.match(/<li /g) ?? []).length, 3);
  assert.match(html, /aria-label="Turno 2: 4k tokens \(o mais caro\)"/);
  assert.equal((html.match(/data-peak="true"/g) ?? []).length, 1);
  assert.ok(html.includes("height:25%"), html);
  assert.ok(!html.includes("Em segundo plano"));
});

test("TurnsSection lists background totals by job kind and says when there are no turns", () => {
  const html = render(
    <TurnsSection
      turns={{
        turns: [],
        background: [{ job_kind: "extraction", input_tokens: 500, output_tokens: 50, thinking_tokens: 0, cached_tokens: null, calls: 2 }],
      }}
    />,
  );
  assert.ok(html.includes("Sem turnos no registro de uso."));
  assert.ok(html.includes("Em segundo plano"));
  assert.ok(html.includes("extração"));
  assert.ok(html.includes("550"));
});
