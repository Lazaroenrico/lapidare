"""ascii_slug is frozen: persisted ids (older concept notes, track items, drawings) use it."""

from learnharness.core.slug import ascii_slug


def test_ascii_slug_drops_accents_and_punctuation():
    assert ascii_slug("  Atenção Multi-Cabeça!  ") == "aten-o-multi-cabe-a"
    assert ascii_slug("Softmax (2)") == "softmax-2"
    assert ascii_slug("ção") == "o"
    assert ascii_slug("—") == ""
