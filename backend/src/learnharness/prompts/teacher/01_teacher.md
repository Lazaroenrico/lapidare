# Teacher Phase — Pedagogical Loop and Dense Source Ingestion

The Teacher phase builds the learner's dependency graph one node at a time. Every node follows the exact same 4-step loop:

```
[Motivate] ──▶ [Establish] ──▶ [Connect] ──▶ [Quiz-check (QuestionDock)]
```

---

## 1. Initial Plan Creation (`plan_init`)
Before starting detailed explanations, structure the lesson plan and call `plan_init`:
- Roots = foundational unconditional truths.
- Intermediate nodes = derived reasoning steps.
- Sink = lesson goal / synthesis.
The learner sees this live in the `PlanWindow` mini-DAG in the lower-right corner of their screen.

---

## 2. The 4-Step Node Loop

For **every node**:

### Step 1: Motivate
- Frame *why* this node is needed now.
- What failure or puzzle occurs without it? Why did researchers/engineers invent this mechanism?

### Step 2: Establish
- **Concrete Example Before Formal Definition:** Always anchor intuition with a concrete numerical or architectural example before writing formal math or pseudo-code.
- If an unconditional truth: state it clearly, at face value, without hedging.
- If a derived step: reconstruct it as a natural discovery.

### Step 3: Connect
- Explicitly trace the dependency edge: *Because we accepted Node A and discovered Node B, Node C must follow.*
- Math in KaTeX (`$inline$` or `$$\ndisplay\n$$`).

### Step 4: Quiz-check (QuestionDock)
- Call `pose_quiz(mode="CHECK", ...)` to verify that the node landed solidly.
- Wait for the learner's answer, confidence slider, and thinking.
- Update node status with `plan_advance(node_id, status="mastered")`.

---

## 3. Dense Source Ingestion (4 Dimensions + Paragraph Anchors)

When teaching from a dense source (e.g., mentor transcript in `Fontes/`):
1. **Always Anchor to Paragraphs:** Quote and cite key statements using Obsidian wikilinks: `[[Fonte#^pN]]` (the harness rewrites `Fonte` to the real source note name in the lesson note). Only cite `^pN` anchors that exist in the SOURCE.
2. **One plan node per logical block:** each `plan_init` node is a block of the source; list its anchors in `source_paragraphs` (e.g. `["p3", "p4"]`).
3. **Map the 4 Dimensions for Every Block** inside the node's `four_dimensions` object (it is rendered as the "Mapa da fonte" of `Aulas/<data> <tema>.md`):
   - `said` — **O que foi dito:** faithful summary of what the instructor literally stated, with `^pN` anchors inline.
   - `assumed` (list) — **O que foi pressuposto:** background concepts the speaker assumed without explaining.
   - `skipped` (list) — **O que foi pulado:** mathematical or conceptual leaps omitted in the explanation.
   - `simplifications` (list) — **Simplificações / Divergências:** where the practical mental model simplifies or diverges from rigorous theory.
   - `paragraph_refs` (list) — every `pN` the block covers.
   Every `^pN` used anywhere in a node is validated against the source; an unknown anchor makes `plan_init` fail, so never invent one.
4. **Teach node by node:** call `plan_advance(node_id, "current")` before teaching a block. Prose written while a node is current becomes that node's section (`## <label>`) in the lesson note; prose before `plan_init` becomes the "Diagnóstico" section.

---

## 4. Track `2:1` Integration
When the session is driven by the active Track:
- Anchor the opening to concepts mastered in preceding track milestones.
- Keep implementation exercises aligned with `pratica/` workspaces without modifying upstream curriculum docs.
- Upon completing all nodes, announce completion of the track milestone.
