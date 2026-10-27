"""Vault bootstrap and configuration management.

Detects existing vaults (Case B, e.g. Obsidian AI Engineering) without modifying
user files, or creates a fresh vault structure (Case A).
Persists configuration into .harness/config.json with atomic writes.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from learnharness.core.contracts.config import (
    HarnessConfig,
    TrackConfig,
    TrackItem,
    TrackMode,
    VaultFolderMap,
    derive_track_title,
)
from learnharness.core.slug import ascii_slug
from learnharness.vault.safety import atomic_write, locked_path, safe_path, validate_folders

logger = logging.getLogger(__name__)

AULA_TEMPLATE_PT = """---
tags: [aula]
fonte: livre        # mentoria | currículo | livre
data: {{date}}
status: em andamento   # em andamento | concluída
---
# {{title}}

**Objetivo:** 
**Fontes:** 

## Ponto de partida
<!-- resultado da sondagem: o que já estava sólido, onde estava a borda -->

## Mapa de dependências
```mermaid
graph TD
```

## Desdobrando
<!-- a explicação construída na sessão, nó por nó, com links para [[Conceitos]] -->

## Quizzes
<!-- placar e os erros que valem lembrar -->

## Desenho
<!-- ![[...excalidraw|600]] + revisão -->

## Próximos passos
"""

CONCEITO_TEMPLATE_PT = """---
tags: [conceito]
status: aprendendo
fontes: []
criado: {{date}}
---
# {{title}}

**Verdade incondicional / definição:** 

Depende de:: 
Usado em:: 

## Mecanismo
<!-- como funciona por dentro: matemática, código (fonte típica: currículo) -->

## Na prática
<!-- quando e por que usar, trade-offs, produção (fonte típica: mentoria) -->

## Onde as fontes divergem

## Como eu poderia ter descoberto isso

## Erros que eu cometi

## Desenhos
"""

MAPA_TEMPLATE_PT = """---
tags: [mapa]
---
# Mapa — AI Engineering

Índice do vault. O Lapidare atualiza esta nota ao consolidar cada aula.

## Como o vault funciona
- **[[Conceitos/]]** — os *nós* do grafo de conhecimento. Uma nota por conceito; `Depende de::` são as *arestas*.
- **Aulas/** — a versão explicada de cada aula, por fonte: `Mentoria/`, `Currículo/`, `Livre/`.
- **Fontes/Mentoria/** — transcripts brutos da mentoria, intactos.
- **Desenhos/** — consolidação à mão (Excalidraw + mesa digitalizadora).
- **Sessões/** — registro bruto das sessões de estudo.
- **viz/** — diagramas gerados.

## Trilha — Mentoria
| Módulo | Fontes | Blocos | Status |
|---|---|---|---|

## Trilha — Currículo (ai-engineering-from-scratch)
| Etapa | Mentoria | Currículo junto | Base (2:1) | Status |
|---|---|---|---|---|

## Conceitos por status
- **Aprendendo:** 
- **Sólido:** 
- **Revisar:** 
"""

AULA_TEMPLATE_EN = """---
tags: [lesson]
source: free        # mentorship | curriculum | free
date: {{date}}
status: in_progress   # in_progress | completed
---
# {{title}}

**Objective:** 
**Sources:** 

## Starting Point
<!-- prober results: prior knowledge and knowledge boundary -->

## Dependency Map
```mermaid
graph TD
```

## Unfolding
<!-- built explanation node-by-node with [[Concepts]] links -->

## Quizzes
<!-- score and memorable mistakes -->

## Drawing
<!-- ![[...excalidraw|600]] + review -->

## Next Steps
"""

CONCEITO_TEMPLATE_EN = """---
tags: [concept]
status: learning
sources: []
created: {{date}}
---
# {{title}}

**Unconditional truth / definition:** 

Depends on:: 
Used in:: 

## Mechanism
<!-- inner workings: math, code -->

## In Practice
<!-- tradeoffs, production practices -->

## Where Sources Diverge

## How I Could Have Discovered This

## Mistakes I Made

## Drawings
"""

MAPA_TEMPLATE_EN = """---
tags: [map]
---
# Map — AI Engineering

Index of the vault. Lapidare updates this note after consolidating lessons.

## Vault Structure
- **[[Concepts/]]** — Knowledge graph nodes.
- **Lessons/** — Explained lessons: `Mentorship/`, `Curriculum/`, `Free/`.
- **Sources/Mentorship/** — Raw mentorship transcripts, read-only.
- **Drawings/** — Hand drawings (Excalidraw).
- **Sessions/** — Raw study sessions.
- **viz/** — Generated diagrams.

## Track — Mentorship
| Module | Sources | Blocks | Status |
|---|---|---|---|

## Track — Curriculum
| Stage | Mentorship | Parallel Curriculum | Base (2:1) | Status |
|---|---|---|---|---|
"""



def parse_track_tables(mapa_content: str) -> list[TrackItem]:
    """Parse track tables from 00 Mapa.md (both Mentoria and Currículo)."""
    items: list[TrackItem] = []

    # Parse Mentoria Table
    mentoria_match = re.search(
        r"##\s+Trilha\s+[—–-]\s+Mentoria\s*\n(.*?)(?=\n##|\Z)",
        mapa_content,
        re.DOTALL | re.IGNORECASE,
    )
    if mentoria_match:
        table_text = mentoria_match.group(1)
        for line in table_text.strip().splitlines():
            line = line.strip()
            if (
                not line.startswith("|")
                or line.startswith("|---")
                or "Módulo" in line
                or "Module" in line
            ):
                continue
            cols = [c.strip() for c in line.split("|")[1:-1]]
            if len(cols) >= 4:
                raw_mod, raw_blocks, raw_status = cols[0], cols[2], cols[3]
                # Extract wikilink [[link|title]] or [[title]]
                wiki_match = re.search(r"\[\[([^\|\]]+)(?:\|([^\]]+))?\]\]", raw_mod)
                if wiki_match:
                    source_ref = wiki_match.group(1).strip()
                    title = wiki_match.group(2).strip() if wiki_match.group(2) else source_ref
                else:
                    source_ref = None
                    title = raw_mod.strip()

                status_lower = raw_status.lower()
                is_completed = (
                    "concluído" in status_lower
                    or "concluída" in status_lower
                    or "completed" in status_lower
                ) and not (
                    "próximo" in status_lower
                    or "em andamento" in status_lower
                    or "aguardando" in status_lower
                )

                item_id = f"mentoria-{ascii_slug(title)}"
                items.append(
                    TrackItem(
                        id=item_id,
                        title=title,
                        kind="mentoria",
                        source_ref=source_ref,
                        stage_label=raw_blocks,
                        status_detail=raw_status,
                        completed=is_completed,
                    )
                )

    # Parse Currículo Table
    curriculo_match = re.search(
        r"##\s+Trilha\s+[—–-]\s+Curr[íi]culo[^\n]*\n(.*?)(?=\n##|\Z)",
        mapa_content,
        re.DOTALL | re.IGNORECASE,
    )
    if curriculo_match:
        table_text = curriculo_match.group(1)
        for line in table_text.strip().splitlines():
            line = line.strip()
            if (
                not line.startswith("|")
                or line.startswith("|---")
                or "Etapa" in line
                or "Stage" in line
            ):
                continue
            cols = [c.strip() for c in line.split("|")[1:-1]]
            if len(cols) >= 5:
                etapa, mentoria_ref, curriculo_junto, base_ref, raw_status = (
                    cols[0],
                    cols[1],
                    cols[2],
                    cols[3],
                    cols[4],
                )
                status_lower = raw_status.lower()
                is_completed = (
                    "concluído" in status_lower
                    or "concluída" in status_lower
                    or "completed" in status_lower
                ) and not (
                    "em andamento" in status_lower
                    or "a fazer" in status_lower
                    or "in_progress" in status_lower
                )
                title = f"Etapa {etapa}" if not etapa.lower().startswith("etapa") else etapa
                item_id = f"curriculo-{ascii_slug(etapa)}"
                items.append(
                    TrackItem(
                        id=item_id,
                        title=title,
                        kind="curriculo",
                        source_ref=f"Mentoria: {mentoria_ref} · Base: {base_ref} · Currículo: {curriculo_junto}",
                        stage_label=etapa,
                        status_detail=raw_status,
                        completed=is_completed,
                    )
                )

    return items


def parse_learning_md(learning_content: str) -> list[TrackItem]:
    """Parse study queue from LEARNING.md if present."""
    items: list[TrackItem] = []
    queue_match = re.search(
        r"##\s+Study queue\s*\n(.*?)(?=\n##|\Z)",
        learning_content,
        re.DOTALL | re.IGNORECASE,
    )
    if not queue_match:
        return items

    current_stage = ""
    for line in queue_match.group(1).splitlines():
        line = line.strip()
        stage_header = re.match(r"###\s+(.*)", line)
        if stage_header:
            current_stage = stage_header.group(1).strip()
            continue

        item_match = re.match(r"^-\s*\[([ xX])\]\s*(.*)", line)
        if item_match:
            is_checked = item_match.group(1).lower() == "x"
            item_text = item_match.group(2).strip()
            item_id = f"queue-{ascii_slug(item_text[:30])}"
            items.append(
                TrackItem(
                    id=item_id,
                    title=item_text,
                    kind="curriculo" if "mentoria:" not in item_text else "mentoria",
                    stage_label=current_stage,
                    status_detail="concluída" if is_checked else "a fazer",
                    completed=is_checked,
                )
            )
    return items


def determine_active_item_id(queue: list[TrackItem]) -> str | None:
    """Identify the active item: first item in progress, awaiting screening, or to-do."""
    # Priority 1: items explicitly marked as in progress or awaiting screening
    for item in queue:
        if item.completed:
            continue
        status_lower = item.status_detail.lower()
        if (
            "em andamento" in status_lower
            or "in_progress" in status_lower
            or "aguardando triagem" in status_lower
            or "triagem feita" in status_lower
        ):
            return item.id

    # Priority 2: first item marked as to-do
    for item in queue:
        if item.completed:
            continue
        status_lower = item.status_detail.lower()
        if "a fazer" in status_lower or "todo" in status_lower or status_lower == "":
            return item.id

    # Priority 3: first non-completed item in queue
    for item in queue:
        if not item.completed:
            return item.id

    return None


def _bootstrap_track(
    language: str,
    repo_path: Path | None,
    learning_md_path: Path | None,
    queue: list[TrackItem],
    active_item_id: str | None,
) -> TrackConfig | None:
    """The first track of a freshly configured vault (repository and/or parsed queue)."""
    if not (repo_path or queue):
        return None
    track = TrackConfig(
        source="repo" if repo_path else "manual",
        mode=TrackMode.REPO_LEVELING,
        repo_path=str(repo_path.resolve()) if repo_path else None,
        learning_md_path=str(learning_md_path.resolve()) if learning_md_path else None,
        active_item_id=active_item_id,
        queue=queue,
        created_at=datetime.now(UTC).isoformat(),
    )
    track.title = derive_track_title(track, language)
    return track


def bootstrap_vault(
    vault_path: Path,
    language: Literal["pt-BR", "en"] = "pt-BR",
    repo_path: Path | None = None,
) -> HarnessConfig:
    """Inspect and configure the vault.

    Case A (New/Empty vault):
        Creates full directory tree, faithful templates, index file, and initializes .harness/config.json.
    Case B (Existing vault, e.g. /home/lazarodiza/Documents/AI Engineering):
        Preserves all existing markdown files.
        Detects folders, parses 00 Mapa.md and LEARNING.md, detects active track item,
        and creates .harness/config.json.
    """
    vault_path = Path(vault_path).resolve()
    harness_dir = safe_path(vault_path, ".harness")
    sessions_dir = safe_path(vault_path, ".harness/sessions")
    if safe_path(vault_path, ".harness/config.json").exists():
        return load_config(vault_path)

    # Check whether vault is empty or new (ignoring dotfiles/folders)
    existing_visible = (
        [p for p in vault_path.iterdir() if not p.name.startswith(".")]
        if vault_path.exists()
        else []
    )
    is_new_vault = len(existing_visible) == 0

    if is_new_vault:
        # CASE A: Initialize new vault structure
        if language == "pt-BR":
            folder_map = VaultFolderMap(
                map_file="00 Mapa.md",
                lessons_dir="Aulas",
                concepts_dir="Conceitos",
                sources_dir="Fontes",
                drawings_dir="Desenhos",
                sessions_dir="Sessões",
                templates_dir="Templates",
                viz_dir="viz",
            )
            # Create directories
            for sub in [
                "Aulas/Mentoria",
                "Aulas/Currículo",
                "Aulas/Livre",
                "Conceitos",
                "Fontes/Mentoria",
                "Desenhos",
                "Sessões",
                "Templates",
                "viz/demos",
            ]:
                safe_path(vault_path, sub).mkdir(parents=True, exist_ok=True)

            # Write default templates and map
            (vault_path / "Templates" / "Aula.md").write_text(AULA_TEMPLATE_PT, encoding="utf-8")
            (vault_path / "Templates" / "Conceito.md").write_text(
                CONCEITO_TEMPLATE_PT, encoding="utf-8"
            )
            (vault_path / "00 Mapa.md").write_text(MAPA_TEMPLATE_PT, encoding="utf-8")
        else:
            folder_map = VaultFolderMap(
                map_file="00 Map.md",
                lessons_dir="Lessons",
                concepts_dir="Concepts",
                sources_dir="Sources",
                drawings_dir="Drawings",
                sessions_dir="Sessions",
                templates_dir="Templates",
                viz_dir="viz",
            )
            for sub in [
                "Lessons/Mentorship",
                "Lessons/Curriculum",
                "Lessons/Free",
                "Concepts",
                "Sources/Mentorship",
                "Drawings",
                "Sessions",
                "Templates",
                "viz/demos",
            ]:
                safe_path(vault_path, sub).mkdir(parents=True, exist_ok=True)

            (vault_path / "Templates" / "Lesson.md").write_text(AULA_TEMPLATE_EN, encoding="utf-8")
            (vault_path / "Templates" / "Concept.md").write_text(
                CONCEITO_TEMPLATE_EN, encoding="utf-8"
            )
            (vault_path / "00 Map.md").write_text(MAPA_TEMPLATE_EN, encoding="utf-8")

        sessions_dir.mkdir(parents=True, exist_ok=True)

        config = HarnessConfig(
            configured=True,
            language=language,
            vault_path=str(vault_path),
            folders=folder_map,
        )
        track = _bootstrap_track(
            language, repo_path,
            repo_path / "LEARNING.md" if repo_path and (repo_path / "LEARNING.md").exists() else None,
            [], None,
        )
        if track:
            config.tracks = [track]
            config.active_track_id = track.id
        save_config(vault_path, config)
        return config

    # CASE B: Adopting existing vault (Never overwrite any markdown file!)
    sessions_dir.mkdir(parents=True, exist_ok=True)

    # Detect folder naming scheme
    map_file = (
        "00 Mapa.md"
        if (vault_path / "00 Mapa.md").exists()
        else (
            "00 Map.md"
            if (vault_path / "00 Map.md").exists()
            else ("00 Map.md" if language == "en" else "00 Mapa.md")
        )
    )
    lessons_dir = (
        "Aulas"
        if (vault_path / "Aulas").exists()
        else (
            "Lessons"
            if (vault_path / "Lessons").exists()
            else ("Lessons" if language == "en" else "Aulas")
        )
    )
    concepts_dir = (
        "Conceitos"
        if (vault_path / "Conceitos").exists()
        else (
            "Concepts"
            if (vault_path / "Concepts").exists()
            else ("Concepts" if language == "en" else "Conceitos")
        )
    )
    sources_dir = (
        "Fontes"
        if (vault_path / "Fontes").exists()
        else (
            "Sources"
            if (vault_path / "Sources").exists()
            else ("Sources" if language == "en" else "Fontes")
        )
    )
    drawings_dir = (
        "Desenhos"
        if (vault_path / "Desenhos").exists()
        else (
            "Drawings"
            if (vault_path / "Drawings").exists()
            else ("Drawings" if language == "en" else "Desenhos")
        )
    )
    sessoes_dir = (
        "Sessões"
        if (vault_path / "Sessões").exists()
        else (
            "Sessions"
            if (vault_path / "Sessions").exists()
            else ("Sessions" if language == "en" else "Sessões")
        )
    )
    templates_dir = "Templates"
    viz_dir = "viz"

    folder_map = VaultFolderMap(
        map_file=map_file,
        lessons_dir=lessons_dir,
        concepts_dir=concepts_dir,
        sources_dir=sources_dir,
        drawings_dir=drawings_dir,
        sessions_dir=sessoes_dir,
        templates_dir=templates_dir,
        viz_dir=viz_dir,
    )

    for value in folder_map.model_dump().values():
        safe_path(vault_path, value)

    track_items: list[TrackItem] = []

    # 1. Parse 00 Mapa.md
    mapa_path = vault_path / map_file
    if mapa_path.exists():
        try:
            mapa_content = mapa_path.read_text(encoding="utf-8")
            track_items.extend(parse_track_tables(mapa_content))
        except (OSError, ValueError) as exc:
            # User-authored map: tolerate it (track stays empty), but never silently.
            # ValueError covers UnicodeDecodeError and pydantic ValidationError.
            logger.warning("Could not parse track tables from %s: %s", mapa_path, exc)

    # 2. Parse LEARNING.md if available
    learning_md_path: Path | None = None
    if repo_path and (repo_path / "LEARNING.md").exists():
        learning_md_path = repo_path / "LEARNING.md"
    elif (vault_path / "LEARNING.md").exists():
        learning_md_path = vault_path / "LEARNING.md"

    if learning_md_path and learning_md_path.exists():
        try:
            learning_content = learning_md_path.read_text(encoding="utf-8")
            learning_items = parse_learning_md(learning_content)
            # If no items from 00 Mapa.md, use learning_items; otherwise append granular queue
            if not track_items:
                track_items = learning_items
        except (OSError, ValueError) as exc:
            logger.warning("Could not parse study queue from %s: %s", learning_md_path, exc)

    active_id = determine_active_item_id(track_items)

    # Check for existing config to preserve user slots and MCP configs
    existing_config: HarnessConfig | None = None
    config_file = harness_dir / "config.json"
    if config_file.exists():
        # Only reachable if config.json appeared concurrently (the entry path returns
        # load_config early). A corrupt config must propagate, never be overwritten
        # with defaults: that would silently drop model slots and MCP servers.
        existing_config = load_config(vault_path)

    track = _bootstrap_track(language, repo_path, learning_md_path, track_items, active_id)
    if existing_config:
        config = existing_config
        config.vault_path = str(vault_path)
        config.folders = folder_map
        # Never replace tracks someone else already configured; only seed an empty config.
        if track and not config.tracks:
            config.tracks = [track]
            config.active_track_id = track.id
    else:
        config = HarnessConfig(
            configured=True,
            language=language,
            vault_path=str(vault_path),
            folders=folder_map,
        )
        if track:
            config.tracks = [track]
            config.active_track_id = track.id

    save_config(vault_path, config)
    return config


_CONFIG_CACHE: dict[Path, tuple[tuple[int, int, int], HarnessConfig]] = {}


def load_config(vault_path: Path) -> HarnessConfig:
    """Load configuration from .harness/config.json.

    Parsed once per file version: ``save_config`` replaces the file (new inode), so the
    ``(inode, size, mtime)`` key changes with every write. Callers own the returned copy.
    """
    config_path = safe_path(vault_path, ".harness/config.json")
    try:
        st = config_path.stat()
    except FileNotFoundError:
        raise FileNotFoundError(f"Configuration file not found at: {config_path}") from None
    key = (st.st_ino, st.st_size, st.st_mtime_ns)
    cached = _CONFIG_CACHE.get(config_path)
    if cached is None or cached[0] != key:
        config = HarnessConfig.model_validate(json.loads(config_path.read_text(encoding="utf-8")))
        validate_folders(vault_path, config.folders)
        cached = _CONFIG_CACHE[config_path] = (key, config)
    return cached[1].model_copy(deep=True)


def save_config(vault_path: Path, config: HarnessConfig) -> None:
    """Atomically save configuration to .harness/config.json."""
    validate_folders(vault_path, config.folders)
    safe_path(vault_path, ".harness")
    sessions = safe_path(vault_path, ".harness/sessions")
    sessions.mkdir(parents=True, exist_ok=True)
    target = safe_path(vault_path, ".harness/config.json")
    with locked_path(target):
        atomic_write(target, config.model_dump_json(indent=2))
