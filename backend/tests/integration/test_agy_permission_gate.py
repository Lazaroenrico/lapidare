from learnharness.api.state import AppState
from learnharness.core.contracts.config import EngineKind, ModelSlotConfig
from learnharness.vault.bootstrap import load_config, save_config
from tests.conftest import configure_vault


async def test_agy_session_without_permission_fails_with_guidance(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    vault = configure_vault(tmp_path / "Vault")
    config = load_config(vault)
    config.slots.strong = ModelSlotConfig(engine=EngineKind.AGY, model_id="gemini-3.8-flash-low")
    save_config(vault, config)
    state = AppState(vault_path=vault)
    session = await state.sessions.create(mode="TEACH", topic="Vetores", start=False)
    await state.sessions.run(session.id)
    failed = state.sessions.get(session.id)
    assert failed.execution_status == "failed"
    assert "mcp(harness/*)" in failed.error
