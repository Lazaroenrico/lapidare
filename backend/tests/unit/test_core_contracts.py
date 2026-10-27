"""Unit tests for `learnharness.core` contracts, calibration matrix, and zero-I/O boundary."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest
from pydantic import ValidationError

from learnharness.core import (
    PracticeProblem,
    QuizOption,
    QuizPayload,
    QuizSubmission,
    SessionRecord,
    SseEventType,
    SseFrame,
    evaluate_calibration,
    validate_quiz_options_evenness,
)

FORBIDDEN_IMPORTS = {
    "os",
    "sys",
    "subprocess",
    "socket",
    "httpx",
    "aiohttp",
    "fastapi",
    "watchfiles",
    "langgraph",
    "aiosqlite",
    "sqlite3",
    "shutil",
    "tempfile",
}


def test_core_zero_io_ast_invariant() -> None:
    """Verify that no file in `backend/src/learnharness/core/` imports any I/O or network module."""
    core_dir = Path(__file__).resolve().parents[2] / "src" / "learnharness" / "core"
    assert core_dir.is_dir()

    py_files = list(core_dir.rglob("*.py"))
    assert len(py_files) >= 8

    for py_file in py_files:
        tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root_mod = alias.name.split(".")[0]
                    assert root_mod not in FORBIDDEN_IMPORTS, (
                        f"Forbidden import '{alias.name}' found in {py_file}"
                    )
            elif isinstance(node, ast.ImportFrom) and node.module:
                root_mod = node.module.split(".")[0]
                assert root_mod not in FORBIDDEN_IMPORTS, (
                    f"Forbidden from-import '{node.module}' found in {py_file}"
                )


def test_only_two_session_modes_allowed() -> None:
    """Ensure only TEACH and PRACTICE modes are accepted by SessionRecord."""
    s1 = SessionRecord(id="s1", title="Test", mode="TEACH", created_at="2026-10-26", updated_at="2026-10-26")
    s2 = SessionRecord(id="s2", title="Test", mode="PRACTICE", created_at="2026-10-26", updated_at="2026-10-26")
    assert s1.mode == "TEACH"
    assert s2.mode == "PRACTICE"

    with pytest.raises(ValidationError):
        SessionRecord(
            id="s3",
            title="Invalid Mode",
            mode="MENTORIA",  # type: ignore[arg-type]
            created_at="2026-10-26",
            updated_at="2026-10-26",
        )


def test_calibration_matrix_all_four_quadrants() -> None:
    """Verify the 4 calibration bands (Calibrated, Illusion of Competence, Fragile Intuition, Conscious Gap)."""
    quiz = QuizPayload(
        quiz_id="q1",
        session_id="sess1",
        topic="Chain-of-thought",
        mode="PREDICTION",
        question="Em structured output, qual campo deve vir primeiro no schema JSON?",
        choices=[
            QuizOption(value="a", label="O campo de decisão final vem antes do campo de raciocínio"),
            QuizOption(value="b", label="O campo de raciocínio vem antes do campo de decisão final"),
            QuizOption(value="c", label="A ordem das chaves no JSON não afeta a distribuição de tokens"),
        ],
        correct_index=1,
        explanation="Como a geração é autorregressiva P(x_t | x_<t), o campo gerado antes condiciona o campo gerado depois.",
    )

    # 1. Calibrated Mastery (Correct + Confidence >= 70)
    res_cal = evaluate_calibration(
        QuizSubmission(quiz_id="q1", session_id="sess1", chosen_index=1, confidence=85, learner_thinking="Autorregressão condiciona nos tokens anteriores"),
        quiz,
    )
    assert res_cal.correct is True
    assert res_cal.calibration_band == "calibrated_mastery"

    # 2. Illusion of Competence (Incorrect + Confidence >= 70)
    res_ill = evaluate_calibration(
        QuizSubmission(quiz_id="q1", session_id="sess1", chosen_index=0, confidence=90, learner_thinking="O resumo é gerado condicionado ao sentimento"),
        quiz,
    )
    assert res_ill.correct is False
    assert res_ill.calibration_band == "illusion_of_competence"
    assert "contra-exemplo" in res_ill.pedagogical_directive.lower() or "counterexample" in res_ill.pedagogical_directive.lower() or "ilusão" in res_ill.pedagogical_directive.lower()

    # 3. Fragile Intuition (Correct + Confidence < 50)
    res_frag = evaluate_calibration(
        QuizSubmission(quiz_id="q1", session_id="sess1", chosen_index=1, confidence=30, learner_thinking="Chutei pensando na ordem de leitura"),
        quiz,
    )
    assert res_frag.correct is True
    assert res_frag.calibration_band == "fragile_intuition"

    # 4. Conscious Gap ("I don't know" or Incorrect + Confidence < 50)
    res_gap = evaluate_calibration(
        QuizSubmission(quiz_id="q1", session_id="sess1", chosen_index=None, is_dont_know=True, confidence=0, learner_thinking="Não sei"),
        quiz,
    )
    assert res_gap.correct is False
    assert res_gap.calibration_band == "conscious_gap"


def test_calibration_records_quiz_mode_and_mastery_evidence() -> None:
    """CalibrationResult carries the quiz mode; only a calibrated CHECK on the node is mastery evidence."""
    from learnharness.core.calibration import is_mastery_evidence
    from learnharness.core.contracts.quiz import CalibrationResult

    base = dict(
        quiz_id="q1", session_id="s1", topic="t", node_id="n1",
        choices=[QuizOption(value="a", label="A"), QuizOption(value="b", label="B")],
        correct_index=1, question="?", explanation="e",
    )
    sub = QuizSubmission(quiz_id="q1", session_id="s1", chosen_index=1, confidence=90)
    pred = evaluate_calibration(sub, QuizPayload(mode="PREDICTION", **base))
    check = evaluate_calibration(sub, QuizPayload(mode="CHECK", **base))
    dont_know = evaluate_calibration(
        QuizSubmission(quiz_id="q1", session_id="s1", is_dont_know=True, confidence=0),
        QuizPayload(mode="CHECK", **base),
    )
    assert (pred.mode, check.mode, dont_know.mode) == ("PREDICTION", "CHECK", "CHECK")
    assert pred.calibration_band == check.calibration_band == "calibrated_mastery"
    assert not is_mastery_evidence(pred, "n1")
    assert is_mastery_evidence(check, "n1")
    assert not is_mastery_evidence(check, "other-node")
    assert not is_mastery_evidence(dont_know, "n1")

    # Legacy quiz-log / session records without `mode` still load, and are not CHECK evidence.
    legacy = check.model_dump(mode="json")
    legacy.pop("mode")
    restored = CalibrationResult.model_validate(legacy)
    assert restored.mode is None
    assert not is_mastery_evidence(restored, "n1")


def test_validate_quiz_options_evenness_detects_giveaways() -> None:
    """Verify detection of 'porque/because' justification giveaway and asymmetric bolding in the correct choice."""
    bad_choices = [
        QuizOption(value="a", label="O vetor muda de dimensão"),
        QuizOption(
            value="b",
            label="O produto escalar cresce com **raiz de d_k**, porque a variância da soma de d_k termos independentes se acumula linearmente",
        ),
        QuizOption(value="c", label="O gradiente desaparece na camada linear"),
    ]
    warnings = validate_quiz_options_evenness(bad_choices, correct_index=1)
    assert len(warnings) >= 1


def test_commit_before_pose_invariant() -> None:
    """A practice problem needs its model solution written before it is posed."""
    with pytest.raises(ValidationError):
        PracticeProblem(id="p1", statement="Calcule a matriz de atenção para Q, K, V.",
                        mode="composition", model_solution="   ")
    with pytest.raises(ValidationError):
        PracticeProblem(id="p1", statement=" ", mode="recall", model_solution="softmax(QK^T/sqrt(d))V")


def test_sse_frame_wire_format() -> None:
    """Verify SSE wire serialization."""
    frame = SseFrame(
        event=SseEventType.DOCK_OPENED,
        data={"session_id": "s1", "quiz_id": "q1"},
        timestamp="2026-10-26T12:00:00Z",
    )
    wire = frame.to_wire()
    assert wire.startswith("event: dock:opened\ndata: ")
    assert wire.endswith("\n\n")
