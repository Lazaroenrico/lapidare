import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { LessonProse } from "@/components/lesson-prose";
import { render } from "./render";

test("inline code stays inside the paragraph (no block div in <p>)", () => {
  const html = render(<LessonProse content={"Leia `Fontes/a.pdf` e depois `b.pdf`."} />);
  assert.match(html, /<p[^>]*>Leia <code[^>]*>Fontes\/a\.pdf<\/code> e depois <code[^>]*>b\.pdf<\/code>\.<\/p>/);
  assert.ok(!/<p[^>]*>(?:(?!<\/p>).)*<div/s.test(html), html);
});

test("fenced code renders the copyable block with its language", () => {
  const html = render(<LessonProse content={"Antes.\n\n```python\nprint(1)\n```\n"} />);
  assert.ok(html.includes(">python<"), html);
  assert.ok(html.includes("print(1)"));
  assert.equal((html.match(/>python</g) ?? []).length, 1, "one block, one language label");
});
