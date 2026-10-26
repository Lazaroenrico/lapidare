"""Adaptive track generation and non-destructive progress synchronization."""
from __future__ import annotations

import asyncio
import re
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel, Field

from learnharness.core.contracts.config import TrackItem, TrackMode
from learnharness.core.events import SseEventType
from learnharness.vault.bootstrap import save_config
from learnharness.vault.safety import atomic_write, locked_path, safe_path


class GeneratedTrack(BaseModel):
    items: list[TrackItem] = Field(min_length=1, max_length=100)


class TrackService:
    def __init__(self, state):
        self.state = state
        self.lock = asyncio.Lock()

    async def generate(self):
        config = self.state.get_config()
        if config.track.queue or config.track.mode == TrackMode.FREE:
            return config.track.model_dump(mode="json")
        context = config.track.goal_description or ""
        if config.track.repo_path:
            root = Path(config.track.repo_path).expanduser().resolve()
            if not root.is_dir():
                raise ValueError("Curriculum repository does not exist")
            documents = []
            for path in sorted(root.rglob("*.md")):
                if path.resolve().is_relative_to(root) and not any(p.startswith(".") or p in ("node_modules", "pratica") for p in path.relative_to(root).parts):
                    documents.append(f"FILE {path.relative_to(root)}\n{path.read_text(encoding='utf-8')[:6000]}")
                if len(documents) >= 60:
                    break
            context += "\n" + "\n\n".join(documents)
        if not context.strip():
            raise ValueError("Specify a goal or curriculum repository")
        engine = self.state.engine(config.slots.strong)
        result = await engine.run_structured(
            prompt="Build a dependency-aware learning track in the requested language. Return ordered main items, stable unique ids, actual source_ref only for listed files, prerequisites as item ids. Do not assume learner mastery: first lessons diagnose prerequisites with quizzes. Use ordered=true only for a genuinely linear prerequisite sequence.\nLanguage: " + config.language + "\n" + context,
            schema=GeneratedTrack, slot=config.slots.strong,
        )
        ids = {item.id for item in result.items}
        if len(ids) != len(result.items) or any(p not in ids for item in result.items for p in item.prerequisites):
            raise ValueError("Generated track contains duplicate or unknown prerequisites")
        from learnharness.core.contracts.session import PlanDag, PlanNode
        PlanDag(nodes=[PlanNode(id=i.id, label=i.title, depends_on=i.prerequisites) for i in result.items])
        for item in result.items:
            if item.source_ref and config.track.repo_path:
                path = safe_path(Path(config.track.repo_path).expanduser().resolve(), item.source_ref)
                if not path.is_file():
                    raise ValueError("Generated curriculum source does not exist")
                item.source_ref = str(path)
        async with self.lock:
            config = self.state.get_config()
            if not config.track.queue:
                config.track.queue = result.items
                config.track.active_item_id = result.items[0].id
                self._save(config)
        return config.track.model_dump(mode="json")

    async def complete(self, item_id):
        async with self.lock:
            config = self.state.get_config()
            item = next((i for i in config.track.queue if i.id == item_id), None)
            if item is None:
                raise ValueError("Unknown track item")
            item.completed = True
            config.track.active_item_id = next((i.id for i in config.track.queue if not i.completed), None)
            self._save(config)

    async def foundation(self, session_id, title, prerequisite):
        session = self.state.sessions.get(session_id)
        if not session.track_item_id:
            raise ValueError("Foundations can be inserted only for an active track lesson")
        if not any(not a.correct or a.calibration_band in ("fragile_intuition", "moderate_correct") for a in session.answers.values()):
            raise ValueError("A prerequisite lesson requires diagnostic evidence of a gap")
        async with self.lock:
            config = self.state.get_config()
            existing = next((i for i in config.track.queue if i.parent_item_id == session.track_item_id and i.title.casefold() == title.casefold()), None)
            if existing:
                return existing.model_dump()
            idx = next(i for i, item in enumerate(config.track.queue) if item.id == session.track_item_id)
            item = TrackItem(id=f"base-{uuid4().hex}", title=title, kind="base", parent_item_id=session.track_item_id, status_detail=prerequisite)
            config.track.queue.insert(idx, item)
            config.track.active_item_id = item.id
            self._save(config)
            return item.model_dump()

    def _save(self, config):
        save_config(self.state.vault_path, config)
        map_path = safe_path(self.state.vault_path, config.folders.map_file)
        with locked_path(map_path):
            original = map_path.read_text(encoding="utf-8") if map_path.exists() else ""
            start, end = "<!-- harness:track:start -->", "<!-- harness:track:end -->"
            body = "\n".join(f"- [{'x' if item.completed else ' '}] {item.title} <!-- {item.id} -->" for item in config.track.queue)
            block = f"{start}\n{body}\n{end}"
            pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.S)
            updated = pattern.sub(lambda _: block, original, count=1) if start in original else original.rstrip() + "\n\n" + block + "\n"
            atomic_write(map_path, updated)
        self.state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"track": True})

