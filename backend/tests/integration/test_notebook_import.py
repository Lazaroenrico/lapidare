"""Read-only Notebook imports preserve source snapshots and redact upstream failures."""
from pathlib import Path

from starlette.testclient import TestClient


class FakeNotebook:
    def __init__(self):
        self.text = "Primeiro parágrafo.\n\nSegundo parágrafo."

    async def stop(self):
        pass

    async def notebooks(self):
        return [{"id": "book", "title": "Notebook"}]

    async def sources(self, notebook_id):
        return [{"id": "a", "title": "Fonte", "status": "ready"},
                {"id": "b", "title": "Fonte", "status": "ready"},
                {"id": "empty", "title": "Vazia", "status": "ready"}]

    async def fulltext(self, notebook_id, source_id):
        if source_id == "b":
            raise RuntimeError("private-cookie")
        return "" if source_id == "empty" else self.text


def test_import_partial_and_immutable(api_client: TestClient, app_state, configured_vault: Path):
    fake = FakeNotebook()
    app_state.notebook = fake
    payload = {"notebook_id": "book", "source_ids": ["a", "b", "empty", "missing"]}
    response = api_client.post("/api/import/notebook/import", json=payload)
    assert response.status_code == 200
    result = response.json()
    assert len(result["imported"]) == 1
    assert [error["reason"] for error in result["errors"]] == ["unavailable", "empty", "unavailable"]
    assert "private-cookie" not in response.text
    path = configured_vault / result["imported"][0]["source_path"]
    original = path.read_text()
    assert "^p1" in original and "^p2" in original and "notebook_source_id: a" in original
    again = api_client.post("/api/import/notebook/import", json={"notebook_id": "book", "source_ids": ["a"]}).json()
    assert again["imported"][0]["source_path"] == result["imported"][0]["source_path"]
    fake.text = "Conteúdo alterado."
    revised = api_client.post("/api/import/notebook/import", json={"notebook_id": "book", "source_ids": ["a"]}).json()
    assert revised["imported"][0]["source_path"] != result["imported"][0]["source_path"]
    assert path.read_text() == original


def test_catalog_error_does_not_expose_secrets(api_client: TestClient, app_state):
    class Broken(FakeNotebook):
        async def notebooks(self):
            raise RuntimeError("private-cookie")
    app_state.notebook = Broken()
    response = api_client.get("/api/import/notebook/notebooks")
    assert response.status_code == 502
    assert "private-cookie" not in response.text
