"""Background jobs that report back to the lesson as steers (Fase 10)."""

from __future__ import annotations

import asyncio

import pytest
from fastmcp.exceptions import ToolError

from learnharness.core.contracts.config import EngineKind
from learnharness.core.contracts.jobs import PdfAnswer, PdfTriage, ResearchResult, VisualDraft
from learnharness.core.contracts.session import PlanDag, PlanNode, SessionRecord
from learnharness.core.lesson_layout import render_job_artifact
from learnharness.core.svg_validation import MAX_SVG_BYTES, validate_svg
from learnharness.engines.cli_protocol import EngineError
from learnharness.services.jobs import DISPATCH_NOTE
from learnharness.services.pdf_reader import triage
from learnharness.vault.bootstrap import load_config, save_config
from tests.conftest import FakeEngine, wait_until

GOOD_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            'viewBox="0 0 100 50"><defs><linearGradient id="g"/></defs>'
            '<rect width="100" height="50" fill="url(#g)" style="fill:#231b3e"/>'
            '<use xlink:href="#g"/><image href="data:image/png;base64,AAAA"/>'
            '<text x="10" y="30" fill="#efeaff">A → B</text></svg>')


class ResearchEngine(FakeEngine):
    """FakeEngine that can also research (scripted result, recorded prompts)."""

    def __init__(self, result=None, ready=True):
        super().__init__()
        self.result = result
        self.ready = ready
        self.research_calls = []

    def research_ready(self):
        return self.ready

    async def research(self, prompt, slot=None):
        self.research_calls.append({"prompt": prompt, "slot": slot})
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


def _state(tmp_path, engine):
    from learnharness.api.state import AppState
    from tests.conftest import configure_vault
    return AppState(vault_path=configure_vault(tmp_path / "Vault"), engine_factory=lambda slot: engine)


def _session(state, mode="TEACH"):
    lessons = state.get_config().folders.lessons_dir
    rel = f"{lessons}/Atencao.md"
    note = state.vault_path / rel
    note.parent.mkdir(parents=True, exist_ok=True)
    note.write_text("# Atenção\n\nMinha anotação.\n", encoding="utf-8")
    session = SessionRecord(id="sess-jobs", title="Atenção", mode=mode, lesson_vault_path=rel,
                            created_at="2026-10-27", updated_at="2026-10-27",
                            plan=PlanDag(nodes=[PlanNode(id="softmax", label="Softmax", status="current")]))
    state.sessions.save(session)
    return session, note


def _tools(state, session_id):
    return {t.__name__: t for t in state.tool_functions(session_id)}


def _job_steers(state, session_id):
    return [m for m in state.sessions.get(session_id).messages if m.steer_kind == "job"]


async def _settled(state, job_id, status):
    await wait_until(lambda: state.active_jobs[job_id]["status"] == status)
    await wait_until(lambda: state.active_jobs[job_id].get("steer_message_id"))
    for _ in range(300):
        if not state.sessions.is_running("sess-jobs"):
            return state.active_jobs[job_id]
        await asyncio.sleep(0.01)
    return state.active_jobs[job_id]


def _set_tools(state, **toggles):
    config = load_config(state.vault_path)
    for name, value in toggles.items():
        setattr(config.agent.tools, name, value)
    save_config(state.vault_path, config)


# ----------------------------------------------------------------- toggles and refusals


@pytest.mark.parametrize(
    ("toggle", "tool", "kwargs", "text"),
    [
        ("research", "research", {"question": "q"}, "a pesquisa está desativada"),
        ("pdf", "read_pdf", {"path": "a.pdf", "question": "q"}, "leitura de PDF está desativada"),
        ("visual", "visual", {"brief": "b"}, "visuais estão desativados"),
        ("demo", "spawn_demo", {"title": "t", "topic": "t"}, "demos interativas estão desativadas"),
    ],
)
async def test_disabled_tool_refuses_with_corrective_text(tmp_path, toggle, tool, kwargs, text):
    state = _state(tmp_path, FakeEngine())
    try:
        session, _ = _session(state)
        _set_tools(state, **{toggle: False})
        with pytest.raises(ToolError, match=text):
            await _tools(state, session.id)[tool](**kwargs)
        assert not state.active_jobs
    finally:
        await state.close()


@pytest.mark.parametrize(
    ("path", "fragment"),
    [
        ("/etc/hosts.pdf", "outside the vault"),
        ("../fora.pdf", "not a vault path"),
        ("Fontes/notas.md", "not a .pdf"),
        ("Fontes/nao-existe.pdf", "No PDF at"),
        ("", "path is empty"),
    ],
)
async def test_read_pdf_refuses_bad_paths(tmp_path, path, fragment):
    state = _state(tmp_path, FakeEngine())
    try:
        session, _ = _session(state)
        (state.vault_path / "Fontes").mkdir(exist_ok=True)
        (state.vault_path / "Fontes/notas.md").write_text("x")
        with pytest.raises(ToolError, match=fragment):
            await _tools(state, session.id)["read_pdf"](path=path, question="q")
        assert not state.active_jobs
    finally:
        await state.close()


async def test_read_pdf_refuses_a_symlink_out_of_the_vault(tmp_path):
    state = _state(tmp_path, FakeEngine())
    try:
        session, _ = _session(state)
        outside = tmp_path / "secret.pdf"
        outside.write_bytes(_pdf(["x"]))
        (state.vault_path / "link.pdf").symlink_to(outside)
        with pytest.raises(ToolError):
            await _tools(state, session.id)["read_pdf"](path="link.pdf", question="q")
    finally:
        await state.close()


async def test_visual_is_teach_only_but_research_works_in_practice(tmp_path):
    engine = ResearchEngine(ResearchResult(brief="## Resumo\nok", sources=[{"title": "t", "url": "https://x.org"}]))
    state = _state(tmp_path, engine)
    try:
        session, _ = _session(state, mode="PRACTICE")
        tools = _tools(state, session.id)
        with pytest.raises(ToolError, match="TEACH tool"):
            await tools["visual"](brief="b")
        result = await tools["research"](question="q")
        assert result == {"ok": True, "job_id": result["job_id"], "status": "queued", "note": DISPATCH_NOTE}
    finally:
        await state.close()


# ----------------------------------------------------------------- SVG validator


def test_svg_validator_accepts_internal_references():
    assert validate_svg(GOOD_SVG) == []


@pytest.mark.parametrize(
    ("svg", "fragment"),
    [
        ("", "empty"),
        ("<svg viewBox='0 0 1 1'>", "not well-formed"),
        ("<html viewBox='0 0 1 1'/>", "root element must be <svg>"),
        ("<svg xmlns='http://www.w3.org/2000/svg'/>", "viewBox"),
        ("<!DOCTYPE svg [<!ENTITY x 'y'>]><svg viewBox='0 0 1 1'>&x;</svg>", "DOCTYPE"),
        ("<svg viewBox='0 0 1 1'><script>alert(1)</script></svg>", "<script>"),
        ("<svg viewBox='0 0 1 1'><foreignObject><div/></foreignObject></svg>", "<foreignObject>"),
        ("<svg viewBox='0 0 1 1' onload='x()'/>", "event handler"),
        ("<svg viewBox='0 0 1 1'><a href='https://evil.example'/></svg>", "external href"),
        ("<svg xmlns:xlink='http://www.w3.org/1999/xlink' viewBox='0 0 1 1'>"
         "<image xlink:href='http://x/y.png'/></svg>", "external href"),
        ("<svg viewBox='0 0 1 1'><rect style=\"fill:url('https://x/p')\"/></svg>", "external url"),
        ("<svg viewBox='0 0 1 1'><rect fill='url(http://x/p)'/></svg>", "external url"),
        ("<svg viewBox='0 0 1 1'><style>@import 'x.css';</style></svg>", "@import"),
        (f"<svg viewBox='0 0 1 1'><!-- {'x' * MAX_SVG_BYTES} --></svg>", "maximum"),
    ],
)
def test_svg_validator_rejects(svg, fragment):
    errors = validate_svg(svg)
    assert any(fragment in e for e in errors), errors


# ----------------------------------------------------------------- research job


async def test_research_job_delivers_one_steer_with_sources(tmp_path):
    engine = ResearchEngine(ResearchResult(
        brief="## Resumo\nPython 1.0 saiu em 1994.",
        sources=[{"title": "History", "url": "https://python.org/history"}, {"title": "bad", "url": "ftp://x"}]))
    state = _state(tmp_path, engine)
    try:
        session, note = _session(state)
        dispatched = await _tools(state, session.id)["research"](question="Quando saiu o Python 1.0?",
                                                                 context="linha do tempo")
        record = await _settled(state, dispatched["job_id"], "completed")
        (steer,) = _job_steers(state, session.id)
        assert steer.details == {
            "job_id": record["job_id"], "kind": "research", "status": "done",
            "label": "Quando saiu o Python 1.0?", "node_id": "softmax",
            "dispatched_at": record["created_at"], "finished_at": record["finished_at"], "attempt": 1,
            "result": {"question": "Quando saiu o Python 1.0?", "engine": "gemini_cli",
                       "brief": "## Resumo\nPython 1.0 saiu em 1994.",
                       "sources": [{"title": "History", "url": "https://python.org/history"}]},
        }
        assert "A pesquisa 'Quando saiu o Python 1.0?' terminou" in steer.content
        assert "History — https://python.org/history" in steer.content
        assert "linha do tempo" in engine.research_calls[0]["prompt"]
        assert steer.delivered  # the idle session woke up and consumed it
        text = note.read_text(encoding="utf-8")
        assert "> [!note]- Pesquisa: Quando saiu o Python 1.0?" in text
        assert "Minha anotação." in text
    finally:
        await state.close()


async def test_research_engine_order_prefers_agy(tmp_path):
    agy = ResearchEngine(ResearchResult(brief="b", sources=[{"title": "t", "url": "https://a.org"}]))
    sdk = ResearchEngine(ResearchResult(brief="b", sources=[{"title": "t", "url": "https://b.org"}]))
    gemini = ResearchEngine(ResearchResult(brief="b", sources=[{"title": "t", "url": "https://c.org"}]))
    engines = {EngineKind.AGY: agy, EngineKind.GENAI_SDK: sdk, EngineKind.GEMINI_CLI: gemini}
    from learnharness.api.state import AppState
    from tests.conftest import configure_vault
    state = AppState(vault_path=configure_vault(tmp_path / "Vault"), engine_factory=lambda slot: engines[slot.engine])
    try:
        config = load_config(state.vault_path)
        config.slots.strong.engine = EngineKind.GEMINI_CLI
        config.slots.fast.engine = EngineKind.GENAI_SDK
        config.slots.background.engine = EngineKind.AGY
        save_config(state.vault_path, config)
        from learnharness.services.research import research_engine
        assert research_engine(state)[0] is agy
        agy.ready = False  # agy configured but not installed -> next capable connector
        assert research_engine(state)[0] is sdk
    finally:
        await state.close()


async def test_research_without_capable_engine_delivers_failure_steer(tmp_path):
    state = _state(tmp_path, FakeEngine())  # no research capability at all
    try:
        session, note = _session(state)
        dispatched = await _tools(state, session.id)["research"](question="q?")
        record = await _settled(state, dispatched["job_id"], "failed")
        (steer,) = _job_steers(state, session.id)
        assert steer.details["status"] == "failed" and "result" not in steer.details
        assert "nenhum conector" in steer.details["error"] == record["error"]
        assert steer.content.startswith("A pesquisa 'q?' falhou (")
        assert "Siga em prosa; não invente o resultado." in steer.content
        assert "[!note]" not in note.read_text(encoding="utf-8")
    finally:
        await state.close()


async def test_retry_success_reaches_the_session_once_per_attempt(tmp_path):
    engine = ResearchEngine(EngineError("provider down"))
    state = _state(tmp_path, engine)
    try:
        session, _ = _session(state)
        dispatched = await _tools(state, session.id)["research"](question="q?")
        await _settled(state, dispatched["job_id"], "failed")
        assert len(_job_steers(state, session.id)) == 1
        engine.result = ResearchResult(brief="b", sources=[{"title": "t", "url": "https://x.org"}])
        state.jobs.retry(dispatched["job_id"])
        await wait_until(lambda: state.active_jobs[dispatched["job_id"]]["status"] == "completed")
        await asyncio.sleep(0.05)
        # The teacher was told the first attempt failed: the retried result must reach it.
        failed, done = _job_steers(state, session.id)
        assert (failed.details["status"], failed.details["attempt"]) == ("failed", 1)
        assert (done.details["status"], done.details["attempt"]) == ("done", 2)
        # A crash between delivery and the record save must not deliver an attempt twice.
        record = state.active_jobs[dispatched["job_id"]]
        record.pop("steer_message_id")
        await state.jobs._deliver_steer(record)
        assert len(_job_steers(state, session.id)) == 2
    finally:
        await state.close()


async def test_interrupted_job_delivers_its_steer_after_retry(tmp_path):
    engine = ResearchEngine(ResearchResult(brief="b", sources=[{"title": "t", "url": "https://x.org"}]))
    gate = asyncio.Event()
    original = engine.research

    async def slow(prompt, slot=None):
        await gate.wait()
        return await original(prompt, slot)

    engine.research = slow
    state = _state(tmp_path, engine)
    try:
        session, _ = _session(state)
        dispatched = await _tools(state, session.id)["research"](question="q?")
        await wait_until(lambda: state.active_jobs[dispatched["job_id"]]["status"] == "running")
        state.jobs.tasks[dispatched["job_id"]].cancel()
        await wait_until(lambda: state.active_jobs[dispatched["job_id"]]["status"] == "interrupted")
        assert not _job_steers(state, session.id)
        gate.set()
        state.jobs.retry(dispatched["job_id"])
        await _settled(state, dispatched["job_id"], "completed")
        assert [m.details["status"] for m in _job_steers(state, session.id)] == ["done"]
    finally:
        await state.close()


# ----------------------------------------------------------------- read_pdf job


def _pdf(pages: list[str]) -> bytes:
    """A minimal valid PDF with one Helvetica text line per page."""
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", None,
               "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for text in pages:
        stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("latin-1")
        objects.append(f"<< /Length {len(stream)} >>\nstream\n{stream.decode('latin-1')}\nendstream")
        content = len(objects)
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                       f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content} 0 R >>")
        kids.append(f"{len(objects)} 0 R")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>"
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n{body}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def test_triage_ranks_pages_by_question_terms():
    pages = ["introducao geral", "a funcao softmax normaliza logits", "", "softmax softmax temperatura"]
    assert triage(pages, "Como a softmax usa a temperatura?") == ([2, 4], True)
    assert triage(pages, "zzz?") == ([1, 2, 4], False)


async def test_read_pdf_job_answers_with_cited_pages(tmp_path):
    engine = FakeEngine()
    engine.program(PdfTriage, {"draft": "softmax normaliza", "confident": True})
    engine.program(PdfAnswer, lambda prompt: {"answer": "A softmax normaliza os logits (p. 2).",
                                              "pages_cited": [2, 9]})
    state = _state(tmp_path, engine)
    try:
        session, note = _session(state)
        (state.vault_path / "Fontes").mkdir(exist_ok=True)
        (state.vault_path / "Fontes/paper.pdf").write_bytes(_pdf(["Introduction", "softmax normalizes logits"]))
        dispatched = await _tools(state, session.id)["read_pdf"](path="Fontes/paper.pdf",
                                                                 question="What does softmax do?")
        await _settled(state, dispatched["job_id"], "completed")
        (steer,) = _job_steers(state, session.id)
        assert steer.details["kind"] == "read_pdf"
        assert steer.details["result"] == {
            "path": "Fontes/paper.pdf", "file": "paper.pdf", "question": "What does softmax do?",
            "answer": "A softmax normaliza os logits (p. 2).", "page_count": 2, "pages_read": [2],
            "pages_cited": [2], "terms_matched": True, "pages_viewed": [], "figures": [],
        }
        prompt = engine.structured_calls[1]["prompt"]
        assert '<page n="2">' in prompt and '<page n="1">' not in prompt
        assert "> [!note]- PDF: paper.pdf — What does softmax do?" in note.read_text(encoding="utf-8")
    finally:
        await state.close()


async def test_read_pdf_with_no_text_fails(tmp_path):
    state = _state(tmp_path, FakeEngine())
    try:
        session, _ = _session(state)
        (state.vault_path / "scan.pdf").write_bytes(_pdf([""]))
        dispatched = await _tools(state, session.id)["read_pdf"](path="scan.pdf", question="q")
        await _settled(state, dispatched["job_id"], "failed")
        (steer,) = _job_steers(state, session.id)
        assert "nada pôde ser lido" in steer.details["error"]
    finally:
        await state.close()


# ----------------------------------------------------------------- visual job + lesson note


async def test_visual_job_corrects_saves_and_embeds_in_the_current_node(tmp_path):
    engine = FakeEngine()
    engine.program(VisualDraft, [
        {"title": "Fluxo da softmax", "alt": "logits viram probabilidades", "svg": "<svg><script/></svg>"},
        {"title": "Fluxo da softmax", "alt": "logits viram probabilidades", "svg": GOOD_SVG},
    ])
    state = _state(tmp_path, engine)
    try:
        session, note = _session(state)
        dispatched = await _tools(state, session.id)["visual"](brief="logits -> exp -> normaliza")
        record = await _settled(state, dispatched["job_id"], "completed")
        assert len(engine.structured_calls) == 2
        assert "fix_these_errors" in engine.structured_calls[1]["prompt"]
        assert record["result"]["path"] == "viz/visuals/fluxo-da-softmax.svg"
        assert (state.vault_path / "viz/visuals/fluxo-da-softmax.svg").read_text() == GOOD_SVG
        (steer,) = _job_steers(state, session.id)
        assert steer.details["result"] == {"slug": "fluxo-da-softmax", "path": "viz/visuals/fluxo-da-softmax.svg",
                                           "title": "Fluxo da softmax", "alt": "logits viram probabilidades",
                                           "bytes": len(GOOD_SVG.encode()), "checked": False,
                                           "check_notes": "Não conferido: sem Chromium headless."}
        assert record["warnings"] and "não conferido" in record["warnings"][0]
        assert steer.content.startswith("O visual 'Fluxo da softmax' está pronto e foi inserido na aula.")
        text = note.read_text(encoding="utf-8")
        section = text[text.index("## Softmax"):]
        assert "![[viz/visuals/fluxo-da-softmax.svg]]" in section
        assert "Minha anotação." in text
    finally:
        await state.close()


async def test_visual_fails_after_two_corrections(tmp_path):
    engine = FakeEngine()
    bad = {"title": "x", "svg": "<svg/>"}
    engine.program(VisualDraft, [bad, bad, bad])
    state = _state(tmp_path, engine)
    try:
        session, _ = _session(state)
        dispatched = await _tools(state, session.id)["visual"](brief="b")
        await _settled(state, dispatched["job_id"], "failed")
        assert len(engine.structured_calls) == 3
        (steer,) = _job_steers(state, session.id)
        assert "SVG inválido após 2 correções" in steer.details["error"]
        assert not (state.vault_path / "viz/visuals").exists() or not any((state.vault_path / "viz/visuals").iterdir())
    finally:
        await state.close()


def test_visual_route_serves_the_svg(api_client, app_state):
    target = app_state.vault_path / "viz/visuals/fig.svg"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(GOOD_SVG)
    assert api_client.get("/api/visuals/fig").json()["svg"] == GOOD_SVG
    assert api_client.get("/api/visuals/nope").status_code == 404
    target.write_text("<svg><script/></svg>")
    assert api_client.get("/api/visuals/fig").status_code == 422


def test_demo_artifact_renders_as_a_link():
    details = {"kind": "demo", "status": "done",
               "result": {"slug": "s", "rel_path": "viz/demos/s.html", "title": "Temperatura"}}
    assert render_job_artifact(details, "pt-BR") == "[[viz/demos/s.html|Simulador Interativo: Temperatura]]"
    assert render_job_artifact({**details, "kind": "unknown"}, "en") is None


async def test_spawn_demo_returns_the_dispatch_note(tmp_path):
    state = _state(tmp_path, FakeEngine())
    try:
        session, _ = _session(state)
        result = await _tools(state, session.id)["spawn_demo"](title="T", topic="t")
        assert result["ok"] is True and result["note"] == DISPATCH_NOTE
        assert state.active_jobs[result["job_id"]]["payload"]["node_id"] == "softmax"
        await _settled(state, result["job_id"], "failed")  # FakeEngine has no demo programmed
        (steer,) = _job_steers(state, session.id)
        assert steer.details["kind"] == "demo" and steer.details["status"] == "failed"
    finally:
        await state.close()

