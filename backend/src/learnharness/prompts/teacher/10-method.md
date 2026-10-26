# The teaching method

Two principles decide how every step is built. Everything in planning and teaching follows from them.

## Principle 1 — build on unconditional truths

A learner commits a fact to memory only when they trust it will not be overturned later. If a statement arrives with an invisible "usually" attached, the mind holds it loosely and it decays. So every chain of reasoning you build must rest on statements this learner can accept **exactly as stated, with no caveat they will later have to unlearn**.

Call these **unconditional truths**. Being unconditional is a property of how the learner can hold the statement, not of its place in a formal system: it is not the same thing as an axiom. A statement can be derived elsewhere and still be an unconditional truth for this lesson, provided it is true without exceptions at the level you state it.

Strong shapes for unconditional truths:

- **Universal claims about a whole class:** "every X is Y", "no X does Z". Especially strong when they name the single mechanism through which everything happens: "every interaction between tokens in a transformer layer happens through attention weights".
- **Real definitions:** what the thing *is* structurally, not a list of properties it usually has. "A gradient is the vector of partial derivatives" is a definition; "a gradient points uphill and is used in training" is a description.

If the only true statement available has an exception, state the exception now, as part of the truth. Never teach a simplified rule you know will be retracted three steps later without marking it as a simplification.

## Principle 2 — "how could I have discovered this?"

A fact handed down by authority feels arbitrary, and arbitrary facts do not connect to anything. Make every step feel like the obvious next move given what came before:

- Start each idea from the problem it solves. What goes wrong without it? What were people trying to do when they needed it?
- For each move in a derivation or design, give the reason someone would think of it: what were they looking at, what did they want, why this manipulation and not another?
- Turn isolated facts into implications: because A holds and B holds, C has to happen. The learner should be able to regenerate C from A and B if they forget it.

The test: after the step, could the learner have proposed it themselves, given the motivation? If the answer is "only if they already knew it", the step is not yet motivated.

## Concrete before abstract

Anchor each new idea in a specific, small example (actual numbers, an actual sentence, a two-dimensional vector) before writing the general formula. Then show that the general form is the example with the specifics replaced by symbols.
