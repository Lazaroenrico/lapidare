"""PNG encoding and pypdfium2 rendering."""
from __future__ import annotations

import struct
import zlib

import pytest

from learnharness.services.pdf_render import (
    PNG_SIGNATURE,
    bgr_to_rgb,
    encode_png,
    page_visual_hints,
    render_page_png,
)
from tests.unit.test_background_jobs import _pdf


def _chunks(png: bytes) -> list[tuple[bytes, bytes, int]]:
    assert png.startswith(PNG_SIGNATURE)
    pos, out = len(PNG_SIGNATURE), []
    while pos < len(png):
        (length,) = struct.unpack(">I", png[pos:pos + 4])
        kind, data = png[pos + 4:pos + 8], png[pos + 8:pos + 8 + length]
        (crc,) = struct.unpack(">I", png[pos + 8 + length:pos + 12 + length])
        assert crc == zlib.crc32(kind + data) & 0xFFFFFFFF
        out.append((kind, data, length))
        pos += 12 + length
    return out


def test_encode_png_round_trips() -> None:
    rgb = bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30])  # 2x2
    chunks = _chunks(encode_png(2, 2, rgb))
    assert [c[0] for c in chunks] == [b"IHDR", b"IDAT", b"IEND"]
    assert struct.unpack(">IIBBBBB", chunks[0][1]) == (2, 2, 8, 2, 0, 0, 0)
    raw = zlib.decompress(chunks[1][1])
    assert raw == b"\x00" + rgb[:6] + b"\x00" + rgb[6:]


def test_encode_png_rejects_a_wrong_buffer_size() -> None:
    with pytest.raises(ValueError):
        encode_png(2, 2, b"\x00" * 5)


def test_bgr_to_rgb_swaps_channels_drops_alpha_and_padding() -> None:
    bgr = bytes([1, 2, 3, 4, 5, 6, 0, 0])  # 2x1 BGR, stride 8
    assert bgr_to_rgb(bgr, 2, 1, 8, 3) == bytes([3, 2, 1, 6, 5, 4])
    bgra = bytes([1, 2, 3, 255, 4, 5, 6, 255])
    assert bgr_to_rgb(bgra, 2, 1, 8, 4) == bytes([3, 2, 1, 6, 5, 4])


def test_render_page_png_renders_a_real_pdf(tmp_path) -> None:
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(_pdf(["Hello", "World"]))
    png = render_page_png(pdf, 2, dpi=72, max_px=400)
    chunks = _chunks(png)
    width, height = struct.unpack(">II", chunks[0][1][:8])
    assert max(width, height) <= 400
    assert len(zlib.decompress(chunks[1][1])) == height * (1 + width * 3)
    with pytest.raises(ValueError):
        render_page_png(pdf, 3)


def test_render_caps_the_longest_side(tmp_path) -> None:
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(_pdf(["Hello"]))
    width, height = struct.unpack(">II", _chunks(render_page_png(pdf, 1, dpi=300, max_px=500))[0][1][:8])
    assert max(width, height) <= 500


def test_page_visual_hints_flags_pages_without_images(tmp_path) -> None:
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(_pdf(["Hello", "World"]))
    assert page_visual_hints(pdf) == [False, False]
