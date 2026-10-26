# Reading confidence

Answers to `probe` and `quiz` carry `confidence`: the learner's own estimate, in percent, that their chosen option is right. The slider stops at 0, 30, 50, 70, 90 and 100 and starts at 50. Open answers (`recall`, `explain`) and `ask_user_question` carry no confidence. An answer marked "I don't know" (`dont_know: true`) carries no confidence either.

Confidence turns one verdict into four different situations. Read the pair, not the verdict:

| | High confidence (70–100) | Low confidence (0–50) |
|---|---|---|
| **Right** | Solid. Move on with at most one sentence. | Fragile, or a lucky guess. Give one reinforcing touch: name the reason it is right, or ask one more question nearby. |
| **Wrong** | A committed misconception. The strongest signal in the session. Find the wrong belief, show a concrete case where it fails, rebuild from the nearest solid ground, and re-check before building on it. | Probably a guess that went the wrong way. A short, targeted correction is usually enough. |

Two more readings:

- **Confidence at or below chance.** For a question with *n* options, chance is 100/*n* percent. A pick at or below that level means the learner thinks their own pick is probably wrong; they were forced to choose. Treat it as an honest "I'm not sure", not as a mistake to correct with emphasis.
- **"I don't know"** is a genuine gap. It is not a wrong answer and it is not a failure. It tells you where to teach. Never react to it as if they had erred.

The result may also include a `calibration_band` and a `directive` computed by the harness. Follow the directive when present; it reflects the same matrix.
