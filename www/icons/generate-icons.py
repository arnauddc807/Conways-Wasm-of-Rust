#!/usr/bin/env python3
"""Draws the app icons: a glider on a 5x5 board.

Rendered from code rather than checked in as opaque binaries so the set can be
regenerated at any size (a new iOS release asking for another one, say) without
a design tool. Writes PNGs with nothing but the standard library.

    python3 www/icons/generate-icons.py
"""

import struct
import zlib
from pathlib import Path

BACKGROUND = (0x12, 0x07, 0x1F)
DEAD = (0x24, 0x10, 0x40)
ALIVE = (0xA7, 0x6B, 0xFF)

BOARD = 5
GLIDER = {(0, 1), (1, 2), (2, 0), (2, 1), (2, 2)}

# Fraction of the icon the board occupies. The margin doubles as the safe zone
# for Android's maskable icons, which crop up to 20% off each edge.
BOARD_SCALE = 0.62

# apple-touch-icon (180), PWA manifest (192, 512) and the App Store /
# Capacitor marketing icon (1024).
SIZES = {
    "apple-touch-icon.png": 180,
    "icon-192.png": 192,
    "icon-512.png": 512,
    "icon-1024.png": 1024,
}


def render(size):
    """Returns `size` rows of RGB bytes."""
    pixels = [bytearray(BACKGROUND * size) for _ in range(size)]

    board = size * BOARD_SCALE
    origin = (size - board) / 2
    cell = board / BOARD
    gap = max(1, round(cell * 0.09))

    for row in range(BOARD):
        for col in range(BOARD):
            colour = ALIVE if (row, col) in GLIDER else DEAD
            top = round(origin + row * cell)
            left = round(origin + col * cell)
            bottom = round(origin + (row + 1) * cell) - gap
            right = round(origin + (col + 1) * cell) - gap

            for y in range(top, bottom):
                line = pixels[y]
                for x in range(left, right):
                    line[x * 3 : x * 3 + 3] = bytes(colour)

    return pixels


def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


def write_png(path, size):
    rows = render(size)
    # Filter type 0 (none) in front of every scanline.
    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")

    path.write_bytes(png)
    return len(png)


def main():
    here = Path(__file__).resolve().parent
    for name, size in SIZES.items():
        written = write_png(here / name, size)
        print(f"{name}: {size}x{size}, {written:,} bytes")


if __name__ == "__main__":
    main()
