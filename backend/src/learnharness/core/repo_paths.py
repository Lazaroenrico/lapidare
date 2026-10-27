"""Vocabulary of repository paths shared by import, track generation and the roadmap (pure)."""
from __future__ import annotations

# Basenames that say nothing about the lesson. Obsidian resolves [[name#^pN]] by basename,
# so hundreds of "docs/en.md" files would make every citation ambiguous.
GENERIC_STEMS = {"readme", "index", "main", "docs", "doc", "lesson", "notes", "content", "src"}
LANGUAGE_STEMS = {"en", "pt", "pt-br", "pt_br", "es", "fr", "de", "zh", "ja", "ko", "it", "ru"}
