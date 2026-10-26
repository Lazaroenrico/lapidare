"""Engine-backed generation/grading with deterministic test doubles only."""
import asyncio
import json
from pathlib import Path

import pytest
from learnharness.core.contracts.practice import PracticeProblem, PracticeAttemptGrade
from learnharness.pipelines.practice_gen import run_practice_generation_pipeline, grade_practice_attempt


class FakeEngine:
    def __init__(self):
        self.calls = []
        self.active = self.peak = 0

    async def run_structured(self, prompt, schema, **kwargs):
        self.calls.append((prompt, schema, kwargs))
        self.active += 1
        self.peak = max(self.peak, self.active)
        await asyncio.sleep(0.01)
        self.active -= 1
        if schema is PracticeProblem:
            topic = json.loads(prompt)["topic"]
            return schema.model_validate({
                "problem_id": "provider-id", "topic": topic, "prompt": "Explain the mechanism of " + topic,
                "committed_solution": "The keys and values from earlier tokens are reused by later attention steps.",
                "rubric": [{"id":"mechanism", "description":"Correct mechanism", "max_points": 6},
                    {"id":"limit", "description":"Correct limitation", "max_points":4}],
                "hints": [{"level":f"R{i}", "label":f"Step {i}", "prompt":f"Trace token {i+1}; which tensors change?"} for i in range(6)],
                "target_misconception":"Confusing cached values with output tokens"})
        return schema.model_validate({"problem_id":"provider-id", "score":2, "max_score":10,
            "criterion_scores":{"mechanism":2,"limit":0}, "feedback":"Explain how prior tensors are reused.", "passed":False})


def _populate_quiz_log(vault_path: Path) -> None:
    """Helper to write realistic quiz calibration logs into .harness/quiz-log.jsonl."""
    harness_dir = vault_path / ".harness"
    harness_dir.mkdir(parents=True, exist_ok=True)
    quiz_log = harness_dir / "quiz-log.jsonl"

    records = [
        # Topic 1: Calibrated mastery (should NOT be prioritized)
        {
            "quiz_id": "q-1",
            "session_id": "s-1",
            "topic": "Mastered Concept",
            "node_id": "mastered-concept",
            "correct": True,
            "is_dont_know": False,
            "chosen_index": 0,
            "correct_index": 0,
            "confidence": 95,
            "confidence_band": "high",
            "calibration_band": "calibrated_mastery",
            "learner_thinking": "Clear memory",
            "pedagogical_directive": "Advance",
            "explanation": "Correct",
            "timestamp": "2026-10-26T10:00:00Z",
        },
        # Topic 2: Illusion of competence (highest pedagogical priority!)
        {
            "quiz_id": "q-2",
            "session_id": "s-1",
            "topic": "Illusion KV Cache",
            "node_id": "illusion-kv-cache",
            "correct": False,
            "is_dont_know": False,
            "chosen_index": 1,
            "correct_index": 2,
            "confidence": 85,
            "confidence_band": "high",
            "calibration_band": "illusion_of_competence",
            "learner_thinking": "Assumed memory was linear without check",
            "pedagogical_directive": "Counterexample required",
            "explanation": "Misconception about cache indexing",
            "timestamp": "2026-10-26T10:05:00Z",
        },
        # Topic 3: Conscious gap (error with low confidence)
        {
            "quiz_id": "q-3",
            "session_id": "s-1",
            "topic": "Conscious Gap Embeddings",
            "node_id": "conscious-gap-embeddings",
            "correct": False,
            "is_dont_know": True,
            "chosen_index": None,
            "correct_index": 3,
            "confidence": 20,
            "confidence_band": "low",
            "calibration_band": "conscious_gap",
            "learner_thinking": "Not sure about dimensional projection",
            "pedagogical_directive": "Build foundation",
            "explanation": "Projection needs clarification",
            "timestamp": "2026-10-26T10:10:00Z",
        },
    ]

    lines = [json.dumps(r) + "\n" for r in records]
    quiz_log.write_text("".join(lines), encoding="utf-8")



async def test_priorities_and_committed_parallel_generation(tmp_path):
    _populate_quiz_log(tmp_path)
    engine = FakeEngine()
    result = await asyncio.wait_for(run_practice_generation_pipeline(tmp_path, engine=engine), 3)
    assert result.target_topics[0] == "Illusion KV Cache"
    assert engine.peak > 1
    for problem in result.problems:
        assert problem.committed_solution
        assert sum(c.max_points for c in problem.rubric) == 10
        assert [h.level for h in problem.hints] == [f"R{i}" for i in range(6)]
        assert all(problem.committed_solution not in h.prompt for h in problem.hints)
    assert all("Even R5" in call[2]["system_instruction"] for call in engine.calls)


async def test_explicit_topics_and_real_grading(tmp_path):
    engine = FakeEngine()
    result = await run_practice_generation_pipeline(tmp_path, ["Attention", "KV Cache"], engine=engine)
    assert result.target_topics == ["Attention", "KV Cache"]
    answer = "invariant mechanism memory edge limit state " * 50
    grade = await grade_practice_attempt(result.problems[0], answer, engine)
    assert grade.score == 2  # Keyword stuffing earns no automatic credit.
    assert grade.problem_id == result.problems[0].problem_id
    assert json.loads(engine.calls[-1][0])["learner_answer"] == answer


async def test_missing_engine_and_provider_failure(tmp_path):
    with pytest.raises(ValueError, match="configured engine"):
        await run_practice_generation_pipeline(tmp_path, ["Attention"])
    class Broken:
        async def run_structured(self, **kwargs):
            raise RuntimeError("provider unavailable")
    with pytest.raises(RuntimeError, match="provider unavailable"):
        await run_practice_generation_pipeline(tmp_path, ["Attention"], engine=Broken())


async def test_reject_inconsistent_grade(tmp_path):
    engine = FakeEngine()
    problem = (await run_practice_generation_pipeline(tmp_path, ["Attention"], engine=engine)).problems[0]
    class WrongGrade:
        async def run_structured(self, **kwargs):
            return PracticeAttemptGrade(problem_id="x", score=10, criterion_scores={"mechanism":2,"limit":0}, feedback="x", passed=True)
    with pytest.raises(ValueError, match="total"):
        await grade_practice_attempt(problem, "my answer", WrongGrade())


async def test_reject_solution_leaking_hint(tmp_path):
    class LeakingEngine(FakeEngine):
        async def run_structured(self, **kwargs):
            problem = await super().run_structured(**kwargs)
            problem.hints[-1].prompt = problem.committed_solution
            return problem
    with pytest.raises(ValueError, match="disclose"):
        await run_practice_generation_pipeline(tmp_path, ["Attention"], engine=LeakingEngine())
