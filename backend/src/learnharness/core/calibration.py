"""Calibration matrix and quiz analysis pure functions for LearnHarness.

Zero I/O. Computes confidence bands, calibration quadrants, and option evenness checks.
"""

from collections.abc import Sequence
from datetime import UTC, datetime

from learnharness.core.contracts.quiz import (
    CalibrationBand,
    CalibrationResult,
    ConfidenceBand,
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


def compute_confidence_band(confidence: int) -> ConfidenceBand:
    """Classify a 0-100 confidence value into low (<50%), medium (50-69%), or high (>=70%)."""
    if confidence < 50:
        return "low"
    if confidence < 70:
        return "medium"
    return "high"


def evaluate_calibration(
    submission: QuizSubmission,
    quiz: QuizPayload,
    timestamp: str = "",
) -> CalibrationResult:
    """Pure pedagogical evaluation of a quiz response against learner confidence.

    Classifies response into one of the 6 calibration bands:
    - calibrated_mastery: Correct + High Confidence (>= 70%)
    - illusion_of_competence: Wrong + High Confidence (>= 70%) -> Highest priority alert!
    - fragile_intuition: Correct + Low Confidence (< 50%)
    - conscious_gap: Wrong / "Don't know" + Low Confidence (< 50%)
    - moderate_correct: Correct + Medium Confidence (50-69%)
    - moderate_error: Wrong + Medium Confidence (50-69%)
    """
    ts = timestamp or datetime.now(UTC).isoformat()
    conf_band = compute_confidence_band(submission.confidence)

    if submission.is_dont_know:
        return CalibrationResult(
            quiz_id=quiz.quiz_id,
            session_id=submission.session_id,
            topic=quiz.topic,
            node_id=quiz.node_id,
            correct=False,
            is_dont_know=True,
            chosen_index=submission.chosen_index,
            correct_index=quiz.correct_index,
            confidence=submission.confidence,
            confidence_band=conf_band,
            calibration_band="conscious_gap",
            learner_thinking=submission.learner_thinking,
            pedagogical_directive=(
                "Step back one prerequisite rung, construct concept from ground up "
                "with concrete example, avoid formal jargon."
            ),
            explanation=quiz.explanation,
            timestamp=ts,
        )

    correct = submission.chosen_index == quiz.correct_index

    if correct:
        if conf_band == "high":
            cal_band: CalibrationBand = "calibrated_mastery"
            directive = (
                "Confirm in 1 short sentence, celebrate solid intuition/calculation, "
                "advance to next node."
            )
        elif conf_band == "low":
            cal_band = "fragile_intuition"
            directive = (
                "Validate learner's intuition, explain why it was correct, "
                "and solidify the missing link to build confidence."
            )
        else:
            cal_band = "moderate_correct"
            directive = "Acknowledge correct choice, reinforce key concept to elevate confidence."
    else:
        if conf_band == "high":
            cal_band = "illusion_of_competence"
            directive = (
                "High priority alert! Analyze learner_thinking, provide a concrete counterexample "
                "where premise fails, re-explain from opposite angle, and pose a follow-up check "
                "before advancing."
            )
        elif conf_band == "low":
            cal_band = "conscious_gap"
            directive = (
                "Step back one prerequisite rung, construct concept from ground up "
                "with concrete example, avoid formal jargon."
            )
        else:
            cal_band = "moderate_error"
            directive = (
                "Clarify misconception gently, contrast correct option with chosen option, "
                "and verify understanding."
            )

    return CalibrationResult(
        quiz_id=quiz.quiz_id,
        session_id=submission.session_id,
        topic=quiz.topic,
        node_id=quiz.node_id,
        correct=correct,
        is_dont_know=False,
        chosen_index=submission.chosen_index,
        correct_index=quiz.correct_index,
        confidence=submission.confidence,
        confidence_band=conf_band,
        calibration_band=cal_band,
        learner_thinking=submission.learner_thinking,
        pedagogical_directive=directive,
        explanation=quiz.explanation,
        timestamp=ts,
    )


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
