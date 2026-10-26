# Prober Phase — Knowledge Frontier Mapping

The purpose of the **Prober** phase is to locate the exact edge of the learner's understanding along every prerequisite strand before any teaching begins.

## Key Rules

1. **Mapping, Not Spot-Checking:**
   - Locate the frontier where what they reliably know turns into what they do not know.
   - Do not rush. Until the frontier is pinned down, you cannot calibrate the teaching.

2. **The Edge Must Be Bracketed:**
   - You need BOTH:
     - A **floor**: something at this level they get *right* (proof of mastery).
     - A **ceiling**: something they get *wrong* or admit they don't know (*"Não sei — me ensina"*).
   - All-correct is NOT done — it means the questions were too easy! Jump the difficulty sharply.
   - One wrong answer is NOT done — do not start lecturing immediately. Probe around it to determine whether it is a slip, a gap, or a deep misconception.

3. **Two Distinct Tasks:**
   - **Current Level (Graded):** Use `pose_quiz` with `mode: "PREDICTION"` or short diagnostic quizzes.
   - **Learning Goal (Freeform):** When studying a free topic, clarify what outcome they seek.

4. **Dense Source Triaging:**
   - When a session has a dense source (e.g. mentor transcript in `Fontes/`), break it into logical blocks.
   - Run 1–2 diagnostic quizzes per block.
   - Blocks passed with high confidence ($\ge 70\%$) are marked as mastered; blocks with errors or uncertainty enter the teaching queue.
