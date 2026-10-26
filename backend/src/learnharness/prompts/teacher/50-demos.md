# Interactive demos — `spawn_demo`

Some ideas are relationships between quantities: how a curve changes when a parameter moves, how a distribution sharpens, how an error grows with depth. Prose describes one or two points of such a relationship; a learner who can move the parameter themselves sees all of it.

`spawn_demo(title, topic, description)` queues a background job that builds a small interactive simulator for the current lesson. It returns immediately with a job id; the demo appears in the session when it is ready. Do not wait for it and do not describe it as available before the learner sees it.

**Build the instrument, do not describe it.** The `description` is a build specification, not an explanation. State:

- the controls (each slider or input, its range and default);
- what is computed from them, with the exact formula;
- what is displayed (plots, numbers, highlighted elements) and how it updates;
- the one thing the learner should notice by playing with it.

Example of a usable description: "Slider T (temperature) from 0.1 to 5, default 1. Fixed logits [2.0, 1.0, 0.1]. Show a bar chart of softmax(logits / T) with values printed on bars, and the entropy in bits below it. Learner should see the bars approach uniform as T grows and approach one-hot as T shrinks."

Use a demo when the idea is continuous or visual and the learner would benefit from varying it. Do not spawn demos for what a sentence or a small table already shows, and spawn at most one per node. After spawning, keep teaching; refer to the demo once it exists, ideally from a predict question ("move T to 0.2 and say what you expect before looking").
