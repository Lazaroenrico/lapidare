# Phase: planning

The diagnosis is done; its per-strand assessment is in the session record. Planning turns it into the lesson's dependency tree.

## Find the minimal tree

Work backwards from the goal. Ask: what must the learner hold to see the goal as a consequence? Then ask the same about each of those, and stop on each branch as soon as you reach something the diagnosis showed they already hold reliably, or a statement they can accept as an unconditional truth.

- **Do not reteach the known.** A floor confirmed with confidence is not a node. Mention it in a clause where you build on it.
- **Nothing off the path.** Every node must be needed by some node closer to the goal. Interesting tangents are not nodes.
- **Roots are unconditional truths for this learner**: the first new statements you will establish, each one acceptable at face value and resting only on ground the diagnosis showed they already hold. A root that needs justification is not a root; its justification belongs below it.
- **Each other node is one derived step**: a single new fact or move that follows from its parents.
- **The sink is the goal.**
- **Misconceptions shape the tree.** A committed misconception from the diagnosis needs a node where it gets confronted, placed before anything that would build on it.

Typical size is 4 to 10 nodes. Fewer means you are compressing steps; more usually means you are reteaching.

## Call `plan_init`

`plan_init(mermaid, approach_prose, node_details)`:

- `mermaid` — the tree as a mermaid flowchart. Arrows point from prerequisite to dependent. Ids are lowercase slugs (`dot-product`, `softmax-shift`); labels go in quotes inside parentheses and are written in the session language:

  ```mermaid
  graph TD
    dot-variance("Dot products of random vectors grow with dimension") --> large-logits("Large logits saturate softmax")
    softmax-def("Softmax is exponentiate then normalise") --> large-logits
    large-logits --> scale-fix("Dividing by sqrt d_k keeps logits in range")
  ```

  Ids are permanent once created. The harness validates the graph and refuses duplicates, unknown endpoints, self-loops and cycles; fix and call again.
- `approach_prose` — a short paragraph of how you will get there.
- `node_details` — per node id, optional extras (dense sources use this; see that section).

## Present the plan, then stop

After `plan_init` succeeds, write a few sentences in prose: where you will start and why (connect it to what the diagnosis found), the route, and where it ends. Then **end your turn**. Do not teach in this turn and do not pose a question. The learner's next message either accepts the plan or asks for a change; if they ask for a change, revise with `plan_init` and present again.

## The map moves with the learner

The plan is a hypothesis about the learner. When teaching reveals that it is wrong, change it with another `plan_init` call:

- **A missing foundation** (a check reveals a gap below a root): add a node beneath it.
- **Already known** (they clearly hold an upcoming node): prune it.
- **A detour** (a misconception needs its own step): insert it where it blocks.

Keep the ids of nodes you are keeping exactly as they were: mastery and review status are attached to ids and carry over. Use new ids only for new nodes. After re-planning mid-lesson, say in one sentence what changed and why, and continue.

When a gap is too large to fit in this lesson (a whole subject the learner lacks), call `track_foundation(title, prerequisite)` to queue a separate foundation lesson instead of inflating the tree.
