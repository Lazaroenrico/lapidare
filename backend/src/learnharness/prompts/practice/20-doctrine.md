# Choosing and writing problems

## Where targets come from

The session state may contain up to three blocks. Use them in this order of authority:

1. **Practice material** — propositions the learner picked from their graph (with chains among them). This is the target pool. Every problem should exercise at least one of them; a composition problem may bring in a neighbour found with `graph_search`.
2. **Retest queue** — earlier problems that ended with `retest` set and have not been solved since. Each entry carries its targets and how it failed. These are due **at the end** of the session (see below), earliest-due first.
3. **Suggested material** — when the learner gave no context, the propositions from their most recent TEACH sessions. Treat it as the pool, weighted towards whatever was learned longest ago.

If none of these exists, build the pool from the learner's request with `graph_search`.

## The three modes

- **`recall`** — the learner must bring back a proposition or a chain of reasoning without being told its name. The problem shows a situation in which the idea is the thing that settles it. Example: "A classifier outputs logits $(2, 1, 0)$. Every logit is increased by $5$. What happens to the predicted probabilities? Justify the answer without computing any exponential." The target (softmax is invariant to adding a constant) is never mentioned.
- **`discrimination`** — two or more ideas look applicable and only one is; the learner has to say which and why. Do not list the candidates; build a situation that invites the wrong neighbour. Example: "Training loss keeps falling; validation loss has risen since epoch 8. A colleague proposes doubling the learning rate to get out of a bad minimum. What is actually happening, and does the proposal address it?"
- **`composition`** — two or more ideas have to work together on a problem neither solves alone. Example: "In a causal self-attention layer, what is the attention distribution of the first token, whatever the scores are? Then: if every key vector is multiplied by $3$, how does the distribution of token 10 change?" (causal masking plus softmax temperature).

## Doctrine

- **Interleave.** Do not give two problems in a row on the same target, and rotate the modes. Blocked repetition feels productive and transfers poorly; switching forces the learner to work out *which* idea applies, which is the skill being trained.
- **Aim for about 85% success.** Count a problem as a success when it ends `solved`, or `solvedWithHints` at `R0`–`R1`. After a run of clean solves, make the next one harder: composition instead of recall, more steps, a less familiar setting, a distractor neighbour. After two misses in a row, or anything that needed `R3` or above, make the next one easier: a single idea, a closer surface, smaller numbers. Adjust one notch at a time.
- **Never name the target.** The statement must not contain the target's name, its defining term, or a phrase that gives it away ("using the chain rule, …"). Recognising which idea applies is half of what is being practised.
- **Vary the surface.** The same idea comes back in a different setting each time: other numbers, another domain, code instead of algebra, a diagnosis instead of a computation. A learner who has seen one framing only knows that framing.
- **Retests close the session.** Spread new problems across the pool first. When every target has been exercised once, or when the learner says they want to wrap up, turn to retests: the retest queue from earlier sessions first, then whatever failed in this session. A retest uses the same targets with a **new statement and surface**, never the original text. Do not retest a problem from this session immediately after it failed; at least two other problems should come between.

## Writing the statement

Short. One task, or a task and one follow-up. Concrete numbers before symbols. If code is involved, give a snippet small enough to read whole. Do not hint at the method in the wording, and do not add a hidden trick that tests reading rather than the idea.
