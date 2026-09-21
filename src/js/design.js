/*
 * design.js -- the polar internal representation of a faceted stone.
 *
 * A facet is a plane, and a plane has exactly three degrees of freedom. This
 * representation stores those three as the numbers a faceting machine is set
 * to, rather than as a Cartesian normal:
 *
 *   angle     the mast angle, in degrees, GemCad's signed convention
 *             (positive = crown, above the girdle; negative = pavilion)
 *   index     the index-wheel position, in teeth, not degrees
 *   distance  the depth of cut, the plane's distance from the stone's centre
 *
 * Why polar rather than a Cartesian (normal, offset) pair:
 *
 *   1. It is what a cutter reads, types and cuts. Exporting cutting
 *      instructions becomes the identity function.
 *   2. Symmetry stays structural. A tier is one (angle, distance) plus a list
 *      of integer index positions, so the sixteen facets of a tier are one
 *      object that moves together, not sixteen planes that happen to be
 *      coplanar and have to be re-detected as related.
 *   3. It is the variable vector a constraint solver would work in.
 *
 * It is NOT stored in polar for numerical accuracy. A Cartesian round trip
 * through f32 costs about 6.7e-7 degrees, which is 1.8e-7 of a single index
 * tooth -- far too small to matter. The reason is structural, not numerical.
 *
 * What this deliberately does not store: vertex positions. Corners are derived
 * by intersecting planes, and re-deriving them on load is what keeps the
 * representation small enough for a URL hash (about 600 bytes gzipped for a
 * real design) and what removes a whole class of defect -- see the note on
 * deriving indices from geometry, below.
 *
 * A classic browser script, like gemcad.js: no ES module syntax, nothing
 * loaded over the network, public surface published as globalThis.GemCadDesign
 * so make_page.py can inline it into the file:// page.
 */

(function () {
    "use strict";

    var DEGREES = Math.PI / 180;

    /* Schema version, written into every serialised design. Designs travel in
     * URL hashes, so they outlive the code that wrote them; a reader must be
     * able to tell an old document from a corrupt one. */
    var SCHEMA_VERSION = 1;

    /* A recovered index must land within this fraction of a tooth to be
     * snapped to that tooth. Anything further off is kept exactly as
     * recovered -- a real number, not an integer -- and the design is marked
     * fractional (see the `fractional` field on `design.gear`, and
     * `reExpressOnGear` below). This representation no longer refuses a
     * design for having an off-tooth facet; it just needs the fractional-teeth
     * option turned on to admit one (the user's explicit opt-in, 2026-09-18:
     * "the fractional teeth need explicit opt in and is default off").
     *
     * The tolerance still has to separate two different things, exactly as it
     * did when it was a rejection gate:
     *
     *   - genuine noise, from two sources: a meet-point solver's nudge (Gem
     *     Cut Studio moves a facet a hair so its corners land exactly on a
     *     meet, and stores the result -- hex_cut_v2's C3 ("Meet G1, C1, C2"),
     *     C4 ("Meet C1, C2") and C6 sit 1.29e-5, 6.66e-6 and 3.41e-6 of a
     *     tooth off, in GCS's own .gcs and its .gem export alike), and this
     *     representation's own re-expression arithmetic (see
     *     `reExpressOnGear`), which can leave a whole-tooth facet a few ULPs
     *     off after a round trip through another gear;
     *   - a facet genuinely cut off the tooth grid, which must snap only when
     *     it snaps to the tooth it is actually closest to, and stay fractional
     *     otherwise.
     *
     * The user's own rule (2026-09-18, "when reading a file if the fraction is
     * < .005 can you snap them"): the tolerance is 5e-3 of a TOOTH, not of a
     * degree -- at 96 teeth that is about 0.019 degrees, at 80 about 0.023.
     * This absorbed Green_Lion.gem (0.0011) and Heart_and_Soul.gem (0.0013,
     * found refused in T-0169's corpus run) as noise; everything at or above
     * TriZag_A.gem's 0.0062 becomes a fractional design instead.
     *
     * This was 1e-3 before the user's rule (and 1e-6 before that, which
     * refused the user's own hex_cut_v2_arya.gem, T-0155): both were
     * calibrated on the files at hand rather than derived from a stated rule,
     * which is the same mistake made twice on this same gate. Widening it
     * again cost nothing extra in accuracy the design ever needed: at 96
     * teeth 5e-3 of a tooth is still 0.019 degrees, an order of magnitude
     * under NORMAL_AGREEMENT_TOLERANCE's own 0.01-degree floor from GemCad's
     * angle rounding.
     *
     * A design that was previously snapped to a HALF_TOOTH position (removed
     * 2026-09-18, the user's explicit instruction: "dont snap to half
     * facets") is simply a fractional design now -- a half-tooth offset
     * (0.5 of a tooth) is nowhere near this tolerance, so it was never at risk
     * of being silently snapped to a neighbouring whole tooth; it just needed
     * somewhere to land, and fractional is that somewhere.
     *
     * Snapping does not move the rendered stone: the mesh is written from the
     * file's own corner points (gemcad_obj.js), not rebuilt from these polar
     * values. */
    var INDEX_SNAP_TOLERANCE = 5e-3;

    /* How far a facet's normal may lean off the optical axis, as the sine of
     * the lean, and still be a flat table or culet: a facet with no azimuth,
     * whose index is meaningless and is stored as 0.
     *
     * This was 1e-12, which only caught a normal that was exactly on the axis.
     * Chunkoid.gem's table leans 1.7e-8 degrees -- rounding noise -- so its
     * azimuth was computed from that noise, came out as tooth 89.18, and made
     * the whole design fractional. The user's ruling (2026-09-19): "fractional
     * tables don't matter".
     *
     * Measured across all of reference/gemology-project-designs: the most any
     * flat facet leans is 2.79e-5 (0.0016 degrees, Round_Cushion.gem's table),
     * and the least any genuinely tilted facet leans is 1.74e-2 (0.999
     * degrees, Tourmaline_Caterpillar_Final.gem). 1e-3 (0.057 degrees) sits
     * 36 times above the first and 17 times below the second. */
    var ON_AXIS_TOLERANCE = 1e-3;

    /* A derived normal must agree with the geometry it came from to within
     * this angle, in degrees.
     *
     * THE BOUND IS SET BY THE FILE'S OWN ANGLE PRECISION, NOT BY FLOAT NOISE.
     * A GemCad file writes each tier's mast angle rounded to two decimal
     * places while its facet normals carry the true angle, so rebuilding a
     * normal from the written angle is off by up to half a step of 0.01
     * degrees. That is 5e-3, and this allows a little over it.
     *
     * This was 1e-3, calibrated on the four bundled sample designs, and it
     * was WRONG: every angle in those files happens to be exact at two
     * decimals (-42.5, -41.5, 34, 28, 16, 0, -90), so they never exercised
     * the rounding at all and all eight readings came in at 1.2e-6. The first
     * real-world design tried, Fiorello_80.gem, was refused outright: its
     * tier 1 is written -47.04 where the geometry says -47.036010, a
     * disagreement of 3.99e-3. Its other quantised tiers measure 2.45e-3,
     * 3.69e-3 and 1.99e-3, and the tiers whose true angle is exact at two
     * decimals come in at 1e-14 -- textbook rounding, not a corrupt file.
     *
     * Do not tighten this below about 1e-5 expecting it to mean anything
     * either. The check compares directions with acos(dot), and acos is
     * ill-conditioned near 1: a dot product one ulp short of 1.0 (2.22e-16)
     * comes back as 1.207e-6 degrees, which is the floor of the comparison
     * rather than a real disagreement -- the normals themselves are
     * bit-identical.
     *
     * The gate that answers "can this design be described in index
     * coordinates" is INDEX_SNAP_TOLERANCE above. Fiorello_80.gem passes it at
     * 1.4e-14 of a tooth; it was itself loosened afterwards (T-0155) for
     * meet-point solved facets. */
    var NORMAL_AGREEMENT_TOLERANCE = 1e-2;

    /* ---------------------------------------------------------------- *
     * Polar <-> Cartesian
     * ---------------------------------------------------------------- */

    /**
     * The signed tooth count.
     *
     * GemCad writes a negative gear to mean the index wheel runs the other way
     * (`g -96 48.0`), and the sign genuinely belongs in the arithmetic: it
     * flips both the step angle and the origin offset. Storing a magnitude and
     * a flag keeps that explicit instead of hiding a negative inside a count.
     */
    function signedTeeth(design) {
        return design.gear.reversed ? -design.gear.teeth : design.gear.teeth;
    }

    /** Degrees of rotation per index tooth, carrying the wheel's direction. */
    function stepAngle(design) {
        return 360 / signedTeeth(design);
    }

    /**
     * The polar angle from the optical axis (+Z), in degrees, for a mast angle.
     *
     * GemCad's signed convention folds two things into one number: how far the
     * facet is tilted, and whether it faces up or down. A table facet is 0, a
     * girdle facet is +/-90, and a pavilion facet at -42.5 is tilted 42.5
     * degrees from straight down. As a polar angle measured from +Z that is
     * 137.5, so the mapping is `angle` for the crown and `180 + angle` for the
     * pavilion.
     *
     * Note that +90 and -90 describe the same plane; a girdle facet is vertical
     * either way. The authored sign is preserved so a design re-exports as it
     * was written, but nothing geometric depends on it.
     */
    function polarAngleOf(mastAngle) {
        return mastAngle >= 0 ? mastAngle : 180 + mastAngle;
    }

    /**
     * The inverse of `polarAngleOf`, choosing the crown branch at 90.
     *
     * At the OTHER pole -- polar angle 180, pointing straight down the
     * optical axis (a culet, or an on-axis pavilion facet) -- the plain
     * formula `polarAngle - 180` collapses to 0, the same value this
     * function gives at the crown's own pole (polar angle 0, the table).
     * That collision is real, not theoretical (T-0170): GemCad's own file
     * format cannot write a distinguishing "mast -0" to tell them apart,
     * and -0 would not survive this representation's own JSON
     * serialisation anyway (`JSON.stringify(-0)` is `"0"`). -90 cannot be
     * repurposed as that sentinel either, because it is already the real
     * mast angle of a genuine OFF-axis girdle facet -- measured 4904 times
     * across reference/gemology-project-designs, see
     * kb/the-polar-internal-representation.md. Mast angle 180 is otherwise
     * unreachable by any real facet (`polarAngleOf`'s pavilion branch only
     * ever produces values in (-90, 0) for an off-axis pavilion facet), so
     * it is this representation's own explicit marker for "points straight
     * down" -- `polarAngleOf(180)` already takes the `>= 0` branch and
     * returns 180 unchanged, so no change is needed there.
     */
    function mastAngleOf(polarAngle) {
        if (polarAngle >= 180) {
            return 180;
        }

        return polarAngle <= 90 ? polarAngle : polarAngle - 180;
    }

    /**
     * The outward unit normal of a facet.
     *
     * Derived by unrolling GemCad's own construction (a point at (0, d, 0)
     * pitched by the mast angle, then rolled to the index position), which
     * collapses to an ordinary spherical form. Verified against the parser's
     * computed normals for all 530 facets of the four sample designs in both
     * formats: the worst disagreement is one ulp of the dot product, which an
     * acos comparison reports as 1.2e-6 degrees (see NORMAL_AGREEMENT_TOLERANCE
     * for why that number is an artefact of the comparison, not an error).
     *
     * The azimuth is measured from +Y towards +X, not the mathematical
     * convention of +X towards +Y, because that is the wheel's own zero. In
     * standard terms the azimuth is `90 - r`.
     */
    function normalOf(design, mastAngle, index) {
        var step = stepAngle(design);
        var azimuth = (index * step - design.gear.originIndex * step) * DEGREES;
        var polar = polarAngleOf(mastAngle) * DEGREES;
        var sinPolar = Math.sin(polar);

        return {
            x: sinPolar * Math.sin(azimuth),
            y: sinPolar * Math.cos(azimuth),
            z: Math.cos(polar)
        };
    }

    /**
     * The polar description of a direction: the inverse of `normalOf`.
     *
     * `index` comes back as a real number, not snapped to a tooth, so a caller
     * can see how far off a whole tooth it landed and decide whether that is
     * acceptable. `fromGemCad` uses exactly that to gate its own output.
     */
    function polarOf(design, normal) {
        var length = Math.hypot(normal.x, normal.y, normal.z);

        if (length === 0) {
            throw new Error("cannot describe a zero-length direction in polar coordinates");
        }

        var z = Math.max(-1, Math.min(1, normal.z / length));
        var polar = Math.acos(z) / DEGREES;

        /* A facet on the optical axis -- the table, or a culet -- has no
         * azimuth: every index position describes the same plane. This is the
         * same degeneracy that makes d(normal)/d(index) vanish there, and the
         * reason a solver needs a separate chart at the pole. Index 0 is the
         * canonical choice. */
        var onAxis = Math.hypot(normal.x, normal.y) / length < ON_AXIS_TOLERANCE;

        /* Exactly 0 or 180, not the recovered angle: a flat facet a hair off
         * the axis would otherwise carry that hair (Round_Cushion's table,
         * 0.0016 degrees) into the tier's angle, and the page, which tests
         * for a table at 0 and a culet at 180, would file it as a crown
         * tier. */
        if (onAxis) {
            return { angle: z > 0 ? 0 : 180, index: 0, onAxis: true };
        }

        var step = stepAngle(design);
        var index = (Math.atan2(normal.x, normal.y) / DEGREES) / step + design.gear.originIndex;
        var span = design.gear.teeth;

        return {
            angle: mastAngleOf(polar),
            index: ((index % span) + span) % span,
            onAxis: false
        };
    }

    /**
     * Snaps a real-valued index (already wrapped into [0, teeth)) to a whole
     * tooth when it lands within `INDEX_SNAP_TOLERANCE` of one, and otherwise
     * reports it back exactly as given, flagged fractional.
     *
     * Shared by `fromGemCad` (recovering an index from a file's own geometry)
     * and `reExpressOnGear` (recomputing an index for a different gear) --
     * both produce a real number that OUGHT to be a whole tooth and may not
     * quite be, for the same two reasons (genuine off-tooth geometry, or
     * float noise from the arithmetic that produced the number), and both
     * need the identical decision about which one it is.
     *
     * The snapped branch wraps its result back into [0, teeth) too: a value
     * a hair under `teeth` rounds to `teeth` itself, which is tooth 0 again,
     * not a value one past the end of the wheel.
     */
    function snapIndexToTooth(rawIndex, teeth) {
        var nearest = Math.round(rawIndex);
        var snap = Math.abs(rawIndex - nearest);

        if (snap <= INDEX_SNAP_TOLERANCE) {
            return { index: nearest % teeth, snap: snap, fractional: false };
        }

        return { index: rawIndex, snap: snap, fractional: true };
    }

    /* ---------------------------------------------------------------- *
     * Planes
     * ---------------------------------------------------------------- */

    /**
     * Every facet of a design as an outward-facing plane.
     *
     * Each entry is `{ normal, offset, tier, facet, index, name }`, where a
     * point p lies on the facet when `dot(normal, p) === offset`, and inside
     * the stone when `dot(normal, p) <= offset`. That is the half-space form a
     * solid builder wants, and the form a constraint solver differentiates.
     */
    function planesOf(design) {
        var result = [];

        for (var t = 0; t < design.tiers.length; t++) {
            var tier = design.tiers[t];

            for (var f = 0; f < tier.facets.length; f++) {
                var facet = tier.facets[f];

                result.push({
                    normal: normalOf(design, tier.angle, facet.index),
                    offset: tier.distance,
                    tier: t,
                    facet: f,
                    index: facet.index,
                    name: facet.name || ""
                });
            }
        }

        return result;
    }

    /* ---------------------------------------------------------------- *
     * Tier flags: which tiers the rendered stone is built from
     * ---------------------------------------------------------------- */

    /**
     * True when a tier's facets cut the rendered stone.
     *
     * Three per-tier flags exist (T-0175's tier toolbar, 2026-09-19), all
     * optional booleans that default to false when absent:
     *
     *   hidden   the user switched the tier off ("disables the facet tier in
     *            the list of facets so it doesn't get rendered but it still
     *            shows up"): it stays in the cutting instructions, numbered,
     *            but its planes are left out of the stone. The only flag
     *            this function looks at.
     *   preform  a GemCad preform tier (read from a `.gem`'s PREFORM section,
     *            or set by the toolbar's Preform button). CUT NORMALLY (the
     *            user, 2026-09-18: "the teeth need to have the {} and cut it
     *            normally"); only its cutting teeth are shown in braces. The
     *            flag matters to the future edit mode instead: a tier that a
     *            deeper facet cuts away completely is normally removed from
     *            the list, but a preform tier is kept, for its meetpoints.
     *            (design_mesh.js used to leave a file's preform tiers out of
     *            the mesh, following the reference viewer; that stopped here.)
     *   frosted  a display mark only for now (the user: "doesn't update the
     *            render for now").
     *
     * The page and the mesh builder both ask this one function, so the
     * rendered stone (DesignMesh) and the facet<->tier map the page builds
     * against it can never disagree about which tiers are on the stone.
     */
    function isRenderedTier(tier) {
        return !tier.hidden;
    }

    /**
     * `planesOf(design)` restricted to the tiers `isRenderedTier` keeps. Each
     * entry's `tier` and `facet` still index into the FULL `design.tiers`, so
     * a caller can go from a plane back to its tier object exactly as with
     * `planesOf`.
     */
    function renderedPlanesOf(design) {
        return planesOf(design).filter(function (plane) {
            return isRenderedTier(design.tiers[plane.tier]);
        });
    }

    /**
     * Which of a design's planes (see `planesOf`) a given unit normal geometrically belongs
     * to, by nearest direction.
     *
     * Matching is by dot product, not by angle: `acos` is ill-conditioned near 1 (see the trap
     * documented on `NORMAL_AGREEMENT_TOLERANCE` above -- a dot product one ulp short of 1.0
     * reports as 1.2e-6 degrees, an artefact of the comparison, not of the geometry), so the
     * search itself never calls it. `errorDegrees` and `marginDegrees` DO call it, once each,
     * only to report a human-readable number about the match already found -- not to make it.
     *
     * There is always a best match (planes is never searched empty-handed the way a rejecting
     * gate would be), so this never throws for a non-empty `planes`; a caller that wants to
     * know whether the match is confident reads `marginDegrees`, the angular gap between the
     * best and second-best plane. T-0160 uses this to map a clicked mesh facet, by its own
     * outward normal, onto the design tier it was cut as part of.
     */
    function matchNormalToPlanes(planes, normal) {
        if (!planes || planes.length === 0) {
            throw new Error("cannot match a normal against an empty plane list");
        }

        var bestDot = -Infinity;
        var secondDot = -Infinity;
        var bestPlane = null;

        for (var i = 0; i < planes.length; i++) {
            var candidate = planes[i].normal;
            var dot = normal.x * candidate.x + normal.y * candidate.y + normal.z * candidate.z;

            if (dot > bestDot) {
                secondDot = bestDot;
                bestDot = dot;
                bestPlane = planes[i];
            } else if (dot > secondDot) {
                secondDot = dot;
            }
        }

        var clampedBest = Math.max(-1, Math.min(1, bestDot));
        var clampedSecond = Math.max(-1, Math.min(1, secondDot));
        var errorDegrees = Math.acos(clampedBest) / DEGREES;
        var secondErrorDegrees = Math.acos(clampedSecond) / DEGREES;

        return {
            tier: bestPlane.tier,
            facet: bestPlane.facet,
            errorDegrees: errorDegrees,
            marginDegrees: secondErrorDegrees - errorDegrees
        };
    }

    /* ---------------------------------------------------------------- *
     * Building a design from a parsed GemCad file
     * ---------------------------------------------------------------- */

    /* ---------------------------------------------------------------- *
     * Fields beyond the polar description: the superset of the file formats
     * ---------------------------------------------------------------- */

    /*
     * The design also keeps everything the three file formats (.asc, .gem, .gcs)
     * carry that the polar description above does not use, so that no attribute
     * of any format is lost on import. All of it is OPTIONAL and written by
     * toJSON only when it differs from its default, so a design from a format
     * without it (and every shared URL made before it existed) is unchanged.
     * Nothing here changes the stone or the page's material:
     *
     *   design.info     { title, author, date, shape, sizeMin, sizeMax, riMin,
     *                     riMax }  a .gcs's <info> (strings "" and numbers null
     *                     when absent). Its header/footer lines are in
     *                     design.headers / design.footnotes, like a GemCad
     *                     file's H and F lines.
     *   design.render   { material, refractiveIndex, dispersion, clarity,
     *                     density, lightingModel, color: {r,g,b} | null }  a
     *                     .gcs's <render>. RECORDED ONLY, never applied: it
     *                     would override the material the user chose.
     *   design.source   { generator, formatVersion }  the .asc "GemCad 5.0"
     *                     line and the .gcs root's version attribute.
     *   tier.name       the .gcs tier's own id ("P1", "C3").
     *   tier.hidden     from a .gcs's visible="false" (already a design flag).
     *   tier.guide      a .gcs guide tier. Recorded only: unlike `hidden` it
     *                     does not change what is rendered.
     *   facet.frosting  a .gcs facet's frosting amount (0.5 in every corpus
     *                     file that has it); `tier.frosted` is the tier-level
     *                     display mark the UI toggles.
     */

    function copyInfo(info) {
        return {
            title: info.title || "",
            author: info.author || "",
            date: info.date || "",
            shape: info.shape || "",
            sizeMin: info.sizeMin === undefined ? null : info.sizeMin,
            sizeMax: info.sizeMax === undefined ? null : info.sizeMax,
            riMin: info.riMin === undefined ? null : info.riMin,
            riMax: info.riMax === undefined ? null : info.riMax
        };
    }

    function copyRender(render) {
        function numberOrNull(value) {
            return value === undefined ? null : value;
        }

        return {
            material: render.material || "",
            refractiveIndex: numberOrNull(render.refractiveIndex),
            dispersion: numberOrNull(render.dispersion),
            clarity: numberOrNull(render.clarity),
            density: numberOrNull(render.density),
            lightingModel: render.lightingModel || "",
            color: render.color
                ? { r: render.color.r, g: render.color.g, b: render.color.b }
                : null
        };
    }

    /** Copies design-level optional fields from `from` (a design, or a parsed
     * file for `info`/`render`) onto `to`, leaving absent ones absent. */
    function copyDesignExtras(from, to) {
        if (from.info) {
            to.info = copyInfo(from.info);
        }

        if (from.render) {
            to.render = copyRender(from.render);
        }

        if (from.source && (from.source.generator || from.source.formatVersion)) {
            to.source = {
                generator: from.source.generator || "",
                formatVersion: from.source.formatVersion || ""
            };
        }
    }

    /** Copies `name` and `guide` from `from` onto tier `to` when non-default. */
    function copyTierExtras(from, to) {
        if (from.name) {
            to.name = from.name;
        }

        if (from.guide) {
            to.guide = true;
        }
    }

    /** A facet `{index, name}`, plus `frosting` when the source facet has any. */
    function makeFacet(index, name, frosting) {
        var facet = { index: index, name: name || "" };

        if (frosting > 0) {
            facet.frosting = frosting;
        }

        return facet;
    }

    /**
     * A design from the output of `GemCad.importBytes` and friends.
     *
     * Index positions are recovered from each facet's stored normal rather than
     * copied from the parser. That is not defensiveness: the binary reader's
     * back-computation of index numbers is wrong whenever the gear is negative,
     * because it takes an absolute value where it should wrap, which mirrors
     * the wheel. Measured on the stored normals, Turkey.gem disagrees on 67 of
     * 74 facets and CubeIllusionTri.gem on 48 of 51, by up to 165 degrees. It
     * is invisible if you compare index *sets* per tier, because the usual
     * index lists are symmetric under i -> teeth - i; it is only visible when
     * each facet's index is checked against its own geometry.
     *
     * Mast angles are taken from the parser, which agrees exactly between the
     * two formats across all fifty tiers of the sample set. Only the index
     * needed recovering.
     *
     * Every facet is then checked: the plane rebuilt from the recovered polar
     * values must reproduce the stored normal. A design whose normal fails to
     * rebuild is rejected rather than silently mirrored -- but a facet that
     * merely sits off its tooth (`INDEX_SNAP_TOLERANCE`) is no longer
     * rejected at all; it is kept as a fractional index, and `design.gear
     * .fractional` is turned on so the page's opt-in shows it rather than
     * hiding it (the user's explicit rule, 2026-09-18: loading such a design
     * turns the option on, since with it off the design could not be shown).
     */
    function fromGemCad(parsed, options) {
        options = options || {};

        if (!parsed || !parsed.metadata || !parsed.tiers) {
            throw new Error("not a parsed GemCad design");
        }

        var metadata = parsed.metadata;
        var teeth = Math.abs(metadata.gear);

        if (!(teeth > 0)) {
            throw new Error("a design needs a non-zero index gear, got " + metadata.gear);
        }

        var design = {
            v: SCHEMA_VERSION,
            name: options.name || "",
            gear: {
                teeth: teeth,
                reversed: metadata.gear < 0,
                originIndex: metadata.gearLocationAngle || 0,
                fractional: false
            },
            symmetry: {
                folds: metadata.symmetryFolds || 1,
                mirror: Boolean(metadata.symmetryMirror)
            },
            refractiveIndex: metadata.refractiveIndex || 0,
            tiers: [],
            headers: (metadata.headers || []).slice(),
            footnotes: (metadata.footnotes || []).slice()
        };

        // parsed.info / parsed.render exist only for a .gcs (gcs.js).
        copyDesignExtras({
            info: parsed.info,
            render: parsed.render,
            source: {
                generator: metadata.generator,
                formatVersion: metadata.formatVersion
            }
        }, design);

        var worstIndexSnap = 0;
        var worstNormalError = 0;
        var anyFractional = false;

        for (var t = 0; t < parsed.tiers.length; t++) {
            var source = parsed.tiers[t];
            var tier = {
                angle: source.angle,
                distance: source.distance,
                preform: Boolean(source.isPreform),
                hidden: Boolean(source.isHidden), // .gcs visible="false" (gcs.js)
                frosted: Boolean(source.isFrosted), // only a .gcs sets this (gcs.js)
                cuttingInstructions: source.cuttingInstructions || "",
                facets: []
            };

            copyTierExtras({ name: source.name, guide: source.isGuide }, tier);

            for (var i = 0; i < source.indices.length; i++) {
                var entry = source.indices[i];
                var stored = entry.facetNormal;
                var index;

                /* `facetNormal` is not a unit vector: the reader builds it as
                 * the plane point plus three units along the outward normal.
                 * Only its direction is meaningful, which is all `polarOf`
                 * uses. */
                var exactIndex;

                if (stored && Math.hypot(stored.x, stored.y, stored.z) > 0) {
                    var recovered = polarOf(design, stored);

                    /* On the optical axis the index is arbitrary, and the two
                     * file formats do not even agree on what to write: Turkey's
                     * table is index -96 in the text and 96 in the binary, both
                     * of which are tooth 0. Canonicalise, rather than carrying a
                     * meaningless number that makes two readings of one design
                     * compare unequal. */
                    index = recovered.onAxis ? 0 : recovered.index;

                    /* The EXACT value recovered straight from geometry --
                     * before any snapping -- kept separately so the
                     * normal-agreement gate below can be checked against it
                     * instead of the (possibly snapped) stored index. See the
                     * comment on that gate for why the two must not be
                     * conflated: snapping is EXPECTED to introduce a small,
                     * already-bounded (INDEX_SNAP_TOLERANCE) disagreement of
                     * its own, which is not the angle-rounding defect this
                     * gate exists to catch. */
                    exactIndex = index;

                    /* T-0170: an on-axis facet's ANGLE needs the same
                     * distrust as its index, and for the same reason -- the
                     * file's own value can be a sentinel rather than a real
                     * mast angle. gemcad.js's binary reader (faithfully
                     * reproducing GemCad's own convention) writes -90 for a
                     * facet pointing straight down the axis, exactly the
                     * angle a genuine OFF-axis girdle facet also uses --
                     * measured 4904 times elsewhere in the corpus. Kept as
                     * the file's own -90, normalOf's general formula rebuilds
                     * a horizontal girdle plane, not a straight-down one, 90
                     * degrees from the stored geometry: this is exactly
                     * Witt96, Kyle's_Tablet, Hanabi, Star_of_david_43-45-47,
                     * Thank_you_Bernd and Fiorino_80's shared failure.
                     * `recovered.angle` (mastAngleOf) already disambiguates
                     * the two poles as 0 (table) vs 180 (points down), so it
                     * replaces the file's angle for this tier -- a no-op for
                     * the table case, since the file already agrees there. */
                    if (recovered.onAxis) {
                        tier.angle = recovered.angle;
                    }

                    if (!recovered.onAxis) {
                        var snapped = snapIndexToTooth(index, design.gear.teeth);

                        worstIndexSnap = Math.max(worstIndexSnap, snapped.snap);
                        anyFractional = anyFractional || snapped.fractional;
                        index = snapped.index;
                    }
                } else {
                    /* No stored geometry to recover from; trust the file, but
                     * still wrap it into [0, teeth) so index arithmetic and
                     * equality behave the same way for every facet. */
                    index = ((entry.index % teeth) + teeth) % teeth;
                }

                tier.facets.push(makeFacet(index, entry.name, entry.frosting));

                /* Gate: does the polar description rebuild the geometry?
                 *
                 * Checked against `exactIndex` (the value recovered straight
                 * from geometry), NOT the possibly-snapped `index` just
                 * stored on the facet. This isolates the one thing this gate
                 * is for -- does the FILE'S OWN WRITTEN ANGLE (rounded to two
                 * decimals; see NORMAL_AGREEMENT_TOLERANCE) reproduce the
                 * stored normal -- from index snapping, a separate,
                 * independently-bounded concern (INDEX_SNAP_TOLERANCE).
                 * `exactIndex` is, by construction (`polarOf` is `normalOf`'s
                 * exact inverse), always within the acos floor of
                 * reproducing `stored` on its own, so conflating the two
                 * would let the snap tolerance silently widen this gate --
                 * and did, until this was separated: raising
                 * INDEX_SNAP_TOLERANCE to 5e-3 of a tooth (T-0171) means a
                 * snap can move a normal by up to 5e-3 of a tooth's own
                 * step, which is BIGGER than this gate's 1e-2 degrees on any
                 * wheel with fewer than 720 teeth. */
                if (stored && Math.hypot(stored.x, stored.y, stored.z) > 0) {
                    var rebuilt = normalOf(design, tier.angle, exactIndex);
                    var length = Math.hypot(stored.x, stored.y, stored.z);
                    var agreement = Math.max(-1, Math.min(1,
                        rebuilt.x * stored.x / length +
                        rebuilt.y * stored.y / length +
                        rebuilt.z * stored.z / length));
                    var error = Math.acos(agreement) / DEGREES;

                    worstNormalError = Math.max(worstNormalError, error);

                    if (error > NORMAL_AGREEMENT_TOLERANCE) {
                        throw new Error(
                            "tier " + t + " facet " + i + ": the polar description " +
                            "rebuilds a normal " + error.toFixed(6) + " degrees away " +
                            "from the geometry in the file"
                        );
                    }
                }
            }

            design.tiers.push(tier);
        }

        design.gear.fractional = anyFractional;

        /* Reported rather than logged, so a caller can surface it. */
        design.provenance = {
            worstIndexSnap: worstIndexSnap,
            worstNormalError: worstNormalError
        };

        return design;
    }

    /* ---------------------------------------------------------------- *
     * Serialisation
     * ---------------------------------------------------------------- */

    /**
     * A design as a plain object ready for `JSON.stringify`.
     *
     * `provenance` is dropped: it describes the import that produced this
     * design, not the design, and it must not travel in a shared URL.
     *
     * `gear.fractional` did NOT need a SCHEMA_VERSION bump when it was added
     * (2026-09-18): a document written by an OLDER reader simply has no such
     * key, and `fromJSON` below defaults a missing one to `false`, which is
     * exactly correct for every document that predates the field (none of
     * them could hold a fractional index in the first place, since the
     * reader that wrote them refused one). A document written by a NEWER
     * reader, with the flag on and real fractional indices, still loads fine
     * in an OLDER build too: nothing downstream of `fromJSON` assumes an
     * index is an integer -- `normalOf`/`planesOf` are already continuous in
     * it -- so an old reader silently ignores a flag it does not know about
     * and renders the identical stone. The version number is for a change
     * that breaks reading, not merely one that adds a new fact.
     */
    function toJSON(design) {
        var json = {
            v: SCHEMA_VERSION,
            name: design.name || "",
            gear: {
                teeth: design.gear.teeth,
                reversed: design.gear.reversed,
                originIndex: design.gear.originIndex,
                fractional: Boolean(design.gear.fractional)
            },
            symmetry: {
                folds: design.symmetry.folds,
                mirror: design.symmetry.mirror
            },
            refractiveIndex: design.refractiveIndex,
            tiers: design.tiers.map(function (tier) {
                /* `hidden` and `frosted` (T-0175) are written as booleans
                 * like `preform`. No SCHEMA_VERSION bump, for the same
                 * reason as `gear.fractional` above: an older reader ignores
                 * them, and fromJSON defaults a missing one to false. */
                return {
                    angle: tier.angle,
                    distance: tier.distance,
                    preform: tier.preform,
                    hidden: Boolean(tier.hidden),
                    frosted: Boolean(tier.frosted),
                    cuttingInstructions: tier.cuttingInstructions,
                    facets: tier.facets.map(function (facet) {
                        return makeFacet(facet.index, facet.name, facet.frosting);
                    })
                };
            }),
            headers: design.headers.slice(),
            footnotes: design.footnotes.slice()
        };

        copyDesignExtras(design, json);

        design.tiers.forEach(function (tier, t) {
            copyTierExtras(tier, json.tiers[t]);
        });

        return json;
    }

    /**
     * A design from a plain object, checking the schema version.
     *
     * An unknown version is refused rather than guessed at: a shared URL from a
     * future version would otherwise load as a subtly wrong stone.
     */
    function fromJSON(source) {
        if (!source || typeof source !== "object") {
            throw new Error("not a design document");
        }

        if (source.v !== SCHEMA_VERSION) {
            throw new Error(
                "design schema version " + source.v + " is not supported " +
                "(this build reads version " + SCHEMA_VERSION + ")"
            );
        }

        if (!source.gear || !(source.gear.teeth > 0)) {
            throw new Error("design document has no index gear");
        }

        if (!Array.isArray(source.tiers)) {
            throw new Error("design document has no tiers");
        }

        var design = {
            v: SCHEMA_VERSION,
            name: source.name || "",
            gear: {
                teeth: source.gear.teeth,
                reversed: Boolean(source.gear.reversed),
                originIndex: source.gear.originIndex || 0,
                fractional: Boolean(source.gear.fractional)
            },
            symmetry: {
                folds: (source.symmetry && source.symmetry.folds) || 1,
                mirror: Boolean(source.symmetry && source.symmetry.mirror)
            },
            refractiveIndex: source.refractiveIndex || 0,
            tiers: source.tiers.map(function (tier) {
                return {
                    angle: tier.angle,
                    distance: tier.distance,
                    preform: Boolean(tier.preform),
                    hidden: Boolean(tier.hidden),
                    frosted: Boolean(tier.frosted),
                    cuttingInstructions: tier.cuttingInstructions || "",
                    facets: (tier.facets || []).map(function (facet) {
                        return makeFacet(facet.index, facet.name, facet.frosting);
                    })
                };
            }),
            headers: (source.headers || []).slice(),
            footnotes: (source.footnotes || []).slice()
        };

        copyDesignExtras(source, design);

        source.tiers.forEach(function (tier, t) {
            copyTierExtras(tier, design.tiers[t]);
        });

        return design;
    }

    /* ---------------------------------------------------------------- *
     * Re-expressing a design on a different gear
     * ---------------------------------------------------------------- */

    /**
     * A new design, identical in every physical sense, whose facets are
     * described as index positions on `newGear` instead of `design`'s own
     * gear -- the gear-dialog's "apply" step (T-0171: "updating the tooth
     * count should also update the instructions").
     *
     * `newGear` is `{ teeth, reversed }`; `reversed` defaults to the source
     * design's own, since nothing on the page offers to flip it independently
     * of the tooth count, but the formula below still needs to know it can
     * change, because GemCad's own sign convention (`signedTeeth`) folds the
     * wheel's direction into a SIGNED tooth count, and it is that signed
     * count whose ratio actually describes the transform.
     *
     * THE MATH. A facet's physical azimuth is `(index - originIndex) * step`,
     * where `step = 360 / signedTeeth`. Re-expressing on a new gear must hold
     * that azimuth fixed while `step` changes, which -- multiplying both
     * sides by the ratio of the two signed tooth counts -- means both the
     * facet's index and the gear's own origin index scale by the SAME factor,
     * `newSignedTeeth / oldSignedTeeth`:
     *
     *     newIndex       = oldIndex       * (newSignedTeeth / oldSignedTeeth)
     *     newOriginIndex = oldOriginIndex * (newSignedTeeth / oldSignedTeeth)
     *
     * Using the SIGNED ratio (rather than the plain tooth-count ratio) is what
     * "taking a reversed gear into account" means concretely: if the new gear
     * reverses direction relative to the old one, the ratio itself goes
     * negative, and every index mirrors as well as rescales, which is exactly
     * what has to happen for the same physical facet to still point the same
     * way on a wheel now running the other direction.
     *
     * A facet's MAST ANGLE never changes here -- the gear only rotates a
     * facet about the optical axis, never tilts it -- so `tier.angle` (and
     * therefore `isPavilionTier`/`isGirdleTier`/`isCuletTier`/`tierId`, all of
     * which key off the angle alone) is carried over untouched, and the
     * mesh -- built from each facet's plane, `normal` and `offset` alike --
     * does not move either: see `planesOf`, unchanged by a re-expression, in
     * design_test.js.
     *
     * Each new index is then passed through the SAME `snapIndexToTooth` the
     * file reader uses: a value that lands within `INDEX_SNAP_TOLERANCE` of a
     * whole tooth on the NEW gear snaps to it (this is what makes an
     * even-to-even change like 96 -> 48 come back perfectly whole-toothed,
     * and what makes a round trip through an intermediate gear return to the
     * original indices rather than drifting by float noise); anything
     * further off stays fractional, and `newGear.fractional` -- like
     * `fromGemCad`'s -- is true whenever any facet needed that.
     *
     * Returns a new design object; `design` itself is never mutated. A
     * caller that wants to preserve tier/facet OBJECT IDENTITY (so a facet-
     * tier map or a DOM row keyed by the tier object stays valid -- see
     * kb/page-and-controls.md's "Drag tier rows to reorder" for why that
     * matters on this page) copies the returned indices back onto its own
     * tier/facet objects in place, rather than swapping in the object this
     * function returns; the page's gear dialog
     * (`web/src/components/GearDialog.svelte`) does exactly that.
     */
    function reExpressOnGear(design, newGear) {
        var teeth = newGear.teeth;
        var reversed = newGear.reversed !== undefined ?
            Boolean(newGear.reversed) : design.gear.reversed;

        if (!(teeth > 0)) {
            throw new Error("a design needs a non-zero index gear, got " + teeth);
        }

        var oldSigned = signedTeeth(design);
        var newSigned = reversed ? -teeth : teeth;
        var ratio = newSigned / oldSigned;

        var result = {
            v: design.v,
            name: design.name,
            gear: {
                teeth: teeth,
                reversed: reversed,
                originIndex: design.gear.originIndex * ratio,
                fractional: false
            },
            // Defensive copies, matching fromJSON/toJSON's own convention: neither the
            // gear count nor the tooth positions touch these, but a caller should never be
            // able to mutate the SOURCE design by mutating the returned one.
            symmetry: {
                folds: design.symmetry.folds,
                mirror: design.symmetry.mirror
            },
            refractiveIndex: design.refractiveIndex,
            tiers: [],
            headers: design.headers.slice(),
            footnotes: design.footnotes.slice()
        };

        copyDesignExtras(design, result);

        var anyFractional = false;

        for (var t = 0; t < design.tiers.length; t++) {
            var sourceTier = design.tiers[t];
            var tier = {
                angle: sourceTier.angle,
                distance: sourceTier.distance,
                preform: sourceTier.preform,
                hidden: Boolean(sourceTier.hidden),
                frosted: Boolean(sourceTier.frosted),
                cuttingInstructions: sourceTier.cuttingInstructions,
                facets: []
            };

            copyTierExtras(sourceTier, tier);

            for (var f = 0; f < sourceTier.facets.length; f++) {
                var facet = sourceTier.facets[f];
                var raw = facet.index * ratio;
                var wrapped = ((raw % teeth) + teeth) % teeth;
                var snapped = snapIndexToTooth(wrapped, teeth);

                anyFractional = anyFractional || snapped.fractional;

                tier.facets.push(makeFacet(snapped.index, facet.name, facet.frosting));
            }

            result.tiers.push(tier);
        }

        result.gear.fractional = anyFractional;

        return result;
    }

    /** Total facet count, the number a cutter counts. */
    function facetCount(design) {
        return design.tiers.reduce(function (total, tier) {
            return total + tier.facets.length;
        }, 0);
    }

    globalThis.GemCadDesign = {
        SCHEMA_VERSION: SCHEMA_VERSION,
        fromGemCad: fromGemCad,
        toJSON: toJSON,
        fromJSON: fromJSON,
        planesOf: planesOf,
        isRenderedTier: isRenderedTier,
        renderedPlanesOf: renderedPlanesOf,
        matchNormalToPlanes: matchNormalToPlanes,
        normalOf: normalOf,
        polarOf: polarOf,
        polarAngleOf: polarAngleOf,
        mastAngleOf: mastAngleOf,
        signedTeeth: signedTeeth,
        stepAngle: stepAngle,
        facetCount: facetCount,
        reExpressOnGear: reExpressOnGear,
        tolerances: {
            indexSnap: INDEX_SNAP_TOLERANCE,
            normalAgreement: NORMAL_AGREEMENT_TOLERANCE
        }
    };
}());
