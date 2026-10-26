"""Vault & Bidirectional Sync Engine for LearnHarness.

Local-first bidirectional persistence (UI ⇄ Obsidian Vault).
Manages Markdown AST non-destructive merges, Excalidraw decompression/saving,
transcript importation with ^pN anchoring, append-only JSONL machine storage,
and asynchronous file-system watching.
"""

from learnharness.vault.bootstrap import bootstrap_vault, load_config, save_config
from learnharness.vault.excalidraw import (
    create_retrieval_drawing,
    load_drawing,
    save_drawing,
)
from learnharness.vault.jsonl_store import (
    append_chain,
    append_quiz_log,
    append_session_event,
    build_graph_snapshot,
    list_sessions,
    load_chains,
    load_quiz_logs,
    load_session,
)
from learnharness.vault.markdown_ast import (
    merge_concept_note,
    merge_lesson_note,
    parse_concept_note,
    scan_all_concepts,
)
from learnharness.vault.transcript_importer import (
    get_source_paragraph,
    import_transcript_text,
)
from learnharness.vault.watcher import VaultWatcher

__all__ = [
    "VaultWatcher",
    "append_chain",
    "append_quiz_log",
    "append_session_event",
    "bootstrap_vault",
    "build_graph_snapshot",
    "create_retrieval_drawing",
    "get_source_paragraph",
    "import_transcript_text",
    "list_sessions",
    "load_chains",
    "load_config",
    "load_drawing",
    "load_quiz_logs",
    "load_session",
    "merge_concept_note",
    "merge_lesson_note",
    "parse_concept_note",
    "save_config",
    "save_drawing",
    "scan_all_concepts",
]
