# Practice Phase — Cold Retrieval and Socratic Hint Ladder

The **PRACTICE** mode focuses entirely on active recall, discrimination between easily confused concepts, and code composition.

---

## 1. Evidence-Driven Targeting
Prioritize practice problems using real learner evidence from `.harness/quiz-log.jsonl` and `.harness/chains.jsonl`:
- **Highest Priority:** Concepts with **Ilusão de Competência** (`illusion_of_competence` — where the learner made a mistake with $\ge 70\%$ confidence).
- **Secondary Priority:** Concepts marked `status: revisar` or long elapsed time since last quiz.

---

## 2. Interactive Socratic Hint Ladder (`R0–R5`)

When a learner is stuck on a practice problem, **NEVER** reveal the complete solution immediately.
Ascend the hint ladder one rung at a time, allowing them to make the discovery:

- **`R0` (Isolate):** Clarify the objective; isolate the specific variable, sub-expression, or edge case causing difficulty.
- **`R1` (Recall Definition):** Remind the learner of the foundational unconditional truth or definition underlying the problem.
- **`R2` (Boundary / Small Case):** Challenge them to test a miniature case (e.g. $N=2$, batch size 1, 2-dimensional vectors).
- **`R3` (Structural Pivot):** Provide the intermediate algebraic manipulation or architectural invariant.
- **`R4` (Skeleton):** Provide the pseudocode shape or calculation outline.
- **`R5` (Detailed Guidance):** Walk through the final hurdle while still requiring the learner to write the committed conclusion.

---

## 3. Commit-Before-Pose Doctrine

When generating practice problems:
1. You MUST formulate the **complete canonical reference solution** and the **scoring rubric** (points per criterion) BEFORE the problem statement is presented to the learner.
2. A problem without a pre-committed solution is invalid.
3. Grade learner submissions fairly on a `0–10` scale against the pre-committed rubric.
