import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { UpdateBanner, UpdateBannerView } from "@/components/update-banner";
import type { UpdateState } from "@/lib/updates";
import { render } from "./render";

const noop = () => {};
const st = (over: Partial<UpdateState>): UpdateState => ({ status: "idle", mode: "notify", autoUpdate: true, ...over });
const view = (state: UpdateState | null, locale = "pt-BR") =>
  render(<UpdateBannerView state={state} locale={locale} onRestart={noop} onOpenRelease={noop} />);

test("staged shows restart", () => {
  const html = view(st({ status: "staged", mode: "auto" }));
  assert.ok(html.includes("Atualização pronta."));
  assert.ok(html.includes(">Reiniciar<"));
  assert.ok(html.includes('href="/settings"'));
});

test("available in notify mode shows version and download", () => {
  const html = view(st({ status: "available", version: "1.2.3" }));
  assert.ok(html.includes("Versão 1.2.3 disponível."));
  assert.ok(html.includes(">Baixar<"));
});

test("english strings", () => {
  const html = view(st({ status: "available", version: "1.2.3" }), "en");
  assert.ok(html.includes("Version 1.2.3 available."));
  assert.ok(html.includes(">Download<"));
});

test("hidden for other states, auto-available, and null", () => {
  for (const s of [st({ status: "idle" }), st({ status: "checking" }), st({ status: "error" }), st({ status: "downloading" }), st({ status: "available", mode: "auto" }), null]) {
    assert.equal(view(s), "");
  }
});

test("banner is not dismissable and the connected component is hidden outside the desktop", () => {
  assert.ok(!view(st({ status: "staged" })).includes("Dispensar"));
  assert.equal(render(<UpdateBanner />), "");
});
