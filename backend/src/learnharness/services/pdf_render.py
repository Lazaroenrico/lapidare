"""Render PDF pages to PNG for the vision path (Fase 20), with ``pypdfium2`` and no imaging library.

Everything here blocks: callers run it through ``asyncio.to_thread``.
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_POINTS_PER_INCH = 72
_CHANNELS = {"BGR": 3, "BGRA": 4, "BGRx": 4}


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def encode_png(width: int, height: int, rgb_bytes: bytes) -> bytes:
    """An 8-bit RGB PNG from ``width * height * 3`` bytes."""
    if width <= 0 or height <= 0 or len(rgb_bytes) != width * height * 3:
        raise ValueError("rgb_bytes does not match width x height x 3")
    row = width * 3
    raw = b"".join(b"\x00" + rgb_bytes[y * row:(y + 1) * row] for y in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return PNG_SIGNATURE + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(raw, 6)) + _chunk(b"IEND", b"")


def bgr_to_rgb(data: bytes, width: int, height: int, stride: int, channels: int) -> bytes:
    """Tightly packed RGB from BGR/BGRA/BGRx rows that may be padded to ``stride`` bytes."""
    if channels not in (3, 4):
        raise ValueError("channels must be 3 or 4")
    out = bytearray(width * height * 3)
    for y in range(height):
        row = data[y * stride:y * stride + width * channels]
        dest = y * width * 3
        out[dest + 0:dest + width * 3:3] = row[2::channels][:width]
        out[dest + 1:dest + width * 3:3] = row[1::channels][:width]
        out[dest + 2:dest + width * 3:3] = row[0::channels][:width]
    return bytes(out)


def render_page_png(path: Path | str, page_number: int, dpi: int = 144, max_px: int = 1600) -> bytes:
    """PNG of the 1-based ``page_number``; the longest side is capped at ``max_px``."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(path))
    try:
        if not 1 <= page_number <= len(pdf):
            raise ValueError(f"page {page_number} is out of range (1-{len(pdf)})")
        page = pdf[page_number - 1]
        try:
            width, height = page.get_size()
            scale = min(dpi / _POINTS_PER_INCH, max_px / max(width, height, 1))
            bitmap = page.render(scale=scale)  # pyright: ignore[reportArgumentType] - float scale is supported
            try:
                channels = _CHANNELS.get(bitmap.mode)
                if channels is None:
                    raise ValueError(f"unsupported bitmap mode {bitmap.mode!r}")
                rgb = bgr_to_rgb(bytes(bitmap.buffer), bitmap.width, bitmap.height, bitmap.stride, channels)
                return encode_png(bitmap.width, bitmap.height, rgb)
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        pdf.close()


def page_visual_hints(path: Path | str) -> list[bool]:
    """Per page, whether it holds image objects (figures, scans, photos)."""
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_raw

    pdf = pdfium.PdfDocument(str(path))
    try:
        hints = []
        for index in range(len(pdf)):
            page = pdf[index]
            try:
                hints.append(next(iter(page.get_objects(filter=[pdfium_raw.FPDF_PAGEOBJ_IMAGE])), None) is not None)
            finally:
                page.close()
        return hints
    finally:
        pdf.close()
