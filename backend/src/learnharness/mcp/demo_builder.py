"""Demo-Builder generator and MCP interactive visual simulator tools.

Generates self-contained HTML5 + CSS + Vanilla JS + 2D Canvas interactive simulators
styled strictly in the LearnHarness `#141414` Skin. Zero external CDN dependencies
ensures 100% offline operation inside sandboxed iframes.
Persists demos to `<vault_path>/viz/demos/<slug>.html` and non-destructively links
them into lesson notes in `Aulas/...` or `Lessons/...`.
"""

from __future__ import annotations

import html
import json
import logging
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from learnharness.vault.markdown_ast import merge_lesson_note

logger = logging.getLogger(__name__)

# Default vault path fallback if not configured
DEFAULT_VAULT_PATH = Path(
    os.getenv("LEARNHARNESS_VAULT_PATH", "/home/lazarodiza/Documents/AI Engineering")
)

_default_vault_path: Path | None = None


def set_default_vault_path(path: Path | str) -> None:
    """Set the process-wide default vault path."""
    global _default_vault_path
    _default_vault_path = Path(path).resolve()


def get_default_vault_path() -> Path:
    """Retrieve the process-wide default vault path."""
    if _default_vault_path is not None:
        return _default_vault_path
    return DEFAULT_VAULT_PATH.resolve()


def _slugify(text: str) -> str:
    """Convert text into an Obsidian-compatible URL-safe slug."""
    clean = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower())
    clean = clean.strip("-")
    return clean or "simulator"


def _infer_default_parameters(topic: str, title: str) -> list[dict[str, Any]]:
    """Infer specialized interactive parameter sliders based on topic keywords."""
    combined = f"{topic} {title}".lower()

    if any(k in combined for k in ["temperature", "temperatura", "softmax", "sampling", "amostragem", "logit"]):
        return [
            {
                "id": "tau",
                "label": "Temperatura (τ)",
                "min": 0.05,
                "max": 2.5,
                "step": 0.05,
                "default": 0.7,
                "unit": "",
                "description": "Controla a dispersão da distribuição de probabilidade",
            },
            {
                "id": "top_k",
                "label": "Top-k Truncation (k)",
                "min": 1,
                "max": 8,
                "step": 1,
                "default": 5,
                "unit": "tokens",
                "description": "Filtra apenas os k logits com maior probabilidade",
            },
            {
                "id": "num_tokens",
                "label": "Vocabulário Amostrado (N)",
                "min": 4,
                "max": 12,
                "step": 1,
                "default": 6,
                "unit": "tokens",
                "description": "Quantidade de tokens concorrentes no vocabulário",
            },
        ]

    if any(k in combined for k in ["attention", "atenção", "transformer", "head", "qkv", "cabeça"]):
        return [
            {
                "id": "seq_len",
                "label": "Sequence Length (N)",
                "min": 3,
                "max": 10,
                "step": 1,
                "default": 6,
                "unit": "tokens",
                "description": "Número de tokens na janela de contexto",
            },
            {
                "id": "dk_scale",
                "label": "Escala Softmax (1/√d_k)",
                "min": 0.1,
                "max": 2.0,
                "step": 0.1,
                "default": 1.0,
                "unit": "x",
                "description": "Fator de estabilização do produto escalar das chaves",
            },
            {
                "id": "masking",
                "label": "Causal Masking (Auto-regressivo)",
                "min": 0,
                "max": 1,
                "step": 1,
                "default": 1,
                "unit": "bool",
                "description": "Aplica máscara triangular superior (impede olhar o futuro)",
            },
        ]

    if any(k in combined for k in ["gradient", "gradiente", "loss", "perda", "lr", "learning rate", "taxa", "optimizer"]):
        return [
            {
                "id": "learning_rate",
                "label": "Learning Rate (η)",
                "min": 0.01,
                "max": 1.0,
                "step": 0.01,
                "default": 0.18,
                "unit": "",
                "description": "Tamanho do passo na descida do gradiente",
            },
            {
                "id": "momentum",
                "label": "Momentum (β)",
                "min": 0.0,
                "max": 0.98,
                "step": 0.02,
                "default": 0.85,
                "unit": "",
                "description": "Fator de amortecimento e inércia do passo anterior",
            },
            {
                "id": "noise",
                "label": "Stochastic Noise (σ)",
                "min": 0.0,
                "max": 0.5,
                "step": 0.02,
                "default": 0.08,
                "unit": "",
                "description": "Variância de ruído simulando mini-batch SGD",
            },
        ]

    # Universal dynamic mode
    return [
        {
            "id": "param_alpha",
            "label": "Sensibilidade (α)",
            "min": 0.1,
            "max": 3.0,
            "step": 0.1,
            "default": 1.2,
            "unit": "",
            "description": "Modula a amplitude da resposta do sistema",
        },
        {
            "id": "param_beta",
            "label": "Amortecimento (β)",
            "min": 0.1,
            "max": 4.0,
            "step": 0.1,
            "default": 1.0,
            "unit": "",
            "description": "Taxa de decaimento e estabilização",
        },
        {
            "id": "dimension_n",
            "label": "Dimensão Discreta (N)",
            "min": 3,
            "max": 12,
            "step": 1,
            "default": 6,
            "unit": "nós",
            "description": "Número de estados discretos no espaço de fases",
        },
    ]


def generate_interactive_demo_html(
    title: str,
    topic: str,
    description: str,
    parameters: list[dict[str, Any]] | None = None,
) -> str:
    """Generate a complete, self-contained HTML5 + Canvas interactive simulator.

    Follows strictly the LearnHarness `#141414` Skin:
    - `--background: #141414`
    - `--card: #1c1c1c`
    - `--accent: #2a2a2a`
    - `--border: #434343`
    - `--foreground: #e6e6e6`
    - `--muted: #8d8d8d`
    - `#34d399` emerald accent
    - `#fbbf24` amber accent
    - `#f87171` coral accent
    - Zero external CDN dependencies (works 100% offline in sandboxed iframes).
    """
    clean_title = title.strip()
    clean_topic = topic.strip()
    clean_desc = description.strip()
    slug = _slugify(clean_title)

    params = (
        parameters
        if parameters is not None and len(parameters) > 0
        else _infer_default_parameters(clean_topic, clean_title)
    )

    # Normalize parameters
    normalized_params = []
    for p in params:
        p_id = str(p.get("id") or _slugify(p.get("label", "param"))).replace("-", "_")
        p_min = float(p.get("min", 0.0))
        p_max = float(p.get("max", 1.0))
        p_step = float(p.get("step", 0.01))
        p_default = float(p.get("default", (p_min + p_max) / 2))
        normalized_params.append(
            {
                "id": p_id,
                "label": str(p.get("label", p_id)),
                "min": p_min,
                "max": p_max,
                "step": p_step,
                "default": p_default,
                "unit": str(p.get("unit", "")),
                "description": str(p.get("description", "")),
            }
        )

    meta_json = json.dumps(
        {
            "slug": slug,
            "title": clean_title,
            "topic": clean_topic,
            "description": clean_desc,
            "parameters": normalized_params,
            "created_at": datetime.now(UTC).isoformat(),
        },
        indent=2,
        ensure_ascii=False,
    )

    params_json = json.dumps(normalized_params, ensure_ascii=False)

    # Detect simulation archetype
    topic_lower = f"{clean_topic} {clean_title}".lower()
    if any(k in topic_lower for k in ["temperature", "temperatura", "softmax", "sampling", "amostragem", "logit"]):
        archetype = "softmax"
    elif any(k in topic_lower for k in ["attention", "atenção", "transformer", "head", "qkv"]):
        archetype = "attention"
    elif any(k in topic_lower for k in ["gradient", "gradiente", "loss", "perda", "lr", "optimizer"]):
        archetype = "optimizer"
    else:
        archetype = "generic"

    # Self-contained HTML with embedded CSS and Vanilla JS
    return f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{html.escape(clean_title)}</title>
  <script type="application/json" id="demo-meta">
{meta_json}
  </script>
  <style>
    /* LearnHarness #141414 Graphite Skin Variables */
    :root {{
      --background: #141414;
      --card: #1c1c1c;
      --accent: #2a2a2a;
      --border: #434343;
      --foreground: #e6e6e6;
      --muted: #8d8d8d;
      --emerald: #34d399;
      --amber: #fbbf24;
      --coral: #f87171;
      --blue: #60a5fa;
      --font-title: "CMU Serif", "Computer Modern Serif", Georgia, serif;
      --font-ui: "JetBrains Mono", Consolas, "Courier New", monospace;
      --font-prose: "Source Sans 3", system-ui, -apple-system, sans-serif;
    }}

    *, *::before, *::after {{
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }}

    *:focus, *:focus-visible {{
      outline: none !important;
      box-shadow: none !important;
    }}

    html, body {{
      width: 100%;
      height: 100%;
      background-color: var(--background);
      color: var(--foreground);
      font-family: var(--font-prose);
      font-size: 14px;
      line-height: 1.5;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
    }}

    .container {{
      max-width: 1100px;
      margin: 0 auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }}

    /* Header Bar */
    .header-bar {{
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 6px;
    }}

    .header-left {{
      display: flex;
      flex-direction: column;
      gap: 4px;
    }}

    .header-tag {{
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-ui);
      font-size: 11px;
      letter-spacing: 0.08em;
      color: var(--emerald);
      text-transform: uppercase;
    }}

    .header-tag .pulse-dot {{
      width: 6px;
      height: 6px;
      background: var(--emerald);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--emerald);
      animation: pulse 2s infinite ease-in-out;
    }}

    @keyframes pulse {{
      0%, 100% {{ opacity: 1; transform: scale(1); }}
      50% {{ opacity: 0.4; transform: scale(0.85); }}
    }}

    .header-title {{
      font-family: var(--font-title);
      font-size: 20px;
      font-weight: 700;
      color: var(--foreground);
    }}

    .header-badge {{
      font-family: var(--font-ui);
      font-size: 11px;
      padding: 4px 8px;
      background: var(--accent);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--muted);
    }}

    /* Main Grid */
    .sim-grid {{
      display: grid;
      grid-template-columns: 1fr 340px;
      gap: 16px;
    }}

    @media (max-width: 860px) {{
      .sim-grid {{
        grid-template-columns: 1fr;
      }}
    }}

    /* Canvas Card */
    .canvas-card {{
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }}

    .canvas-wrapper {{
      position: relative;
      width: 100%;
      height: 380px;
      background: #101010;
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
    }}

    canvas {{
      display: block;
      width: 100%;
      height: 100%;
    }}

    /* Canvas Overlay Telemetry HUD */
    .telemetry-hud {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 8px;
      background: #161616;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px 12px;
    }}

    .metric-box {{
      display: flex;
      flex-direction: column;
      gap: 2px;
    }}

    .metric-label {{
      font-family: var(--font-ui);
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }}

    .metric-value {{
      font-family: var(--font-ui);
      font-size: 14px;
      font-weight: 600;
      color: var(--foreground);
    }}

    .metric-value.emerald {{ color: var(--emerald); }}
    .metric-value.amber {{ color: var(--amber); }}
    .metric-value.coral {{ color: var(--coral); }}

    /* Controls Bar */
    .controls-row {{
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }}

    .btn {{
      background: var(--accent);
      border: 1px solid var(--border);
      color: var(--foreground);
      font-family: var(--font-ui);
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s, border-color 0.15s;
    }}

    .btn:hover {{
      background: #363636;
      border-color: #555555;
    }}

    .btn.active {{
      background: #25332b;
      border-color: var(--emerald);
      color: var(--emerald);
    }}

    /* Sidebar Panels */
    .sidebar-panel {{
      display: flex;
      flex-direction: column;
      gap: 16px;
    }}

    .card {{
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }}

    .card-title {{
      font-family: var(--font-ui);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }}

    /* Sliders */
    .slider-group {{
      display: flex;
      flex-direction: column;
      gap: 6px;
    }}

    .slider-header {{
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
    }}

    .slider-label {{
      color: var(--foreground);
      font-weight: 500;
    }}

    .slider-readout {{
      font-family: var(--font-ui);
      font-size: 11.5px;
      color: var(--emerald);
      background: #111e17;
      border: 1px solid #1f3d2e;
      padding: 2px 6px;
      border-radius: 3px;
    }}

    input[type="range"] {{
      -webkit-appearance: none;
      width: 100%;
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      cursor: pointer;
    }}

    input[type="range"]::-webkit-slider-thumb {{
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--foreground);
      border: 2px solid var(--card);
      box-shadow: 0 0 4px rgba(0, 0, 0, 0.5);
      cursor: pointer;
      transition: transform 0.1s, background 0.1s;
    }}

    input[type="range"]:hover::-webkit-slider-thumb {{
      background: var(--emerald);
      transform: scale(1.15);
    }}

    .slider-bounds {{
      display: flex;
      justify-content: space-between;
      font-family: var(--font-ui);
      font-size: 10px;
      color: var(--muted);
    }}

    /* Intuition Box */
    .intuition-box {{
      background: #181c19;
      border: 1px solid #283e30;
      border-radius: 6px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }}

    .intuition-header {{
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-ui);
      font-size: 11px;
      letter-spacing: 0.05em;
      color: var(--emerald);
      text-transform: uppercase;
      font-weight: 600;
    }}

    .intuition-text {{
      color: #cfd8d2;
      font-size: 13px;
      line-height: 1.45;
    }}

    .intuition-dynamic {{
      padding-top: 6px;
      border-top: 1px dashed #283e30;
      font-family: var(--font-ui);
      font-size: 11.5px;
      color: var(--amber);
    }}

    /* Presets Row */
    .preset-row {{
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }}

    .preset-btn {{
      font-family: var(--font-ui);
      font-size: 10.5px;
      padding: 3px 8px;
      background: var(--accent);
      border: 1px solid var(--border);
      border-radius: 3px;
      color: var(--foreground);
      cursor: pointer;
      transition: all 0.15s;
    }}

    .preset-btn:hover {{
      background: #363636;
      border-color: var(--emerald);
    }}
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header class="header-bar">
      <div class="header-left">
        <span class="header-tag">
          <span class="pulse-dot"></span>
          ⚡ {html.escape(clean_topic.upper())} · SIMULADOR INTERATIVO
        </span>
        <h1 class="header-title">{html.escape(clean_title)}</h1>
      </div>
      <div class="header-badge">
        LEARNHARNESS VIZ · OFFLINE
      </div>
    </header>

    <!-- Main Grid -->
    <div class="sim-grid">
      <!-- Left Column: Canvas & Controls -->
      <section class="canvas-card">
        <div class="canvas-wrapper">
          <canvas id="simCanvas"></canvas>
        </div>

        <!-- Telemetry HUD -->
        <div class="telemetry-hud" id="telemetryHud">
          <div class="metric-box">
            <span class="metric-label">Entropia (H)</span>
            <span class="metric-value" id="valEntropy">--</span>
          </div>
          <div class="metric-box">
            <span class="metric-label">Max P (Argmax)</span>
            <span class="metric-value emerald" id="valMaxP">--</span>
          </div>
          <div class="metric-box">
            <span class="metric-label">Top Token</span>
            <span class="metric-value" id="valTopToken">--</span>
          </div>
          <div class="metric-box">
            <span class="metric-label">Estado</span>
            <span class="metric-value amber" id="valState">Executando</span>
          </div>
        </div>

        <!-- Canvas Controls -->
        <div class="controls-row">
          <button class="btn" id="btnPlayPause">⏸ Pausar</button>
          <button class="btn" id="btnStep">↷ Passo (dt)</button>
          <button class="btn" id="btnReset">↺ Reiniciar</button>
          <div style="flex-grow: 1;"></div>
          <span style="font-family: var(--font-ui); font-size: 11px; color: var(--muted);" id="stepCounter">Passo: 0</span>
        </div>
      </section>

      <!-- Right Column: Parameter Sliders & Intuition -->
      <aside class="sidebar-panel">
        <!-- Interactive Parameters Card -->
        <div class="card">
          <div class="card-title">
            <span>Parâmetros Interativos</span>
            <span style="color: var(--emerald); font-weight: 600;">LIVE</span>
          </div>

          <div id="slidersContainer" style="display: flex; flex-direction: column; gap: 14px;">
            <!-- Dynamically injected sliders -->
          </div>

          <!-- Presets -->
          <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 6px;">
            <span class="card-title">Cenários Típicos</span>
            <div class="preset-row" id="presetsRow">
              <!-- Dynamically populated presets -->
            </div>
          </div>
        </div>

        <!-- Pedagogical Intuition Callout -->
        <div class="intuition-box">
          <div class="intuition-header">
            <span>💡 Intuição Pedagógica</span>
          </div>
          <div class="intuition-text">
            {html.escape(clean_desc)}
          </div>
          <div class="intuition-dynamic" id="dynamicIntuition">
            Ajuste os controles deslizantes para observar a transição de fase em tempo real.
          </div>
        </div>
      </aside>
    </div>
  </div>

  <script>
    (function() {{
      "use strict";

      const ARCHETYPE = "{archetype}";
      const PARAM_CONFIG = {params_json};

      // State Store
      const state = {{
        running: true,
        step: 0,
        hoveredIndex: -1,
        params: {{}},
      }};

      // Initialize state defaults
      PARAM_CONFIG.forEach(p => {{
        state.params[p.id] = p.default;
      }});

      // DOM Elements
      const canvas = document.getElementById("simCanvas");
      const ctx = canvas.getContext("2d");
      const btnPlayPause = document.getElementById("btnPlayPause");
      const btnStep = document.getElementById("btnStep");
      const btnReset = document.getElementById("btnReset");
      const stepCounter = document.getElementById("stepCounter");
      const slidersContainer = document.getElementById("slidersContainer");
      const presetsRow = document.getElementById("presetsRow");
      const dynamicIntuition = document.getElementById("dynamicIntuition");

      // HUD elements
      const valEntropy = document.getElementById("valEntropy");
      const valMaxP = document.getElementById("valMaxP");
      const valTopToken = document.getElementById("valTopToken");
      const valState = document.getElementById("valState");

      // Base candidate tokens for simulation
      const CANDIDATE_TOKENS = ["attention", "neural", "gradient", "vector", "loss", "weight", "layer", "transformer", "matrix", "tensor", "epoch", "model"];
      const BASE_LOGITS = [4.2, 3.8, 2.9, 2.1, 1.5, 0.8, 0.4, 0.1, -0.6, -1.2, -1.8, -2.5];

      // Build Sliders DOM
      PARAM_CONFIG.forEach(p => {{
        const group = document.createElement("div");
        group.className = "slider-group";

        const header = document.createElement("div");
        header.className = "slider-header";

        const label = document.createElement("span");
        label.className = "slider-label";
        label.textContent = p.label;

        const readout = document.createElement("span");
        readout.className = "slider-readout";
        readout.id = `readout_${{p.id}}`;
        readout.textContent = `${{p.default}} ${{p.unit}}`.trim();

        header.appendChild(label);
        header.appendChild(readout);

        const input = document.createElement("input");
        input.type = "range";
        input.id = `slider_${{p.id}}`;
        input.min = p.min;
        input.max = p.max;
        input.step = p.step;
        input.value = p.default;

        input.addEventListener("input", (e) => {{
          const val = parseFloat(e.target.value);
          state.params[p.id] = val;
          readout.textContent = `${{val}} ${{p.unit}}`.trim();
          updateIntuition();
        }});

        const bounds = document.createElement("div");
        bounds.className = "slider-bounds";
        bounds.innerHTML = `<span>${{p.min}}</span><span>${{p.max}}</span>`;

        group.appendChild(header);
        group.appendChild(input);
        group.appendChild(bounds);
        slidersContainer.appendChild(group);
      }});

      // Populate Archetype Presets
      if (ARCHETYPE === "softmax") {{
        const presets = [
          {{ label: "Quase One-Hot (τ=0.15)", values: {{ tau: 0.15, top_k: 5 }} }},
          {{ label: "Equilibrado (τ=0.70)", values: {{ tau: 0.70, top_k: 5 }} }},
          {{ label: "Uniforme / Ruído (τ=2.2)", values: {{ tau: 2.2, top_k: 8 }} }},
          {{ label: "Top-k=1 (Greedy)", values: {{ tau: 0.7, top_k: 1 }} }},
        ];
        presets.forEach(pr => {{
          const b = document.createElement("button");
          b.className = "preset-btn";
          b.textContent = pr.label;
          b.onclick = () => applyPreset(pr.values);
          presetsRow.appendChild(b);
        }});
      }} else if (ARCHETYPE === "attention") {{
        const presets = [
          {{ label: "Curta Janela (N=4)", values: {{ seq_len: 4, dk_scale: 1.0, masking: 1 }} }},
          {{ label: "Causal Padrão (N=6)", values: {{ seq_len: 6, dk_scale: 1.0, masking: 1 }} }},
          {{ label: "Sem Escala (1/√dk desativado)", values: {{ seq_len: 6, dk_scale: 0.2, masking: 1 }} }},
          {{ label: "Bidirecional / BERT", values: {{ seq_len: 6, dk_scale: 1.0, masking: 0 }} }},
        ];
        presets.forEach(pr => {{
          const b = document.createElement("button");
          b.className = "preset-btn";
          b.textContent = pr.label;
          b.onclick = () => applyPreset(pr.values);
          presetsRow.appendChild(b);
        }});
      }} else {{
        const presets = [
          {{ label: "Padrão Conservador", values: {{ learning_rate: 0.05, momentum: 0.8, noise: 0.02 }} }},
          {{ label: "Convergência Rápida", values: {{ learning_rate: 0.25, momentum: 0.9, noise: 0.05 }} }},
          {{ label: "Divergência / Instável", values: {{ learning_rate: 0.95, momentum: 0.95, noise: 0.3 }} }},
        ];
        presets.forEach(pr => {{
          const b = document.createElement("button");
          b.className = "preset-btn";
          b.textContent = pr.label;
          b.onclick = () => applyPreset(pr.values);
          presetsRow.appendChild(b);
        }});
      }}

      function applyPreset(presetValues) {{
        Object.keys(presetValues).forEach(k => {{
          if (state.params[k] !== undefined) {{
            state.params[k] = presetValues[k];
            const slider = document.getElementById(`slider_${{k}}`);
            const readout = document.getElementById(`readout_${{k}}`);
            if (slider) slider.value = presetValues[k];
            const conf = PARAM_CONFIG.find(p => p.id === k);
            const unit = conf ? conf.unit : "";
            if (readout) readout.textContent = `${{presetValues[k]}} ${{unit}}`.trim();
          }}
        }});
        updateIntuition();
      }}

      function updateIntuition() {{
        if (ARCHETYPE === "softmax") {{
          const tau = state.params.tau !== undefined ? state.params.tau : 0.7;
          const topK = state.params.top_k !== undefined ? state.params.top_k : 5;
          if (tau < 0.25) {{
            dynamicIntuition.innerHTML = "⚡ <b>Regime Quase-Determinístico:</b> Com τ baixo, a maior probabilidade esmaga todas as outras. O modelo repete padrões fixos sem explorar sinônimos.";
            dynamicIntuition.style.color = "var(--coral)";
          }} else if (tau > 1.4) {{
            dynamicIntuition.innerHTML = "⚡ <b>Regime de Alta Entropia:</b> Com τ alto, a distribuição achata tendendo à uniforme. Risco crítico de alucinações gramaticais e perda de foco conceitual.";
            dynamicIntuition.style.color = "var(--amber)";
          }} else {{
            dynamicIntuition.innerHTML = `⚡ <b>Regime Calibrado (τ=${{tau.toFixed(2)}}, Top-k=${{topK}}):</b> Equilíbrio ideal entre rigidez lógica e fluidez lexical. Trunca os ${{topK}} tokens mais promissores.`;
            dynamicIntuition.style.color = "var(--emerald)";
          }}
        }} else if (ARCHETYPE === "attention") {{
          const scale = state.params.dk_scale || 1.0;
          const mask = state.params.masking;
          if (scale < 0.4) {{
            dynamicIntuition.innerHTML = "⚡ <b>Gradientes Desvanecentes:</b> Sem o fator 1/√d_k, produtos escalares explodem para dimensões altas e saturam o softmax em gradientes quase nulos.";
            dynamicIntuition.style.color = "var(--coral)";
          }} else {{
            dynamicIntuition.innerHTML = `⚡ <b>Atenção Estabilizada:</b> O fator 1/√d_k mantém a variância unitária Var(q·k)=1. Máscara causal: ${{mask ? "Ativa (triangular)" : "Desativada (bidirecional)"}}.`;
            dynamicIntuition.style.color = "var(--emerald)";
          }}
        }} else {{
          const lr = state.params.learning_rate || state.params.param_alpha || 0.15;
          if (lr > 0.7) {{
            dynamicIntuition.innerHTML = "⚡ <b>Passo Crítico / Oscilação:</b> Taxa excessiva faz a trajetória oscilar violentamente nas paredes do gradiente, podendo divergir.";
            dynamicIntuition.style.color = "var(--coral)";
          }} else {{
            dynamicIntuition.innerHTML = `⚡ <b>Convergência Estável:</b> Gradientes amortecidos pelo momentum descem suavemente em direção ao ponto de sela / mínimo global.`;
            dynamicIntuition.style.color = "var(--emerald)";
          }}
        }}
      }}

      // Canvas Resizing with DPR
      let dpr = window.devicePixelRatio || 1;
      let width = 0;
      let height = 0;

      function resize() {{
        const rect = canvas.getBoundingClientRect();
        width = rect.width;
        height = rect.height;
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        ctx.resetTransform();
        ctx.scale(dpr, dpr);
      }}

      window.addEventListener("resize", resize);
      resize();

      // Mouse tracking for tooltips & interactive hover
      canvas.addEventListener("mousemove", (e) => {{
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (ARCHETYPE === "softmax") {{
          const n = Math.min(state.params.num_tokens || 6, CANDIDATE_TOKENS.length);
          const barWidth = (width - 120) / n;
          const startX = 60;
          if (mouseX >= startX && mouseX <= startX + n * barWidth && mouseY >= 40 && mouseY <= height - 50) {{
            state.hoveredIndex = Math.floor((mouseX - startX) / barWidth);
          }} else {{
            state.hoveredIndex = -1;
          }}
        }}
      }});

      canvas.addEventListener("mouseleave", () => {{
        state.hoveredIndex = -1;
      }});

      // Buttons
      btnPlayPause.addEventListener("click", () => {{
        state.running = !state.running;
        btnPlayPause.textContent = state.running ? "⏸ Pausar" : "▶ Retomar";
        valState.textContent = state.running ? "Executando" : "Pausado";
        valState.className = state.running ? "metric-value emerald" : "metric-value coral";
      }});

      btnStep.addEventListener("click", () => {{
        state.step += 1;
        stepCounter.textContent = `Passo: ${{state.step}}`;
        render();
      }});

      btnReset.addEventListener("click", () => {{
        state.step = 0;
        PARAM_CONFIG.forEach(p => {{
          state.params[p.id] = p.default;
          const slider = document.getElementById(`slider_${{p.id}}`);
          const readout = document.getElementById(`readout_${{p.id}}`);
          if (slider) slider.value = p.default;
          if (readout) readout.textContent = `${{p.default}} ${{p.unit}}`.trim();
        }});
        stepCounter.textContent = "Passo: 0";
        updateIntuition();
        render();
      }});

      // Softmax Calculation with Temperature and Top-k
      function computeSoftmax(tau, topK, count) {{
        const n = Math.min(count, CANDIDATE_TOKENS.length);
        const logits = BASE_LOGITS.slice(0, n);

        // Scaled logits z_i / tau
        const scaled = logits.map((z, idx) => {{
          // subtle oscillation over time if running
          const osc = state.running ? Math.sin(state.step * 0.04 + idx * 1.2) * 0.15 : 0;
          return (z + osc) / Math.max(tau, 0.01);
        }});

        // Numerical stability: subtract max
        const maxZ = Math.max(...scaled);
        const exps = scaled.map(s => Math.exp(s - maxZ));

        // Sort indices for top-k
        const indices = exps.map((_, i) => i);
        indices.sort((a, b) => exps[b] - exps[a]);

        const topKSet = new Set(indices.slice(0, topK));

        // Apply Top-k zeroing
        const filteredExps = exps.map((e, i) => topKSet.has(i) ? e : 0);
        const sumExp = filteredExps.reduce((a, b) => a + b, 0) || 1e-9;

        const probs = filteredExps.map(e => e / sumExp);

        // Shannon entropy H = - sum p * log2(p)
        let entropy = 0;
        probs.forEach(p => {{
          if (p > 1e-9) entropy -= p * Math.log2(p);
        }});

        return {{ probs, logits, scaled, topKSet, entropy }};
      }}

      // Main Render Loop
      function render() {{
        ctx.clearRect(0, 0, width, height);

        if (ARCHETYPE === "softmax") {{
          renderSoftmaxView();
        }} else if (ARCHETYPE === "attention") {{
          renderAttentionView();
        }} else {{
          renderGenericOptimizerView();
        }}
      }}

      function renderSoftmaxView() {{
        const tau = state.params.tau !== undefined ? state.params.tau : 0.7;
        const topK = state.params.top_k !== undefined ? state.params.top_k : 5;
        const count = state.params.num_tokens !== undefined ? state.params.num_tokens : 6;

        const {{ probs, topKSet, entropy }} = computeSoftmax(tau, topK, count);

        // Update HUD
        const maxProb = Math.max(...probs);
        const argmaxIdx = probs.indexOf(maxProb);
        valEntropy.textContent = `${{entropy.toFixed(3)}} bits`;
        valMaxP.textContent = `${{(maxProb * 100).toFixed(1)}}%`;
        valTopToken.textContent = CANDIDATE_TOKENS[argmaxIdx] || "--";

        // Layout parameters
        const paddingLeft = 50;
        const paddingBottom = 60;
        const paddingTop = 40;
        const plotHeight = height - paddingTop - paddingBottom;
        const n = probs.length;
        const availableWidth = width - paddingLeft - 30;
        const barWidth = Math.max(24, Math.floor(availableWidth / n) - 16);
        const barGap = Math.floor((availableWidth - n * barWidth) / (n + 1));

        // Grid lines
        ctx.strokeStyle = "#242424";
        ctx.lineWidth = 1;
        [0.25, 0.5, 0.75, 1.0].forEach(level => {{
          const y = paddingTop + plotHeight * (1 - level);
          ctx.beginPath();
          ctx.moveTo(paddingLeft - 10, y);
          ctx.lineTo(width - 20, y);
          ctx.stroke();

          ctx.fillStyle = "#666666";
          ctx.font = "10px JetBrains Mono, monospace";
          ctx.textAlign = "right";
          ctx.fillText(`${{Math.round(level * 100)}}%`, paddingLeft - 14, y + 3);
        }});

        // Draw baseline axis
        ctx.strokeStyle = "#434343";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(paddingLeft - 10, paddingTop + plotHeight);
        ctx.lineTo(width - 20, paddingTop + plotHeight);
        ctx.stroke();

        // Draw Probability Bars
        probs.forEach((p, idx) => {{
          const x = paddingLeft + barGap + idx * (barWidth + barGap);
          const barH = plotHeight * p;
          const y = paddingTop + plotHeight - barH;
          const isTop = topKSet.has(idx);
          const isArgmax = idx === argmaxIdx;
          const isHovered = idx === state.hoveredIndex;

          // Bar Gradient
          const grad = ctx.createLinearGradient(x, y, x, paddingTop + plotHeight);
          if (isArgmax) {{
            grad.addColorStop(0, "#34d399");
            grad.addColorStop(1, "#184e37");
          }} else if (isTop) {{
            grad.addColorStop(0, "#60a5fa");
            grad.addColorStop(1, "#1e3a5f");
          }} else {{
            grad.addColorStop(0, "#4a4a4a");
            grad.addColorStop(1, "#202020");
          }}

          ctx.fillStyle = grad;
          ctx.fillRect(x, y, barWidth, barH);

          // Border
          ctx.strokeStyle = isHovered ? "#ffffff" : (isArgmax ? "#34d399" : (isTop ? "#60a5fa" : "#333333"));
          ctx.lineWidth = isHovered ? 2 : 1;
          ctx.strokeRect(x, y, barWidth, barH);

          // Percentage Label above bar
          ctx.fillStyle = isArgmax ? "#34d399" : (isTop ? "#e6e6e6" : "#777777");
          ctx.font = isArgmax ? "bold 11px JetBrains Mono, monospace" : "10px JetBrains Mono, monospace";
          ctx.textAlign = "center";
          ctx.fillText(`${{(p * 100).toFixed(1)}}%`, x + barWidth / 2, y - 6);

          // Token label below axis
          ctx.fillStyle = isArgmax ? "#34d399" : "#a0a0a0";
          ctx.font = "11px JetBrains Mono, monospace";
          ctx.textAlign = "center";
          ctx.save();
          ctx.translate(x + barWidth / 2, paddingTop + plotHeight + 16);
          ctx.rotate(-0.35);
          ctx.fillText(CANDIDATE_TOKENS[idx] || `t_${{idx}}`, 0, 0);
          ctx.restore();
        }});

        // Legend / Indicator
        ctx.fillStyle = "#8d8d8d";
        ctx.font = "10.5px JetBrains Mono, monospace";
        ctx.textAlign = "left";
        ctx.fillText(`Top-${{topK}} Ativo · Distribuição P(w|prompt; τ=${{tau.toFixed(2)}})`, paddingLeft, 22);
      }}

      function renderAttentionView() {{
        const n = Math.min(state.params.seq_len || 6, 8);
        const scale = state.params.dk_scale || 1.0;
        const mask = state.params.masking !== undefined ? state.params.masking : 1;

        valEntropy.textContent = `${{n}} tokens`;
        valMaxP.textContent = `${{(1.0 / Math.sqrt(n * 64)).toFixed(3)}}`;
        valTopToken.textContent = `Q${{n-1}} → K0`;

        const gridSize = Math.min(width - 120, height - 80);
        const cellSize = Math.floor(gridSize / n);
        const startX = 60;
        const startY = 40;

        ctx.fillStyle = "#8d8d8d";
        ctx.font = "11px JetBrains Mono, monospace";
        ctx.textAlign = "left";
        ctx.fillText(`Matriz de Atenção A_ij = softmax(Q_i K_j^T · ${{scale.toFixed(1)}}/√d_k)`, startX, 22);

        for (let r = 0; r < n; r++) {{
          for (let c = 0; c < n; c++) {{
            const x = startX + c * cellSize;
            const y = startY + r * cellSize;

            let weight = 0;
            if (mask && c > r) {{
              weight = 0;
            }} else {{
              const dist = Math.abs(r - c);
              weight = Math.exp(-dist * 0.8 * scale) * (0.8 + 0.2 * Math.sin(state.step * 0.05 + r + c));
            }}

            const brightness = Math.min(1.0, weight);
            ctx.fillStyle = (mask && c > r)
              ? "#121212"
              : `rgba(52, 211, 153, ${{brightness * 0.95 + 0.05}})`;
            ctx.fillRect(x, y, cellSize - 2, cellSize - 2);

            ctx.strokeStyle = "#2a2a2a";
            ctx.lineWidth = 1;
            ctx.strokeRect(x, y, cellSize - 2, cellSize - 2);

            if (cellSize >= 32) {{
              ctx.fillStyle = brightness > 0.45 ? "#10231b" : "#8d8d8d";
              ctx.font = "10px JetBrains Mono, monospace";
              ctx.textAlign = "center";
              ctx.fillText(weight.toFixed(2), x + cellSize / 2, y + cellSize / 2 + 3);
            }}
          }}
        }}
      }}

      function renderGenericOptimizerView() {{
        valEntropy.textContent = `${{(2.4 * Math.exp(-state.step * 0.015)).toFixed(3)}} L`;
        valMaxP.textContent = `${{state.params.learning_rate || state.params.param_alpha || 0.15}} η`;
        valTopToken.textContent = `Step ${{state.step}}`;

        const cx = width / 2;
        const cy = height / 2;

        // Contour rings
        ctx.strokeStyle = "#2a2a2a";
        ctx.lineWidth = 1;
        for (let r = 20; r < Math.min(width, height) / 2 - 20; r += 24) {{
          ctx.beginPath();
          ctx.ellipse(cx, cy, r * 1.3, r, 0.2, 0, Math.PI * 2);
          ctx.stroke();
        }}

        // Particle descending gradient
        const t = state.step * 0.03;
        const lr = state.params.learning_rate || state.params.param_alpha || 0.15;
        const decay = Math.max(0.1, 1.0 - t * 0.08 * lr);
        const px = cx + Math.cos(t * 2) * 140 * decay;
        const py = cy + Math.sin(t * 3) * 90 * decay;

        // Gradient vector arrow
        ctx.strokeStyle = "#f87171";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - (px - cx) * 0.2, py - (py - cy) * 0.2);
        ctx.stroke();

        // Particle dot
        ctx.fillStyle = "#34d399";
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();

        ctx.fillStyle = "#8d8d8d";
        ctx.font = "11px JetBrains Mono, monospace";
        ctx.textAlign = "center";
        ctx.fillText("Trajetória no Espaço de Perda L(w1, w2)", cx, height - 20);
      }}

      // Animation tick
      function animate() {{
        if (state.running) {{
          state.step += 1;
          stepCounter.textContent = `Passo: ${{state.step}}`;
        }}
        render();
        requestAnimationFrame(animate);
      }}

      updateIntuition();
      animate();
    }})();
  </script>
</body>
</html>
"""


def save_demo_to_vault(
    vault_path: Path | str,
    title: str,
    topic: str,
    description: str,
    lesson_rel_path: str | None = None,
    parameters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Write self-contained HTML simulator to <vault_path>/viz/demos/<slug>.html.

    Optionally links into an existing or new lesson note in Aulas/ or Lessons/
    via surgical non-destructive merge (preserving all user notes).
    """
    clean_vault = Path(vault_path).resolve()
    slug = _slugify(title)

    # Invariant 4: viz/ directory structure
    target_dir = clean_vault / "viz" / "demos"
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"{slug}.html"

    # Generate HTML content
    html_content = generate_interactive_demo_html(
        title=title,
        topic=topic,
        description=description,
        parameters=parameters,
    )

    # Write simulator atomically
    target_path.write_text(html_content, encoding="utf-8")
    logger.info("Saved interactive demo to %s", target_path)

    # Link into lesson note if requested
    if lesson_rel_path:
        lesson_file = clean_vault / lesson_rel_path.strip().lstrip("/")
        lesson_title = lesson_file.stem
        if lesson_file.exists():
            try:
                txt = lesson_file.read_text(encoding="utf-8")
                match = re.search(r"^#\s+(.+)$", txt, re.MULTILINE)
                if match:
                    lesson_title = match.group(1).strip()
            except Exception:
                pass

        demo_link = f"[[viz/demos/{slug}.html|Simulador Interativo: {title}]]"
        section_md = (
            f"{demo_link}\n\n"
            f"> [!tip] **Simulador Interativo: {title}**\n"
            f"> {description.strip()}\n"
        )

        try:
            merge_lesson_note(
                vault_path=clean_vault,
                rel_path=lesson_rel_path,
                title=lesson_title,
                node_section_title=f"Simulador: {title}",
                node_section_md=section_md,
            )
            logger.info("Linked demo [[viz/demos/%s.html]] into %s", slug, lesson_rel_path)
        except Exception as err:
            logger.warning("Failed to link demo into lesson note %s: %s", lesson_rel_path, err)

    rel_path = f"viz/demos/{slug}.html"
    return {
        "slug": slug,
        "rel_path": rel_path,
        "abs_path": str(target_path),
        "title": title,
        "topic": topic,
        "description": description,
        "html": html_content,
    }


def load_demo_from_vault(vault_path: Path | str, slug: str) -> dict[str, Any]:
    """Load interactive demo HTML and metadata from <vault_path>/viz/demos/<slug>.html."""
    clean_vault = Path(vault_path).resolve()
    clean_slug = slug.strip().removesuffix(".html")

    target_path = clean_vault / "viz" / "demos" / f"{clean_slug}.html"
    if not target_path.exists():
        raise FileNotFoundError(f"Demo '{clean_slug}' not found in {clean_vault / 'viz' / 'demos'}")

    html_content = target_path.read_text(encoding="utf-8")

    # Extract metadata from JSON script if present
    meta: dict[str, Any] = {}
    json_match = re.search(
        r'<script type="application/json" id="demo-meta">\s*(\{.*?\})\s*</script>',
        html_content,
        re.DOTALL,
    )
    if json_match:
        try:
            meta = json.loads(json_match.group(1))
        except Exception:
            meta = {}

    title = meta.get("title")
    if not title:
        title_match = re.search(r"<title>(.*?)</title>", html_content, re.IGNORECASE)
        title = title_match.group(1).strip() if title_match else clean_slug

    topic = meta.get("topic") or "generic"
    description = meta.get("description") or ""
    parameters = meta.get("parameters") or []

    return {
        "slug": clean_slug,
        "title": title,
        "topic": topic,
        "description": description,
        "parameters": parameters,
        "rel_path": f"viz/demos/{clean_slug}.html",
        "abs_path": str(target_path),
        "html": html_content,
    }


async def spawn_demo(
    title: str,
    topic: str,
    description: str,
    lesson_rel_path: str | None = None,
    parameters: list[dict[str, Any]] | None = None,
    vault_path: str | None = None,
) -> dict[str, Any]:
    """MCP tool implementation to spawn an interactive simulator into the Vault."""
    v_path = Path(vault_path) if vault_path else get_default_vault_path()
    res = save_demo_to_vault(
        vault_path=v_path,
        title=title,
        topic=topic,
        description=description,
        lesson_rel_path=lesson_rel_path,
        parameters=parameters,
    )
    return res
