from starlette.testclient import TestClient

from learnharness.api.app import create_app
from learnharness.vault.bootstrap import bootstrap_vault


def test_concept_note_is_served_read_only(tmp_path):
    bootstrap_vault(tmp_path, language="pt-BR")
    (tmp_path / "Conceitos" / "Produto Escalar.md").write_text(
        "---\nid: produto-escalar\n---\n# Produto Escalar\n\nMinha anotação.\n", encoding="utf-8"
    )
    client = TestClient(create_app(vault_path=tmp_path))
    nodes = client.get("/api/graph").json()["nodes"]
    concept_id = next(n["id"] for n in nodes if n["title"] == "Produto Escalar")
    res = client.get(f"/api/graph/concepts/{concept_id}/note")
    assert res.status_code == 200
    assert res.json()["path"].endswith("Produto Escalar.md")
    assert "Minha anotação." in res.json()["markdown"]
    assert client.get("/api/graph/concepts/nao-existe/note").status_code == 404
    assert client.get("/api/graph/concepts/..%2F..%2Fetc%2Fpasswd/note").status_code == 404
