from learnharness.core.text_hygiene import is_stray_fragment


def test_stray_tokens_are_detected_and_content_is_not():
    assert is_stray_fragment("詰\n\n") and is_stray_fragment("  ") and is_stray_fragment("")
    assert not is_stray_fragment("ok") and not is_stray_fragment("1") and not is_stray_fragment("Sim.")
    assert not is_stray_fragment("詰め込み")  # Real CJK prose is longer than a lone token.
