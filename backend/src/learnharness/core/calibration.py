"""Calibration matrix and answer analysis pure functions for LearnHarness.

Zero I/O. Evaluates QuestionDock answers (quiz / explain / ask), computes confidence
bands and calibration quadrants, builds the compact answer returned to the model and
checks option evenness.
"""

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from learnharness.core.contracts.quiz import (
    CalibrationBand,
    CalibrationResult,
    ConfidenceBand,
    GradeVerdict,
    QuizOption,
    QuizPayload,
    QuizSubmission,
)

JUSTIFICATION_KEYWORDS = (
    "porque",
    "por que",
    "pois",
    "já que",
    "visto que",
    "devido a",
    "portanto",
    "because",
    "since",
    "due to",
    "as a result of",
    "therefore",
)

GAP_DIRECTIVE = (
    "Genuine gap, not an error: step back one prerequisite rung, construct concept from "
    "ground up with concrete example, avoid formal jargon."
)
GRADE_DIRECTIVE = (
    "Grade this answer against your committed_answer with grade_recall(question_id, verdict, "
    "feedback) before commenting on it."
)


def compute_confidence_band(confidence: int) -> ConfidenceBand:
    """Classify a 0-100 confidence value into low (<50%), medium (50-69%), or high (>=70%)."""
    if confidence < 50:
        return "low"
    if confidence < 70:
        return "medium"
    return "high"


def _validated_choices(submission: QuizSubmission, quiz: QuizPayload) -> list[int]:
    chosen = list(dict.fromkeys(submission.chosen_indices))
    for index in chosen:
        if not 0 <= index < len(quiz.choices):
            raise ValueError("Choice index is out of bounds")
    if len(chosen) > 1 and not quiz.multi_select:
        raise ValueError("This question accepts a single choice")
    return chosen


def _quiz_band(correct: bool, band: ConfidenceBand) -> tuple[CalibrationBand, str]:
    if correct:
        if band == "high":
            return "calibrated_mastery", (
                "Confirm in 1 short sentence, celebrate solid intuition/calculation, advance to next node."
            )
        if band == "low":
            return "fragile_intuition", (
                "Validate learner's intuition, explain why it was correct, and solidify the missing "
                "link to build confidence (one reinforcement)."
            )
        return "moderate_correct", "Acknowledge correct choice, reinforce key concept to elevate confidence."
    if band == "high":
        return "illusion_of_competence", (
            "High priority alert! Committed misconception: analyze learner_thinking, provide a concrete "
            "counterexample where premise fails, re-explain from opposite angle, and pose a follow-up "
            "check before advancing."
        )
    if band == "low":
        return "conscious_gap", (
            "Step back one prerequisite rung, construct concept from ground up with concrete example, "
            "avoid formal jargon (a small correction)."
        )
    return "moderate_error", (
        "Clarify misconception gently, contrast correct option with chosen option, and verify understanding."
    )


def evaluate_calibration(
    submission: QuizSubmission,
    quiz: QuizPayload,
    timestamp: str = "",
) -> CalibrationResult:
    """Pure evaluation of a QuestionDock answer; raises ``ValueError`` on an invalid submission.

    * ``quiz``: correct iff the chosen set equals the correct set, classified into one of
      the 6 calibration bands (calibrated_mastery, illusion_of_competence,
      fragile_intuition, conscious_gap, moderate_correct, moderate_error). "Don't know"
      is ``conscious_gap`` with no confidence; otherwise confidence is required.
    * ``explain``: free text, ungraded (``correct=None``) until ``apply_grade``.
    * ``ask``: chosen options and/or "Other…" text; never graded.
    """
    ts = timestamp or datetime.now(UTC).isoformat()
    base: dict[str, Any] = {
        "quiz_id": quiz.quiz_id, "session_id": submission.session_id, "topic": quiz.topic,
        "node_id": quiz.node_id, "kind": quiz.kind, "mode": quiz.mode, "question": quiz.question,
        "choices": quiz.choices, "is_dont_know": submission.is_dont_know,
        "learner_thinking": submission.learner_thinking, "reading_thinking": submission.reading_thinking,
        "explanation": quiz.explanation, "timestamp": ts,
    }
    if quiz.kind == "ask":
        chosen = _validated_choices(submission, quiz)
        if not (chosen or submission.other_text.strip() or submission.is_dont_know):
            raise ValueError("Choose an option or write an answer")
        return CalibrationResult(**base, chosen_indices=chosen, other_text=submission.other_text)
    if quiz.kind == "explain":
        if not submission.is_dont_know and not submission.text.strip():
            raise ValueError("Write an answer or choose \"Don't know\"")
        return CalibrationResult(
            **base, text="" if submission.is_dont_know else submission.text,
            committed_answer=quiz.committed_answer,
            pedagogical_directive=GAP_DIRECTIVE if submission.is_dont_know else GRADE_DIRECTIVE,
        )
    base["correct_indices"] = quiz.correct_indices
    if submission.is_dont_know:
        return CalibrationResult(
            **base, correct=False, calibration_band="conscious_gap", pedagogical_directive=GAP_DIRECTIVE,
        )
    chosen = _validated_choices(submission, quiz)
    if not chosen:
        raise ValueError("Must either choose an option or indicate is_dont_know=True")
    if submission.confidence is None:
        raise ValueError("Confidence is required for a quiz answer")
    correct = set(chosen) == set(quiz.correct_indices)
    conf_band = compute_confidence_band(submission.confidence)
    cal_band, directive = _quiz_band(correct, conf_band)
    if submission.confidence <= 100 / len(quiz.choices):
        directive += " Confidence at or below chance (1/n): the learner treats this answer as a guess."
    return CalibrationResult(
        **base, correct=correct, chosen_indices=chosen, confidence=submission.confidence,
        confidence_band=conf_band, calibration_band=cal_band, pedagogical_directive=directive,
    )


def submission_matches(result: CalibrationResult, submission: QuizSubmission) -> bool:
    """True when ``submission`` repeats the input already recorded in ``result`` (idempotent retry)."""
    text = "" if submission.is_dont_know and result.kind == "explain" else submission.text
    return (
        sorted(set(result.chosen_indices)) == sorted(set(submission.chosen_indices))
        and result.is_dont_know == submission.is_dont_know
        and (result.confidence is None or result.confidence == submission.confidence)
        and result.learner_thinking == submission.learner_thinking
        and result.reading_thinking == submission.reading_thinking
        and result.text == text
        and result.other_text == submission.other_text
    )


def apply_grade(result: CalibrationResult, verdict: GradeVerdict, feedback: str) -> CalibrationResult:
    """Record the agent's grade of an explain/recall answer; ``correct`` follows the verdict."""
    if result.kind != "explain":
        raise ValueError("Only explain/recall answers are graded with grade_recall")
    return result.model_copy(update={"grade": verdict, "grade_feedback": feedback, "correct": verdict == "correct"})


def compact_answer(result: CalibrationResult) -> dict[str, Any]:
    """What the learner added, returned to the model: no answer key, no empty keys."""
    data: dict[str, Any] = {"question_id": result.quiz_id, "kind": result.kind}
    if result.is_dont_know:
        data["dont_know"] = True
    if result.chosen_indices:
        data["answers"] = [
            {"index": i, "label": result.choices[i].label if i < len(result.choices) else ""}
            for i in result.chosen_indices
        ]
    if result.other_text:
        data["other"] = result.other_text
    if result.text:
        data["text"] = result.text
    if result.correct is not None:
        data["correct"] = result.correct
    if result.confidence is not None:
        data["confidence"] = result.confidence
    if result.calibration_band:
        data["calibration_band"] = result.calibration_band
    if result.pedagogical_directive:
        data["directive"] = result.pedagogical_directive
    if result.learner_thinking:
        data["thinking"] = result.learner_thinking
    if result.reading_thinking:
        data["thinking_while_reading"] = result.reading_thinking
    if result.kind == "explain" and not result.is_dont_know:
        data["committed_answer"] = result.committed_answer
    return data


def is_mastery_evidence(answer: CalibrationResult, node_id: str) -> bool:
    """True only for CHECK evidence bound to ``node_id``.

    Either a calibrated CHECK quiz or a CHECK explain graded ``correct``. PREDICTION
    questions are asked before teaching (to force a prediction), so even a confident
    correct prediction does not prove understanding. Legacy answers with ``mode=None``
    are conservatively rejected.
    """
    if answer.mode != "CHECK" or answer.node_id != node_id:
        return False
    if answer.kind == "explain":
        return answer.grade == "correct"
    return answer.kind == "quiz" and answer.calibration_band == "calibrated_mastery"


def validate_quiz_options_evenness(
    choices: Sequence[QuizOption],
    correct_index: int,
) -> list[str]:
    """Pure validation inspecting multiple choice symmetry and giveaway leaks.

    Detects:
    1. Correct option drastically longer than distractor average (> 1.8x and > 25 chars longer).
    2. Correct option drastically shorter than distractor average (> 2.0x shorter).
    3. Justification leak: correct option includes 'because' / 'porque' / 'já que' while distractors do not.
    4. Markdown formatting asymmetry (e.g. bolded correct answer vs unbolded distractors).
    """
    issues: list[str] = []

    if correct_index < 0 or correct_index >= len(choices):
        issues.append(
            f"Index error: correct_index {correct_index} is out of bounds for choices of size {len(choices)}."
        )
        return issues

    if len(choices) < 2:
        issues.append("Quiz must provide at least 2 choices.")
    elif len(choices) > 6:
        issues.append("Quiz cannot exceed 6 choices.")

    correct_text = choices[correct_index].label.strip()
    distractor_texts = [
        opt.label.strip()
        for idx, opt in enumerate(choices)
        if idx != correct_index
    ]

    if not distractor_texts:
        return issues

    # 1. Length asymmetry checks
    avg_distractor_len = sum(len(t) for t in distractor_texts) / len(distractor_texts)
    correct_len = len(correct_text)

    if avg_distractor_len > 0 and correct_len > 1.8 * avg_distractor_len and (correct_len - avg_distractor_len) > 25:
        issues.append(
            f"Length asymmetry: correct choice length ({correct_len} chars) is significantly longer than "
            f"average distractor length ({avg_distractor_len:.1f} chars)."
        )
    elif correct_len > 0 and avg_distractor_len > 2.0 * correct_len and (avg_distractor_len - correct_len) > 30:
        issues.append(
            f"Length asymmetry: correct choice length ({correct_len} chars) is significantly shorter than "
            f"average distractor length ({avg_distractor_len:.1f} chars)."
        )

    # 2. Justification leak
    lower_correct = correct_text.lower()
    correct_has_justification = any(k in lower_correct for k in JUSTIFICATION_KEYWORDS)
    distractors_with_justification = [
        t for t in distractor_texts if any(k in t.lower() for k in JUSTIFICATION_KEYWORDS)
    ]
    if correct_has_justification and not distractors_with_justification:
        issues.append(
            "Justification leak: correct choice includes explanatory justification "
            "('because' / 'porque' / 'pois' / etc.) while distractors do not."
        )

    # 3. Formatting asymmetry (bold / strong)
    def _has_bold(s: str) -> bool:
        return "**" in s or "<b>" in s or "<strong>" in s or "__" in s

    correct_bold = _has_bold(correct_text)
    distractors_bold = [_has_bold(t) for t in distractor_texts]
    if correct_bold and not any(distractors_bold):
        issues.append("Formatting asymmetry: correct choice is bolded while distractors are not.")
    elif not correct_bold and all(distractors_bold):
        issues.append("Formatting asymmetry: all distractors are bolded while correct choice is not.")

    return issues
