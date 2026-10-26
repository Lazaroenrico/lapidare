"""Unit tests for Demo-Builder subagent and interactive visual simulators."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from learnharness.mcp.demo_builder import (
    generate_interactive_demo_html,
    load_demo_from_vault,
    save_demo_to_vault,
    spawn_demo,
)


def test_generate_interactive_demo_html_skin_and_offline() -> None:
    """Verifies that generated HTML strictly adheres to #141414 Skin and zero CDN dependencies."""
    html = generate_interactive_demo_html(
        title="Softmax Temperature Dynamics",
        topic="softmax",
        description="Visualiza o colapso e dispersão de probabilidades com variação de temperatura tau.",
    )

    # 1. LearnHarness Achromatic Graphite Skin palette
    assert "#141414" in html
    assert "--background: #141414" in html
    assert "--card: #1c1c1c" in html
    assert "--border: #434343" in html
    assert "--foreground: #e6e6e6" in html
    assert "--muted: #8d8d8d" in html
    assert "#34d399" in html  # Emerald accent
    assert "#fbbf24" in html  # Amber accent
    assert "#f87171" in html  # Coral accent

    # 2. Canvas and controls present
    assert "<canvas" in html
    assert 'id="simCanvas"' in html
    assert "btnPlayPause" in html
    assert "btnStep" in html
    assert "btnReset" in html

    # 3. Interactive range slider markup / builder
    assert 'type="range"' in html

    # 4. Zero external CDN dependencies (100% offline inside sandboxed iframe)
    # Ensure no external script or style imports from http/https CDNs
    script_srcs = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', html, re.IGNORECASE)
    assert len(script_srcs) == 0, f"Found unexpected external script srcs: {script_srcs}"

    link_hrefs = re.findall(r'<link[^>]+href=["\']([^"\']+)["\']', html, re.IGNORECASE)
    for href in link_hrefs:
        assert not href.startswith("http://") and not href.startswith("https://") and not href.startswith("//"), (
            f"Found external link href: {href}"
        )

    # 5. Embedded metadata JSON
    meta_match = re.search(
        r'<script type="application/json" id="demo-meta">\s*(\{.*?\})\s*</script>',
        html,
        re.DOTALL,
    )
    assert meta_match is not None, "Missing #demo-meta JSON script tag"
    meta = json.loads(meta_match.group(1))
    assert meta["slug"] == "softmax-temperature-dynamics"
    assert meta["topic"] == "softmax"
    assert "parameters" in meta
    assert len(meta["parameters"]) >= 2


def test_generate_interactive_demo_html_specialized_topics() -> None:
    """Verifies that specialized topic archetypes generate relevant parameters and controls."""
    # Attention archetype
    attn_html = generate_interactive_demo_html(
        title="Multi-Head Attention Scale",
        topic="attention",
        description="Visualiza produto escalar QK^T / sqrt(d_k) e mascaramento causal.",
    )
    assert "Matriz de Atenção" in attn_html
    assert "seq_len" in attn_html
    assert "dk_scale" in attn_html

    # Gradient descent archetype
    grad_html = generate_interactive_demo_html(
        title="SGD Momentum Trajectory",
        topic="gradient",
        description="Trajetória no espaço de perda e efeito do amortecimento beta.",
    )
    assert "learning_rate" in grad_html or "lr" in grad_html
    assert "momentum" in grad_html


def test_generate_interactive_demo_html_custom_parameters() -> None:
    """Verifies that explicitly supplied custom parameters are rendered."""
    custom_params = [
        {
            "id": "damping",
            "label": "Fator de Amortecimento (γ)",
            "min": 0.0,
            "max": 1.0,
            "step": 0.05,
            "default": 0.35,
            "unit": "s^-1",
            "description": "Taxa de amortecimento viscoso do oscilador",
        },
        {
            "id": "frequency",
            "label": "Frequência Natural (ω0)",
            "min": 1.0,
            "max": 10.0,
            "step": 0.5,
            "default": 4.5,
            "unit": "rad/s",
            "description": "Frequência angular característica",
        },
    ]

    html = generate_interactive_demo_html(
        title="Oscilador Harmônico em Fase",
        topic="physics",
        description="Simulação do espaço de fases (posição x momento).",
        parameters=custom_params,
    )

    assert "damping" in html
    assert "frequency" in html
    assert "Fator de Amortecimento (γ)" in html
    assert "Frequência Natural (ω0)" in html


def test_save_and_load_demo_from_vault(tmp_path: Path) -> None:
    """Verifies save_demo_to_vault writes viz/demos/<slug>.html and load_demo_from_vault reads it back."""
    vault = tmp_path / "StudyVault"
    vault.mkdir(parents=True, exist_ok=True)

    result = save_demo_to_vault(
        vault_path=vault,
        title="Softmax Temperature Explorer",
        topic="softmax",
        description="Explorador de temperatura tau e truncamento top-k.",
    )

    slug = result["slug"]
    assert slug == "softmax-temperature-explorer"
    assert result["rel_path"] == "viz/demos/softmax-temperature-explorer.html"

    demo_file = vault / "viz" / "demos" / f"{slug}.html"
    assert demo_file.exists()
    assert demo_file.is_file()
    assert len(demo_file.read_text(encoding="utf-8")) > 500

    # Test load_demo_from_vault without extension
    loaded = load_demo_from_vault(vault, slug)
    assert loaded["slug"] == slug
    assert loaded["title"] == "Softmax Temperature Explorer"
    assert loaded["topic"] == "softmax"
    assert "tau" in loaded["html"]

    # Test load_demo_from_vault with .html extension
    loaded_ext = load_demo_from_vault(vault, f"{slug}.html")
    assert loaded_ext["slug"] == slug

    # Test FileNotFoundError for unknown slug
    with pytest.raises(FileNotFoundError):
        load_demo_from_vault(vault, "non-existent-simulator")


def test_save_demo_links_into_lesson_note_non_destructively(tmp_path: Path) -> None:
    """Verifies linking demo into lesson note preserves 100% of user-written sections and notes."""
    vault = tmp_path / "AI_Engineering_Vault"
    lesson_rel = "Aulas/Livre/Atencao-Transformers.md"
    lesson_file = vault / lesson_rel
    lesson_file.parent.mkdir(parents=True, exist_ok=True)

    # Initial lesson note with custom user annotations and callouts
    initial_content = """---
tags: [aula]
status: em andamento
fonte: livre
data: 2026-10-26
---
# Atenção em Transformers

**Objetivo:** Dominar produtos escalares QK^T
**Fontes:** [[Vaswani 2017]]

## Ponto de partida
Sondagem inicial: Entendimento sólido de multiplicação de matrizes.

## Mapa de dependências
```mermaid
graph TD
    A[Embeddings] --> B[QKV Projections]
```

## Desdobrando
Minhas anotações manuais que NUNCA devem ser apagadas ou sobrescritas:
> [!note] Meu Insight Crítico
> Quando d_k é grande, o produto interno cresce em magnitude empurrando o softmax para regiões de gradiente minúsculo.

## Quizzes
Placar final: 4 acertos, 1 revisão necessária.

## Próximos passos
Implementar atenção multi-cabeça em PyTorch.
"""
    lesson_file.write_text(initial_content, encoding="utf-8")

    # Save interactive demo with lesson_rel_path specified
    save_demo_to_vault(
        vault_path=vault,
        title="Simulador de Softmax e Temperatura",
        topic="softmax_temperature",
        description="Permite experimentar a saturação do gradiente ao variar tau.",
        lesson_rel_path=lesson_rel,
    )

    # Read updated lesson note
    updated_content = lesson_file.read_text(encoding="utf-8")

    # CRITICAL INVARIANT: User personal notes and callouts must be 100% preserved
    assert "Minhas anotações manuais que NUNCA devem ser apagadas ou sobrescritas:" in updated_content
    assert "> [!note] Meu Insight Crítico" in updated_content
    assert "Quando d_k é grande, o produto interno cresce" in updated_content
    assert "Placar final: 4 acertos, 1 revisão necessária." in updated_content
    assert "Implementar atenção multi-cabeça em PyTorch." in updated_content

    # The simulator link should be cleanly added under ## Desdobrando
    assert "[[viz/demos/simulador-de-softmax-e-temperatura.html|Simulador Interativo: Simulador de Softmax e Temperatura]]" in updated_content
    assert "Permite experimentar a saturação do gradiente ao variar tau." in updated_content


@pytest.mark.asyncio
async def test_spawn_demo_async_tool(tmp_path: Path) -> None:
    """Verifies that spawn_demo async tool executes and writes the demo to the vault."""
    vault = tmp_path / "AsyncVault"
    res = await spawn_demo(
        title="KV Cache Footprint Dynamics",
        topic="kv_cache",
        description="Analisa a memória ocupada pelo KV Cache em função de contexto e batch size.",
        vault_path=str(vault),
    )

    assert res["slug"] == "kv-cache-footprint-dynamics"
    assert (vault / "viz" / "demos" / "kv-cache-footprint-dynamics.html").exists()
    assert res["title"] == "KV Cache Footprint Dynamics"
    assert "html" in res
