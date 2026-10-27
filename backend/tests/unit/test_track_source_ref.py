from learnharness.services.tracks import _resolve_source_ref


def make_repo(tmp_path):
    root = tmp_path / "ai-course"
    (root / "lessons").mkdir(parents=True)
    (root / "lessons/01-intro.md").write_text("# Intro")
    (tmp_path / "outside.md").write_text("secret")
    return root


def test_exact_and_prefixed_paths_resolve(tmp_path):
    root = make_repo(tmp_path)
    expected = str(root / "lessons/01-intro.md")
    for ref in ("lessons/01-intro.md", "./lessons/01-intro.md", "ai-course/lessons/01-intro.md", " lessons/01-intro.md "):
        assert _resolve_source_ref(root, ref) == expected, ref


def test_invented_or_escaping_paths_are_dropped_not_fatal(tmp_path):
    root = make_repo(tmp_path)
    for ref in ("lessons/99-missing.md", "../outside.md", "/etc/passwd", "lessons"):
        assert _resolve_source_ref(root, ref) is None, ref


def test_generation_failures_explain_what_to_do():
    from learnharness.services.track_generation import explain_generation_failure
    quota = explain_generation_failure(
        "Antigravity CLI turn failed: Individual quota reached. Resets in 64h55m32s.", "gemini-3.8-pro")
    assert "cota do modelo gemini-3.8-pro acabou" in quota and "Configurações → Modelos" in quota
    idle = explain_generation_failure("Provider idle for 600s without events", "gemini-3.8-flash")
    assert "tempo demais" in idle
    assert explain_generation_failure("boom", "m") == "boom"
