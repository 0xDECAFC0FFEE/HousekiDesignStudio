"""Concave stones render the same in both renderers (T-0036).

Runs the real shader in headless Chrome on the built page (`./build.sh` first):

    python3 -m unittest tests/harness/test_concave.py -v

The Monte Carlo renderer traces every ray against the stone, including light that has already
left it, so on a concave stone it follows light across a groove or a hole and back in. Before
T-0036 the deterministic renderer did not: light leaving the stone was looked up in the lighting
straight away, as if the rest of the stone were not there. So on a concave stone the two
renderers disagreed wherever that happened, and they now agree (`concave_compare.compare` says
what "agree" is measured as, and why over blocks of pixels).

Each test says what it measured. By default Chrome renders with SwiftShader, as every harness
test here does; `GEM_TEST_GL=metal` uses the real GPU instead, about a hundred times faster.
`GEM_TEST_PAGE` points the tests at another build of the page, which is how they were shown to
fail on the renderer as it was before T-0036.

Skipped, with the reason, when the page is not built or Chrome or `websocket-client` is missing.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))
FIXTURES = os.path.join(PROJECT_ROOT, "tests", "fixtures")

sys.path.insert(0, HERE)

try:
    import cdp
    import concave_compare
except ImportError as error:  # websocket-client is not installed
    cdp = None
    IMPORT_ERROR = str(error)

PAGE = os.environ.get("GEM_TEST_PAGE") or os.path.join(PROJECT_ROOT, "build", "www", "studio.html")
GL_BACKEND = os.environ.get("GEM_TEST_GL") or None

# Render size and Monte Carlo samples: enough for the block averages to settle, small enough for
# SwiftShader. See each test for the numbers measured at these settings.
SIZE = 256
SAMPLES = 512


def fixture(name):
    with open(os.path.join(FIXTURES, name)) as source:
        return source.read()


@unittest.skipIf(cdp is None, "needs websocket-client: %s" % (IMPORT_ERROR if cdp is None else ""))
@unittest.skipUnless(os.path.isfile(PAGE), "the page is not built (%s); run ./build.sh" % PAGE)
class ConcaveStonesMatchMonteCarlo(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.chrome = cdp.Chrome(gl_backend=GL_BACKEND)
        except Exception as error:  # no Chrome on this machine
            raise unittest.SkipTest("could not start Chrome: %s" % error)

        concave_compare.open_page(cls.chrome, PAGE)
        print("\n[concave] %s on %s" % (PAGE, cls.chrome.gpu_renderer_string()), file=sys.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.chrome.close()

    def measure(self, name, spin, tilt):
        result = concave_compare.compare(self.chrome, fixture(name), spin, tilt, SIZE, SAMPLES)
        print(
            "[concave] %s at spin %g tilt %g: block mean %.2f, worst block %.2f (%d blocks)"
            % (name, spin, tilt, result["block_mean"], result["worst_block"], result["blocks"]),
            file=sys.stderr,
        )
        return result

    def test_light_crossing_a_groove_enters_the_far_wall(self):
        """The grooved bar, tilted 55 degrees: its two V grooves face the camera obliquely.

        Setup: `concave_grooved_bar.obj` (tests/fixtures), both renderers at the settings in
        `concave_compare.SETTINGS`. Test: the mean and the worst difference between 8 x 8 block
        averages of the two renders, over the stone. Verifies that light which leaves one groove
        wall -- out through it, or reflected off it -- and meets the other is followed into that
        wall, as the Monte Carlo renderer follows it. Looked up in the lighting instead, as before
        T-0036, the walls take the wrong colours in whole patches.

        Measured (M1 Pro, Metal, 256 px, 512 samples): THRESHOLDS below. The convex hex cut at
        the same settings, where there is nothing to re-enter, is the scale of what is left
        between the two renderers anyway (Monte Carlo noise, the band edges' aliasing).
        """
        result = self.measure("concave_grooved_bar.obj", 0.0, 55.0)

        self.assertLess(result["block_mean"], BAR_BLOCK_MEAN)
        self.assertLess(result["worst_block"], BAR_WORST_BLOCK)

    def test_light_crossing_the_hole_of_a_ring_enters_the_far_side(self):
        """The torus, tilted 55 degrees, so its inner wall and the far side of its hole show.

        Setup: `concave_torus.obj`. Test and measure as above. Verifies the same for light that
        leaves the inside of the ring and crosses the hole. Much less of the picture depends on
        that than on the bar's grooves, so the margin over the old behaviour is smaller (see
        THRESHOLDS); this test is mainly that the two renderers agree on a closed surface with
        a hole through it.
        """
        result = self.measure("concave_torus.obj", 0.0, 55.0)

        self.assertLess(result["block_mean"], TORUS_BLOCK_MEAN)
        self.assertLess(result["worst_block"], TORUS_WORST_BLOCK)


# THRESHOLDS, in levels of 255, set from these measurements (2026-09-29, M1 Pro, Metal, SIZE 256,
# SAMPLES 512, tilt 55), block mean / worst block:
#
#   stone                  this renderer     before T-0036
#   concave_grooved_bar    0.70 / 7.32       5.10 / 48.54
#   concave_torus          0.75 / 4.57       1.27 / 6.39
#   hex_cut_v2 (convex)    0.96 / 5.55       0.96 / 5.55   (the scale of what is left anyway)
#
# The bar's bounds sit between the two with a wide margin either side. The torus's block mean
# does too, narrowly; its worst block does not separate the two, so that bound is only a check
# that nothing in the ring disagrees badly.
BAR_BLOCK_MEAN = 2.0
BAR_WORST_BLOCK = 20.0
TORUS_BLOCK_MEAN = 1.05
TORUS_WORST_BLOCK = 8.0


if __name__ == "__main__":
    unittest.main()
