#!/usr/bin/env python3
"""Convert an equirectangular panorama into a horizontal-cross cube map.

Follows https://drakeor.com/2023/04/27/equirectangular-to-skybox-projection/ : for every
pixel of every cube face, cast a ray from the centre of the cube through that pixel, turn the
ray into an azimuth and an elevation, and read the equirectangular image there. The article
notes the ray need not be normalised, since azimuth and elevation do not depend on its length.

The output is the layout the renderer loads (``CROSS_FACES`` in ``src/renderer/env_map.rs``),
4 faces across and 3 down, +Y up, with the unused corner cells left black:

            [ +Y ]
    [ -X ]  [ -Z ]  [ +X ]  [ +Z ]
            [ -Y ]

The centre of the panorama becomes the -Z face, and the panorama turns towards +X as it runs
to the right, so the middle row of the cross reads as the original picture.

Usage:
    src/scripts/equirect_to_cross.py src/resources/backrooms_skybox.jpeg
    src/scripts/equirect_to_cross.py in.jpg -o out.png --face-size 512

Needs Pillow and numpy (``pip install pillow numpy``).
"""

import argparse
import math
import os
import sys

import numpy as np
from PIL import Image

# Mirrors CROSS_FACES in src/renderer/env_map.rs: (column, row, forward, right, up), where
# right and up are the world directions of increasing image x and decreasing image y. Keep the
# two in step; the Rust side has tests that pin its half of the layout.
FACES = [
    (1, 1, (0, 0, -1), (1, 0, 0), (0, 1, 0)),  # -Z
    (2, 1, (1, 0, 0), (0, 0, 1), (0, 1, 0)),  # +X
    (3, 1, (0, 0, 1), (-1, 0, 0), (0, 1, 0)),  # +Z
    (0, 1, (-1, 0, 0), (0, 0, -1), (0, 1, 0)),  # -X
    (1, 0, (0, 1, 0), (1, 0, 0), (0, 0, 1)),  # +Y
    (1, 2, (0, -1, 0), (1, 0, 0), (0, 0, -1)),  # -Y
]

COLUMNS, ROWS = 4, 3


def face_directions(size, forward, right, up):
    """World directions through every pixel centre of one face, shape (size, size, 3)."""
    # Pixel centres mapped to -1..1; image y grows downwards, so v is flipped.
    t = (np.arange(size) + 0.5) / size * 2.0 - 1.0
    u = t[None, :]
    v = -t[:, None]
    return (
        np.asarray(forward, np.float64)[None, None, :]
        + u[..., None] * np.asarray(right, np.float64)
        + v[..., None] * np.asarray(up, np.float64)
    )


def sample_equirect(source, directions):
    """Bilinearly samples an (H, W, C) float image at world directions (..., 3).

    Longitude 0 is -Z and increases towards +X; latitude is +90 degrees at +Y.
    """
    height, width = source.shape[:2]
    x, y, z = directions[..., 0], directions[..., 1], directions[..., 2]

    lon = np.arctan2(x, -z)  # -pi..pi
    lat = np.arctan2(y, np.hypot(x, z))  # -pi/2..pi/2

    # Continuous pixel coordinates, pixel centres at integers.
    px = (0.5 + lon / (2.0 * math.pi)) * width - 0.5
    py = (0.5 - lat / math.pi) * height - 0.5

    x0 = np.floor(px).astype(np.int64)
    y0 = np.floor(py).astype(np.int64)
    fx = (px - x0)[..., None]
    fy = (py - y0)[..., None]

    # Longitude wraps around; latitude clamps at the poles.
    xa, xb = x0 % width, (x0 + 1) % width
    ya, yb = np.clip(y0, 0, height - 1), np.clip(y0 + 1, 0, height - 1)

    top = source[ya, xa] * (1 - fx) + source[ya, xb] * fx
    bottom = source[yb, xa] * (1 - fx) + source[yb, xb] * fx
    return top * (1 - fy) + bottom * fy


def equirect_to_cross(image, face_size):
    """Returns the horizontal-cross PIL image for an equirectangular PIL image."""
    source = np.asarray(image.convert("RGB"), np.float64)
    cross = np.zeros((ROWS * face_size, COLUMNS * face_size, 3), np.float64)

    for column, row, forward, right, up in FACES:
        pixels = sample_equirect(source, face_directions(face_size, forward, right, up))
        cross[
            row * face_size : (row + 1) * face_size,
            column * face_size : (column + 1) * face_size,
        ] = pixels

    return Image.fromarray(np.clip(cross + 0.5, 0, 255).astype(np.uint8))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("input", help="equirectangular image (2:1)")
    parser.add_argument("-o", "--output", help="default: <input>_cross.png beside the input")
    parser.add_argument(
        "--face-size",
        type=int,
        help="edge of each cube face in pixels (default: a quarter of the input width)",
    )
    args = parser.parse_args()

    image = Image.open(args.input)
    if abs(image.width / image.height - 2.0) > 0.25:
        print(
            f"warning: {image.width}x{image.height} is not close to 2:1; "
            "is this really equirectangular?",
            file=sys.stderr,
        )

    face_size = args.face_size or max(1, image.width // 4)
    output = args.output or os.path.splitext(args.input)[0] + "_cross.png"

    equirect_to_cross(image, face_size).save(output)
    print(f"wrote {output} ({COLUMNS * face_size}x{ROWS * face_size}, faces {face_size}px)")


if __name__ == "__main__":
    main()
