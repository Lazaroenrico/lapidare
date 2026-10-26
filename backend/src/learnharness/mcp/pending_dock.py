"""Pending QuestionDock registry managing asyncio.Future suspensions.

Suspends agent execution when a quiz is posed until the learner submits
their choice, confidence score, and thinking via the QuestionDock UI.
"""

import asyncio
import logging

from learnharness.core.calibration import evaluate_calibration
from learnharness.core.contracts.quiz import (
    CalibrationResult,
    QuizPayload,
    QuizSubmission,
)

logger = logging.getLogger(__name__)


class PendingDockRegistry:
    """Registry coordinating QuestionDock pauses and learner answer resolutions."""

    def __init__(self) -> None:
        self._pending_quizzes: dict[str, QuizPayload] = {}
        self._pending_futures: dict[str, asyncio.Future[CalibrationResult]] = {}

    def open_dock(
        self, session_id: str, quiz: QuizPayload
    ) -> asyncio.Future[CalibrationResult]:
        """Register active quiz and return Future that suspends tool call until answered."""
        # Cancel any previous dangling future for this session
        if session_id in self._pending_futures:
            prev_future = self._pending_futures[session_id]
            if not prev_future.done():
                prev_future.cancel()

        loop = asyncio.get_running_loop()
        future: asyncio.Future[CalibrationResult] = loop.create_future()

        self._pending_quizzes[session_id] = quiz
        self._pending_futures[session_id] = future
        logger.info(
            "Opened QuestionDock for session %s (quiz_id=%s, mode=%s)",
            session_id,
            quiz.quiz_id,
            quiz.mode,
        )
        return future

    def resolve_dock(
        self, session_id: str, submission: QuizSubmission
    ) -> CalibrationResult:
        """Resolve pending quiz with learner's submission and return CalibrationResult."""
        quiz = self._pending_quizzes.get(session_id)
        if not quiz:
            raise KeyError(f"No pending quiz found for session {session_id}")

        if quiz.quiz_id != submission.quiz_id:
            raise ValueError("Submission does not match pending quiz")
        if submission.chosen_index is not None and not 0 <= submission.chosen_index < len(quiz.choices):
            raise ValueError("Choice index is out of bounds")

        calibration_result = evaluate_calibration(submission=submission, quiz=quiz)

        future = self._pending_futures.get(session_id)
        if future and not future.done():
            future.set_result(calibration_result)

        # Clear pending entries
        self._pending_quizzes.pop(session_id, None)
        self._pending_futures.pop(session_id, None)

        logger.info(
            "Resolved QuestionDock for session %s (band=%s, correct=%s, conf=%s)",
            session_id,
            calibration_result.calibration_band,
            calibration_result.correct,
            calibration_result.confidence,
        )
        return calibration_result

    def get_pending_quiz(self, session_id: str) -> QuizPayload | None:
        """Retrieve the active quiz payload currently open in the QuestionDock."""
        return self._pending_quizzes.get(session_id)

    def cancel_dock(self, session_id: str) -> bool:
        """Cancel an open dock without grading."""
        future = self._pending_futures.pop(session_id, None)
        self._pending_quizzes.pop(session_id, None)
        if future and not future.done():
            future.cancel()
            return True
        return False


# Singleton default registry used across application lifecycle
default_dock_registry = PendingDockRegistry()
