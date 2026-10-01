#!/usr/bin/env python3
"""Writes the concave test stones in this directory (T-0036).

Two closed meshes, in millimetres like a scanned rough, each concave in a way the renderer has
to get right:

* concave_grooved_bar.obj -- a bar 10 x 6 x 4 mm lying along +y, with two V grooves cut along
  its top. Seen face up (the optical axis is the file's +z, the page's default), a camera ray
  that lands on a groove wall reflects straight into the opposite wall, and light leaving the
  stone through one wall crosses the groove and enters the other. Its two end caps are single
  12-corner polygon faces with four reflex corners, written as one `f` line each, so loading it
  also exercises the loader's ear clipping: a fan from the first corner would cover the grooves.

* concave_torus.obj -- a ring torus, radius 3 mm to the tube's centre and 1.2 mm tube radius,
  24 x 12 flat quads about the +z axis. Light leaving the inner wall crosses the hole and meets
  the ring again on the far side, and a face-up camera sees through the hole.

Every face is wound anticlockwise seen from outside, though the renderer re-winds by signed
volume anyway. Standard library only; run it from anywhere:

    python3 tests/fixtures/make_concave_fixtures.py

The files are committed, so nothing runs this during a build or a test.
"""

import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def grooved_bar():
    """(vertices, faces) of the grooved bar. Faces are 0-based lists of vertex indices."""
    # The profile in (x, z), anticlockwise seen from -y: along the bottom, up the right side,
    # then leftwards along the top, down into each V groove and up again, and down the left side.
    profile = [
        (0.0, 0.0),
        (10.0, 0.0),
        (10.0, 4.0),
        (8.5, 4.0),
        (7.5, 2.0),  # right groove, bottom
        (6.5, 4.0),
        (3.5, 4.0),
        (2.5, 2.0),  # left groove, bottom
        (1.5, 4.0),
        (0.0, 4.0),
    ]
    length = 6.0
    count = len(profile)
    vertices = [(x, 0.0, z) for x, z in profile] + [(x, length, z) for x, z in profile]
    faces = []

    # The near cap (y = 0) faces -y. In (x, z) the profile runs anticlockwise, and x cross z is
    # -y, so the profile's own order already points it along -y.
    faces.append(list(range(count)))
    # The far cap (y = length) faces +y: the same outline reversed.
    faces.append([count + i for i in reversed(range(count))])

    # One quad per profile edge, joining the two caps. Seen from outside, the edge i -> i + 1
    # at the near cap and back along the far cap winds anticlockwise.
    for i in range(count):
        j = (i + 1) % count
        faces.append([i, count + i, count + j, j])

    return vertices, faces


def torus(major=3.0, minor=1.2, around=24, across=12):
    """(vertices, faces) of a ring torus about +z, centred on the origin."""
    vertices = []

    for i in range(around):
        u = 2.0 * math.pi * i / around

        for j in range(across):
            v = 2.0 * math.pi * j / across
            radius = major + minor * math.cos(v)
            vertices.append((radius * math.cos(u), radius * math.sin(u), minor * math.sin(v)))

    def index(i, j):
        return (i % around) * across + (j % across)

    # Each quad has two corners at one angle about the axis and two at the next, and two across
    # the tube at one angle and two at the next: an isosceles trapezoid, so it is flat. With u
    # anticlockwise about +z and v running outward, then up, then inward across the tube, the
    # order below winds anticlockwise seen from outside the tube.
    faces = [
        [index(i, j), index(i + 1, j), index(i + 1, j + 1), index(i, j + 1)]
        for i in range(around)
        for j in range(across)
    ]

    return vertices, faces


def write(name, description, vertices, faces):
    path = os.path.join(HERE, name)

    with open(path, "w") as out:
        out.write("# %s\n" % description)
        out.write("# Written by tests/fixtures/make_concave_fixtures.py (T-0036); millimetres.\n")
        out.write("o %s\n" % os.path.splitext(name)[0])

        for x, y, z in vertices:
            out.write("v %.6f %.6f %.6f\n" % (x, y, z))

        for face in faces:
            out.write("f %s\n" % " ".join(str(i + 1) for i in face))

    print("wrote", path)


if __name__ == "__main__":
    write(
        "concave_grooved_bar.obj",
        "A 10 x 6 x 4 mm bar with two V grooves along its top; concave, closed",
        *grooved_bar()
    )
    write(
        "concave_torus.obj",
        "A ring torus about +z, 3 mm to the tube centre, 1.2 mm tube radius; concave, closed",
        *torus()
    )
