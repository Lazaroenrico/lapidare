"""Adaptive track generation and non-destructive progress synchronization."""
from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from learnharness.core.contracts.config import (
    HarnessConfig,
    TrackConfig,
    TrackItem,
    TrackMode,
    derive_track_title,
)
from learnharness.core.events import SseEventType
from learnharness.core.frontmatter import strip_frontmatter
from learnharness.core.repo_paths import LANGUAGE_STEMS
from learnharness.engines.cli_protocol import EngineError
from learnharness.services.track_generation import (  # noqa: F401 (GeneratedTrack re-export)
    GeneratedTrack,
    explain_generation_failure,
    generate_track_items,
)
from learnharness.vault.bootstrap import save_config
from learnharness.vault.safety import atomic_write, locked_path, safe_path

logger = logging.getLogger(__name__)

# A whole-curriculum answer is one long structured reply: the CLI may emit nothing for minutes
# while the model writes it, so the default 180 s idle timeout killed real runs.
TRACK_GENERATION_IDLE_TIMEOUT = 600
OUTLINE_CHAR_BUDGET = 60_000  # ~15k tokens of curriculum context for the strong slot
STRUCTURE_SHARE = 0.35  # at most this fraction of the budget goes to structure documents
STRUCTURE_DOC_CHARS = 4_000
SUMMARY_CHARS = 240
HEAD_BYTES = 16 * 1024
MAX_OUTLINE_FILE_BYTES = 1024 * 1024
OUTLINE_EXTENSIONS = {".md", ".markdown", ".txt", ".ipynb"}
SKIPPED_PARTS = {"node_modules", "pratica", "__pycache__", "venv", "site-packages"}
# Directories that hold artifacts, translations or the website build, not lessons.
NON_LESSON_PARTS = {
    "outputs", "output", "assets", "images", "img", "static", "public", "site", "web", "dist",
    "build", "i18n", "locales", "translations", "vendor", "third_party",
}
# Trailing path segments that do not name a lesson ("…/02-attention/docs/en.md" -> "02-attention").
UNIT_TAIL_PARTS = {"docs", "doc", "content", "notes", "src"}
STRUCTURE_STEMS = {
    "readme", "roadmap", "learning", "curriculum", "syllabus", "index", "toc", "summary",
    "overview", "contents", "outline", "learning-path", "learning-paths", "course",
}
STRUCTURE_DIRS = {"learning-paths", "learning-path", "paths", "roadmap", "roadmaps", "syllabus"}


@dataclass
class OutlineEntry:
    path: str
    title: str
    summary: str = ""
    structure: bool = False  # root README/ROADMAP or learning-path doc: shown with content
    overview: bool = False  # directory README: keeps its summary longer under pressure
    excerpt: str = ""


def _natural_key(path: str) -> list[tuple[int, int | str]]:
    return [(0, int(t)) if t.isdigit() else (1, t.casefold()) for t in re.split(r"(\d+)", path) if t]


def markdown_title_and_summary(text: str) -> tuple[str | None, str]:
    """First ``#`` heading and first prose paragraph (no code, tables, images or HTML)."""
    title: str | None = None
    paragraph: list[str] = []
    in_fence = False
    for line in strip_frontmatter(text).splitlines():
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            in_fence = not in_fence
            if paragraph:
                break
            continue
        if in_fence:
            continue
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", stripped)
        if heading:
            if title is None and len(heading.group(1)) == 1:
                title = heading.group(2).strip()
            if paragraph:
                break
            continue
        if not stripped:
            if paragraph:
                break
            continue
        if stripped.startswith(("|", "<", "![", "[![", ">", "---", "===")):
            continue
        paragraph.append(stripped)
    summary = re.sub(r"\s+", " ", " ".join(paragraph)).strip()
    if len(summary) > SUMMARY_CHARS:
        summary = summary[: SUMMARY_CHARS - 1].rstrip() + "…"
    return title, summary


def _read_head(path: Path) -> str:
    with path.open("rb") as handle:
        return handle.read(HEAD_BYTES).decode("utf-8", "replace")


def _describe_file(path: Path, relative: str) -> OutlineEntry:
    suffix = path.suffix.lower()
    stem = path.stem
    try:
        if suffix == ".ipynb":
            from learnharness.vault.github_source import notebook_to_markdown

            text = notebook_to_markdown(path.read_text(encoding="utf-8", errors="replace"))
        else:
            text = _read_head(path)
    except (OSError, ValueError):
        return OutlineEntry(relative, stem)
    if suffix == ".txt":
        first = next((line.strip() for line in text.splitlines() if line.strip()), "")
        return OutlineEntry(relative, first[:120] or stem)
    title, summary = markdown_title_and_summary(text)
    parts = Path(relative).parts
    entry = OutlineEntry(relative, title or stem, summary)
    is_root_doc = len(parts) == 1 and stem.lower() in STRUCTURE_STEMS
    in_structure_dir = any(p.lower() in STRUCTURE_DIRS for p in parts[:-1])
    if (is_root_doc or in_structure_dir) and suffix != ".ipynb":
        entry.structure = True
        entry.excerpt = _clean_excerpt(strip_frontmatter(text))[:STRUCTURE_DOC_CHARS]
    elif stem.lower() in {"readme", "index", "overview"}:
        entry.overview = True
    return entry


_HTML_TAG = re.compile(r"<[^>\n]+>")
_MD_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")


def _clean_excerpt(text: str) -> str:
    """Prose only: README headers are often walls of badge HTML that would eat the budget."""
    text = _MD_IMAGE.sub("", _HTML_TAG.sub("", text))
    text = _MD_LINK.sub(r"\1", text)
    lines = [line.rstrip() for line in text.splitlines()]
    out: list[str] = []
    for line in lines:
        if not line.strip() and (not out or not out[-1].strip()):
            continue
        out.append(line)
    return "\n".join(out).strip()


def _lesson_unit(relative: str) -> str:
    """Directory that represents the lesson a file belongs to."""
    parts = list(Path(relative).parent.parts)
    while parts and parts[-1].lower() in UNIT_TAIL_PARTS:
        parts.pop()
    return "/".join(parts) or "."


def _prefer_one_language(paths: list[str]) -> list[str]:
    """Keep one translation per lesson (``docs/en.md`` over ``docs/pt.md``...)."""
    by_parent: dict[str, list[str]] = {}
    for rel in paths:
        if Path(rel).stem.lower() in LANGUAGE_STEMS:
            by_parent.setdefault(str(Path(rel).parent), []).append(rel)
    dropped: set[str] = set()
    for siblings in by_parent.values():
        if len(siblings) > 1:
            keep = next((r for r in siblings if Path(r).stem.lower() == "en"), siblings[0])
            dropped.update(r for r in siblings if r != keep)
    return [rel for rel in paths if rel not in dropped]


def _eligible_files(root: Path) -> list[str]:
    found: list[str] = []
    for current, dirs, files in os.walk(root):
        dirs[:] = [
            d for d in dirs
            if not d.startswith(".") and d not in SKIPPED_PARTS and d.lower() not in NON_LESSON_PARTS
            and not Path(current, d).is_symlink()
        ]
        for name in files:
            path = Path(current, name)
            if name.startswith(".") or path.suffix.lower() not in OUTLINE_EXTENSIONS or path.is_symlink():
                continue
            try:
                if path.stat().st_size > MAX_OUTLINE_FILE_BYTES or not path.resolve().is_relative_to(root):
                    continue
            except OSError:
                continue
            found.append(path.relative_to(root).as_posix())
    return _prefer_one_language(sorted(found, key=_natural_key))


def _entry_line(entry: OutlineEntry, with_summary: bool) -> str:
    line = f"- {entry.path} — {entry.title}"
    if with_summary and entry.summary and entry.summary != entry.title:
        line += f": {entry.summary}"
    return line


def _grouped_lines(entries: list[OutlineEntry], budget: int) -> list[str]:
    """Budget fallback that still spans the whole curriculum.

    First one line per lesson unit (``phases/07-x/02-attention — Title``); if that is still too
    long, one line per parent of units (e.g. a phase) listing its lessons, each line capped
    evenly so every phase appears.
    """
    units: dict[str, OutlineEntry] = {}
    for entry in entries:
        units.setdefault(_lesson_unit(entry.path), entry)
    unit_lines = [f"- {unit} — {entry.title}" for unit, entry in units.items()]
    if _size(unit_lines) <= budget:
        return unit_lines
    parents: dict[str, list[tuple[str, str]]] = {}
    for unit, entry in units.items():
        parent = str(Path(unit).parent)
        parents.setdefault(parent, []).append((Path(unit).name, entry.title))
    per_group = max(80, budget // max(1, len(parents)) - 1)
    lines = []
    for parent, items in parents.items():
        line = f"- {parent}/ ({len(items)} lessons): " + "; ".join(f"{name} — {title}" for name, title in items)
        lines.append(line if len(line) <= per_group else line[: per_group - 1] + "…")
    return lines


def _size(lines: list[str]) -> int:
    return sum(len(line) + 1 for line in lines)


def build_curriculum_outline(root: Path, budget: int = OUTLINE_CHAR_BUDGET) -> str:
    """Compact, curriculum-ordered outline of a whole repository within ``budget`` chars.

    Structure documents (root README/ROADMAP/LEARNING..., ``learning-paths/``) come first with
    an excerpt of their content; then every lesson file in natural order as
    ``path — title: first paragraph``. Under budget pressure lesson summaries are dropped
    first, then directory READMEs' summaries, then lessons are grouped per directory, so the
    outline spans the whole tree instead of an arbitrary prefix of it.
    """
    root = Path(root).resolve()
    entries = [_describe_file(root / rel, rel) for rel in _eligible_files(root)]
    structure = sorted(
        (e for e in entries if e.structure), key=lambda e: (len(Path(e.path).parts), _natural_key(e.path))
    )
    lessons = [e for e in entries if not e.structure]

    sections: list[str] = []
    if structure:
        structure_budget = int(budget * STRUCTURE_SHARE)
        per_doc = max(400, structure_budget // len(structure))
        blocks: list[str] = []
        for entry in structure:
            block = f"### {entry.path} — {entry.title}\n{entry.excerpt[:per_doc]}".rstrip()
            if _size(blocks) + len(block) > structure_budget:
                block = _entry_line(entry, True)
            blocks.append(block)
        sections.append("## Structure documents\n" + "\n\n".join(blocks))
    remaining = budget - sum(len(s) for s in sections) - 200

    for lines in (
        [_entry_line(e, True) for e in lessons],
        [_entry_line(e, e.overview) for e in lessons],
        [_entry_line(e, False) for e in lessons],
    ):
        if _size(lines) <= remaining:
            break
    else:
        lines = _grouped_lines(lessons, remaining)
        if _size(lines) > remaining:
            kept: list[str] = []
            for line in lines:
                if _size(kept) + len(line) + 40 > remaining:
                    break
                kept.append(line)
            lines = [*kept, f"- … ({len(lines) - len(kept)} more directories omitted)"]
    sections.append(f"## Curriculum outline ({len(lessons)} files, natural order)\n" + "\n".join(lines))
    return f"CURRICULUM REPOSITORY ({len(entries)} text files)\n\n" + "\n\n".join(sections)



GENERATED_SOURCES = ("repo", "github", "goal", "legacy")
_TRACK_START, _TRACK_END = "<!-- harness:track:start -->", "<!-- harness:track:end -->"


def track_job_key(track_id: str) -> str:
    return f"track:{track_id}"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def render_track_block(config: HarnessConfig) -> str:
    """The managed body of the map note: one section per non-archived track (pure)."""
    en = config.language == "en"
    sections = []
    for track in config.tracks:
        if track.archived:
            continue
        mark = (" · active" if en else " · ativa") if track.id == config.active_track_id else ""
        lines = [f"### ⇶ {track.title}{mark} <!-- {track.id} -->"]
        lines += [f"- [{'x' if item.completed else ' '}] {item.title} <!-- {item.id} -->" for item in track.queue]
        if not track.queue:
            lines.append("_(no steps yet)_" if en else "_(ainda sem passos)_")
        sections.append("\n".join(lines))
    return "\n\n".join(sections)


def manual_queue(items: list[str]) -> list[TrackItem]:
    """One step per non-empty line (a list entry may hold several lines)."""
    titles = [line.strip(" \t-*") for entry in items for line in entry.splitlines()]
    return [TrackItem(id=f"step-{n}", title=title[:300], kind="curriculo")
            for n, title in enumerate((t for t in titles if t), start=1)]


def _resolve_source_ref(root: Path, ref: str) -> str | None:
    """Absolute path of a generated ``source_ref`` inside ``root``, or ``None``.

    Models sometimes prefix the repository name or ``./``, or invent a path. One bad
    reference used to fail the whole job after minutes of generation; now the item just
    loses its link to the file (the lesson still exists, anchored on its title).
    """
    candidates = [ref.strip(), ref.strip().removeprefix("./")]
    candidates.append(candidates[1].removeprefix(f"{root.name}/"))
    for candidate in dict.fromkeys(c for c in candidates if c):
        try:
            path = safe_path(root, candidate)
        except (PermissionError, ValueError):
            continue
        if path.is_file():
            return str(path)
    logger.warning("Generated track item points to a missing source: %s", ref)
    return None


class TrackService:
    """Several tracks side by side, one in focus (Fase 14). Every mutation goes through
    ``self.lock`` and ``_save`` (config + map note + ``config:updated``)."""

    def __init__(self, state):
        self.state = state
        self.lock = asyncio.Lock()

    # ----------------------------------------------------------------- queries

    def job_status(self, track_id: str) -> tuple[bool, str | None]:
        """``(generating, error)`` from the latest ``track:<id>`` job."""
        key = track_job_key(track_id)
        last = None
        for record in self.state.active_jobs.values():  # insertion order = submission order
            if record.get("dedup_key") == key:
                last = record
        if last is None:
            return False, None
        status = last.get("status")
        if status == "failed":
            return False, last.get("error") or "failed"
        if status == "interrupted":
            return False, last.get("error") or "interrupted"
        return status in ("queued", "running"), None

    def serialize(self, track: TrackConfig, config: HarnessConfig) -> dict[str, Any]:
        generating, error = self.job_status(track.id)
        upcoming = track.item(track.active_item_id)
        if upcoming is None or upcoming.completed:
            upcoming = next((i for i in track.queue if not i.completed), None)
        return {
            "id": track.id, "title": track.title, "source": track.source, "mode": track.mode.value,
            "archived": track.archived, "active": track.id == config.active_track_id,
            "created_at": track.created_at,
            "progress": {"done": sum(1 for i in track.queue if i.completed), "total": len(track.queue)},
            "next_item": {"id": upcoming.id, "title": upcoming.title} if upcoming else None,
            "generating": generating, "error": error,
        }

    def list_tracks(self, config: HarnessConfig | None = None) -> list[dict[str, Any]]:
        config = config or self.state.get_config()
        return [self.serialize(t, config) for t in config.tracks]

    def _require(self, config: HarnessConfig, track_id: str) -> TrackConfig:
        track = config.find_track(track_id)
        if track is None:
            raise FileNotFoundError("Unknown track")
        return track

    # ----------------------------------------------------------------- mutations

    async def create(
        self, *, source: str, title: str = "", repo_path: str | None = None,
        github_url: str | None = None, goal_description: str | None = None,
        items: list[str] | None = None, queue: list[TrackItem] | None = None,
        active_item_id: str | None = None, learning_md_path: str | None = None,
        activate: bool = True,
    ) -> TrackConfig:
        """Add a track; non-manual tracks without a queue get a ``track_gen`` job."""
        goal = (goal_description or "").strip() or None
        if queue is None and source == "manual":
            queue = manual_queue(items or [])
            if not queue:
                raise ValueError("A manual track needs at least one step")
        if source == "goal" and not goal and not queue:
            raise ValueError("A goal track needs a goal or a course syllabus")
        if source in ("repo", "github"):
            if not repo_path or not Path(repo_path).expanduser().is_dir():
                raise ValueError("Curriculum repository does not exist")
            repo_path = str(Path(repo_path).expanduser().resolve())
        queue = list(queue or [])
        mode = {"manual": TrackMode.FREE, "goal": TrackMode.GOAL_GENERATED}.get(source, TrackMode.REPO_LEVELING)
        track = TrackConfig(
            source=source, mode=mode, repo_path=repo_path, github_url=github_url,
            goal_description=goal, learning_md_path=learning_md_path, queue=queue,
            active_item_id=active_item_id or next((i.id for i in queue if not i.completed), None),
            created_at=_now(),
        )
        async with self.lock:
            config = self.state.get_config()
            track.title = title.strip()[:200] or derive_track_title(track, config.language)
            config.tracks.append(track)
            if activate or not config.active_track():
                config.active_track_id = track.id
            self._save(config)
        if source != "manual" and not track.queue:
            self.submit_generation(track)
        return track

    def submit_generation(self, track: TrackConfig, *, regenerate: bool = False) -> dict[str, Any]:
        return self.state.jobs.submit(
            "track_gen", {"track_id": track.id, "topic": track.title, "regenerate": regenerate},
            key=track_job_key(track.id), dedup_statuses=("queued", "running"),
        )

    async def update(self, track_id: str, *, title: str | None = None, archived: bool | None = None,
                     goal_description: str | None = None) -> TrackConfig:
        async with self.lock:
            config = self.state.get_config()
            track = self._require(config, track_id)
            if title is not None:
                if not title.strip():
                    raise ValueError("A track needs a title")
                track.title = title.strip()[:200]
            if goal_description is not None:
                track.goal_description = goal_description.strip() or None
            if archived is not None and archived != track.archived:
                track.archived = archived
                if archived and config.active_track_id == track.id:
                    config.active_track_id = config.next_active_track_id(track.id)
                elif not archived and not config.active_track():
                    config.active_track_id = track.id
            self._save(config)
            return track

    async def activate(self, track_id: str) -> TrackConfig:
        async with self.lock:
            config = self.state.get_config()
            track = self._require(config, track_id)
            track.archived = False
            config.active_track_id = track.id
            self._save(config)
            return track

    async def delete(self, track_id: str) -> str | None:
        """Drop the track from the config only: sessions keep their (now orphan) ``track_id``
        and nothing in the Vault is deleted. Returns the new active track id."""
        async with self.lock:
            config = self.state.get_config()
            self._require(config, track_id)
            if config.active_track_id == track_id:
                config.active_track_id = config.next_active_track_id(track_id)
            config.tracks = [t for t in config.tracks if t.id != track_id]
            self._save(config)
            return config.active_track_id

    async def regenerate(self, track_id: str) -> dict[str, Any]:
        config = self.state.get_config()
        track = self._require(config, track_id)
        if track.source not in GENERATED_SOURCES or not (track.repo_path or track.goal_description):
            raise ValueError("Only repository, GitHub or goal tracks can be regenerated")
        return self.submit_generation(track, regenerate=True)

    async def generate(self, track_id: str | None = None, *, regenerate: bool = False):
        """Fill (or, with ``regenerate``, rebuild) a track's queue. ``track_id=None`` (jobs
        queued before Fase 14) means the active track. A rebuild keeps ``completed`` on
        items with the same title."""
        config = self.state.get_config()
        track = config.find_track(track_id) if track_id else config.active_track()
        if track is None:
            raise ValueError("Unknown track")
        if not regenerate and (track.queue or track.mode == TrackMode.FREE):
            return track.model_dump(mode="json")
        context = track.goal_description or ""
        if track.repo_path:
            root = Path(track.repo_path).expanduser().resolve()
            if not root.is_dir():
                raise ValueError("Curriculum repository does not exist")
            context += "\n" + await asyncio.to_thread(build_curriculum_outline, root)  # Walks the repo.
        if not context.strip():
            raise ValueError("Specify a goal or curriculum repository")
        engine = self.state.engine(config.slots.strong, timeout=TRACK_GENERATION_IDLE_TIMEOUT)
        try:
            result = await generate_track_items(engine, config.slots.strong, config.language, context,
                                                syllabus=track.goal_description or "")
        except EngineError as exc:
            raise EngineError(explain_generation_failure(str(exc), config.slots.strong.model_id)) from exc
        ids = {item.id for item in result.items}
        if len(ids) != len(result.items) or any(p not in ids for item in result.items for p in item.prerequisites):
            raise ValueError("Generated track contains duplicate or unknown prerequisites")
        from learnharness.core.contracts.session import PlanDag, PlanNode
        PlanDag(nodes=[PlanNode(id=i.id, label=i.title, depends_on=i.prerequisites) for i in result.items])
        if track.repo_path:
            root = Path(track.repo_path).expanduser().resolve()
            for item in result.items:
                if item.source_ref:
                    item.source_ref = _resolve_source_ref(root, item.source_ref)
        async with self.lock:
            config = self.state.get_config()
            current = config.find_track(track.id)
            if current is None:
                raise ValueError("The track was removed while it was being generated")
            if regenerate:
                done = {i.title.casefold() for i in current.queue if i.completed}
                for item in result.items:
                    item.completed = item.title.casefold() in done
            if regenerate or not current.queue:
                current.queue = result.items
                current.active_item_id = next((i.id for i in result.items if not i.completed), None)
                self._save(config)
        return current.model_dump(mode="json")

    async def complete(self, track_id: str, item_id: str):
        async with self.lock:
            config = self.state.get_config()
            track = self._require(config, track_id)
            item = track.item(item_id)
            if item is None:
                raise ValueError("Unknown track item")
            item.completed = True
            track.active_item_id = next((i.id for i in track.queue if not i.completed), None)
            self._save(config)

    async def foundation(self, session_id, title, prerequisite):
        session = self.state.sessions.get(session_id)
        if not session.track_item_id:
            raise ValueError("Foundations can be inserted only for an active track lesson")
        if not any(a.correct is False or a.is_dont_know or a.calibration_band in ("fragile_intuition", "moderate_correct") for a in session.answers.values()):
            raise ValueError("A prerequisite lesson requires diagnostic evidence of a gap")
        async with self.lock:
            config = self.state.get_config()
            track = config.session_track(session.track_id, session.track_item_id)
            if track is None or track.item(session.track_item_id) is None:
                raise ValueError("The session's track no longer exists")
            existing = next((i for i in track.queue if i.parent_item_id == session.track_item_id and i.title.casefold() == title.casefold()), None)
            if existing:
                return existing.model_dump()
            idx = next(i for i, item in enumerate(track.queue) if item.id == session.track_item_id)
            item = TrackItem(id=f"base-{uuid4().hex}", title=title, kind="base", parent_item_id=session.track_item_id, status_detail=prerequisite)
            track.queue.insert(idx, item)
            track.active_item_id = item.id
            self._save(config)
            return item.model_dump()

    def _save(self, config):
        save_config(self.state.vault_path, config)
        map_path = safe_path(self.state.vault_path, config.folders.map_file)
        with locked_path(map_path):
            original = map_path.read_text(encoding="utf-8") if map_path.exists() else ""
            body = render_track_block(config)
            if body or _TRACK_START in original:
                block = f"{_TRACK_START}\n{body}\n{_TRACK_END}"
                pattern = re.compile(re.escape(_TRACK_START) + r".*?" + re.escape(_TRACK_END), re.S)
                updated = (pattern.sub(lambda _: block, original, count=1) if _TRACK_START in original
                           else original.rstrip() + "\n\n" + block + "\n")
                if updated != original:
                    atomic_write(map_path, updated)
        self.state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"track": True})
        self.state.sse_hub.broadcast(SseEventType.CONFIG_UPDATED, {"tracks": True})


