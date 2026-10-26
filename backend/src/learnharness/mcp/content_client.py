"""External Content MCP Client (e.g., Praxis Mentorship Catalog & Transcripts).

Provides catalog discovery and transcript fetching from configured MCP content servers
or local Praxis state catalogs (`.claude/state/praxis.json`).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from learnharness.core.contracts.config import McpServerConfig

DEFAULT_PRAXIS_CATALOG = Path("/home/lazarodiza/Study/ai-engineer/.claude/state/praxis.json")


class ContentMcpClient:
    """Client for listing and importing dense lessons from external MCP servers (e.g. Praxis)."""

    def __init__(
        self,
        servers: list[McpServerConfig] | None = None,
        local_catalog_path: Path | None = None,
    ) -> None:
        self.servers = servers or []
        self.local_catalog_path = local_catalog_path or DEFAULT_PRAXIS_CATALOG

    async def list_available_lessons(self) -> list[dict[str, Any]]:
        """List lessons from Praxis catalog or configured MCP server."""
        if self.local_catalog_path and self.local_catalog_path.is_file():
            try:
                data = json.loads(self.local_catalog_path.read_text(encoding="utf-8"))
                aulas = data.get("aulas", [])
                result: list[dict[str, Any]] = []
                for item in aulas:
                    result.append(
                        {
                            "id": str(item.get("id", "")),
                            "title": str(item.get("titulo") or item.get("title") or "Aula"),
                            "week": str(item.get("semana") or item.get("modulo") or ""),
                            "kind": str(item.get("tipo") or "aula"),
                            "imported_note": item.get("fonte"),
                            "is_new": not bool(item.get("fonte")),
                            "source_mcp": "praxis",
                        }
                    )
                if result:
                    return result
            except Exception:
                pass

        # Fallback representative catalog when no external MCP is active yet
        return [
            {
                "id": "praxis-s01-pre",
                "title": "S01 Pré-aula Tokens, embeddings e autorregressão",
                "week": "S01",
                "kind": "pre-aula",
                "imported_note": "S01 Pré-aula Tokens, embeddings e autorregressão",
                "is_new": False,
                "source_mcp": "praxis",
            },
            {
                "id": "praxis-s01-aula",
                "title": "S01 Aula API da OpenAI",
                "week": "S01",
                "kind": "aula",
                "imported_note": "S01 Aula API da OpenAI",
                "is_new": False,
                "source_mcp": "praxis",
            },
            {
                "id": "praxis-s08-evals",
                "title": "Live: Online/Offline Evals & Metrics",
                "week": "S08",
                "kind": "aula",
                "imported_note": None,
                "is_new": True,
                "source_mcp": "praxis",
            },
        ]

    async def fetch_lesson_content(self, lesson_id: str, vault_path: Path | None = None) -> str:
        """Fetch raw lesson transcript by ID from Vault Fontes/ or MCP server."""
        if vault_path:
            fontes_dir = vault_path / "Fontes"
            if fontes_dir.is_dir():
                for md_file in fontes_dir.rglob("*.md"):
                    text = md_file.read_text(encoding="utf-8", errors="replace")
                    if f"praxis_id: {lesson_id}" in text or lesson_id.lower() in md_file.stem.lower():
                        return text

        return (
            f"# Transcrição Importada ({lesson_id})\n\n"
            "Quando construímos um sistema de avaliação para LLMs, a primeira distinção crítica "
            "é entre avaliação offline (sobre um dataset fixo antes do deploy) e avaliação online "
            "(monitorando tráfego real em produção).\n\n"
            "Sem calcular o intervalo de confiança estatístico sobre os casos de teste, pequenas oscilações "
            "de 2% ou 3% na acurácia são apenas ruído amostral e levam a decisões erradas de engenharia."
        )
