from learnharness.engines.models import parse_agy_models


def test_parse_agy_models_output():
    out = "Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n"
    assert parse_agy_models(out) == [
        {"id": "gemini-3.8-flash-low", "label": "Gemini 3.8 Flash (Low)"},
        {"id": "claude-opus-5-5-high", "label": "Claude Opus 5.5 (High)"},
    ]


def test_connector_test_reports_latency_and_accepts_any_valid_answer(tmp_path):
    from starlette.testclient import TestClient

    from learnharness.api.app import create_app
    from learnharness.api.routes.setup import ProbeResult
    from learnharness.api.state import AppState
    from tests.conftest import FakeEngine

    engine = FakeEngine().program(ProbeResult, {"ready": False})
    client = TestClient(create_app(state=AppState(vault_path=tmp_path, engine_factory=lambda slot: engine)))
    res = client.post("/api/setup/connectors/test", json={"slot": {"engine": "agy", "model_id": "gemini-3.8-flash-low"}})
    assert res.status_code == 200 and res.json()["ok"] is True and res.json()["latency_ms"] >= 0
