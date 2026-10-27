from learnharness.core.text_hygiene import is_stray_fragment


def test_stray_tokens_are_detected_and_content_is_not():
    assert is_stray_fragment("詰\n\n") and is_stray_fragment("  ") and is_stray_fragment("")
    assert not is_stray_fragment("ok") and not is_stray_fragment("1") and not is_stray_fragment("Sim.")
    assert not is_stray_fragment("詰め込み")  # Real CJK prose is longer than a lone token.


def test_stray_ideograph_tail_is_stripped_only_from_non_cjk_prose():
    from learnharness.core.text_hygiene import strip_stray_tail

    assert strip_stray_tail("pela soma sobre scores brutos. 噓") == "pela soma sobre scores brutos."
    assert strip_stray_tail("Texto normal.\n") == "Texto normal.\n"
    assert strip_stray_tail("日本語の文章です") == "日本語の文章です"  # Real CJK prose is untouched.
