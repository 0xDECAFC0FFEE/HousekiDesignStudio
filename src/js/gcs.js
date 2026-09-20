/*
 * gcs.js -- reads Gem Cut Studio's own .gcs design files (T-0148).
 *
 * A .gcs is plain XML with CRLF line endings:
 *
 *   <GemCutStudio version="1000">
 *     <index gear="96" base="0" symmetry="6" mirror="0"/>
 *     <tier angle="143.41952158876754" depth="0.45209649369186516" name="P1"
 *           instructions="Cut to centerpoint." visible="true" guide="false">
 *       <facet nx="..." ny="..." nz="..." index_angle="15.000000000000163">
 *         <vertex x="..." y="..." z="..."/>
 *         ... one vertex element per corner, in order
 *       </facet>
 *       ... one facet element per facet in the tier
 *     </tier>
 *     ... more tiers
 *     <render material="(from file)" refractive_index="2.16" ...><color .../></render>
 *     <info title="hex cut v2 (arya)" author="0xDECAFC0FFEE" date="August 2024"/>
 *   </GemCutStudio>
 *
 * WHY NOT DOMPARSER. `DOMParser` is built into every browser and would read this fine
 * from file://, but Deno -- the runtime this project's whole `www/js/tests/` suite
 * already depends on (see design_test.js, gemcad_test.js) -- has no DOM at all. Rather
 * than inject a swappable parser and risk the browser and the test exercising two
 * different code paths, this hand-writes one small scanner for the format's own very
 * regular subset (self-closing and container elements, double-quoted attributes, the
 * five standard entities, numeric character references) and runs it identically in the
 * browser and under `deno test`. It does not need to be a general XML parser: this
 * file's whole surface, examined 2026-09-18 alongside `resources/hex_cut_v2.gcs`, uses none
 * of namespaces, CDATA or single-quoted attributes, and a document that did should fail
 * loudly (a thrown Error) rather than silently mis-parse.
 *
 * WHAT THIS PRODUCES. `importText` returns a `GemCadFileData`-shaped object -- exactly
 * what `GemCad.importBytes` (gemcad.js) returns for a `.asc`/`.gem` file: `{metadata,
 * tiers}`, each tier `{isPreform, number, angle, distance, cuttingInstructions,
 * indices}`, each index `{tier, name, index, facetNormal, points, renderingTriangles}`.
 * That is deliberate, not incidental: `GemCadObj.toObjText` (gemcad_obj.js) and
 * `GemCadDesign.fromGemCad` (design.js) are both already written and tested against that
 * shape, so a .gcs reaches the same OBJ writer and the same polar-design builder as a
 * .asc or .gem, with no code of its own in either. The mesh is written straight from
 * each facet's own ordered `<vertex>` corners -- NOT by intersecting planes, which is
 * what `toObjText` already does with `index.points`.
 *
 * THE ANGLE CONVENTION. `tier/@angle` is a POLAR angle (measured from the optical axis,
 * +Z), not GemCad's signed MAST angle -- see kb/the-polar-internal-representation.md.
 * `GemCadDesign.mastAngleOf` converts it, the same function the page's own
 * `selfCheckTierIdsAgainstHexCutV2Gcs` (web/src/lib/tiers.js) calls, so a `.gcs` girdle (polar 90) and a
 * GemCad `.asc`/`.gem` girdle (mast -90) are classified the same way downstream --
 * `isGirdleTier` in the page checks `abs(angle) == 90` before the sign test precisely
 * because of this.
 *
 * THE INDEX CROSS-CHECK. `facet/@index_angle` is the tooth position, in degrees, that
 * Gem Cut Studio itself believes the facet sits at -- but NOT simply `index_angle /
 * (360 / gear)`: measured against every facet of resources/hex_cut_v2.gcs, a crown facet's
 * index_angle and a pavilion-or-girdle facet's relate to the facet's own azimuth by
 * MIRRORED formulas, half a gear turn apart. See `toothFromIndexAngle`'s own comment for
 * the measurement and the conversion. `fromGemCad` (design.js) already recovers each
 * facet's tooth from its own stored normal and gates that recovery against
 * `INDEX_SNAP_TOLERANCE` -- but it has no way to know what the FILE claims the tooth is,
 * since a `.asc`/`.gem`'s own index numbers are not trustworthy on a reversed gear (see
 * design.js's own comment). A `.gcs` gives an independent second opinion, so this module
 * checks it here, immediately, using the same tolerance: a facet whose `index_angle`
 * disagrees with the tooth its own geometry
 * recovers is refused before `fromGemCad` ever runs, rather than silently accepted
 * because two different numbers happen to round to the same integer.
 *
 * NOT READ: `<render>`. It carries a refractive index, dispersion, clarity, density, a
 * body colour and a lighting model -- applying any of them would silently override the
 * material the user has chosen and change every comparison render. See T-0148's ticket
 * and kb/clean-room-and-licensing-constraints.md's neighbour,
 * kb/the-polar-internal-representation.md.
 *
 * A classic browser script, like gemcad.js, gemcad_obj.js and design.js: no ES module
 * syntax, nothing loaded over the network, public surface published as
 * globalThis.GemCutStudio so make_page.py can inline it into the file:// page.
 */

(function () {
    "use strict";

    /* ---------------------------------------------------------------- *
     * A tiny XML scanner for this format's own regular subset.
     * ---------------------------------------------------------------- */

    /** The five standard XML entities, plus numeric character references. Attribute
     * values in this format never need more, but a `.gcs` title or author could
     * plausibly contain "&amp;" or similar, so this is not skipped. */
    function decodeEntities(text) {
        return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, function (whole, body) {
            if (body.charAt(0) === "#") {
                var codePoint = body.charAt(1) === "x" || body.charAt(1) === "X"
                    ? parseInt(body.slice(2), 16)
                    : parseInt(body.slice(1), 10);

                return String.fromCodePoint(codePoint);
            }

            switch (body) {
                case "lt": return "<";
                case "gt": return ">";
                case "amp": return "&";
                case "quot": return "\"";
                case "apos": return "'";
                default: return whole; // an unknown entity is left as written, not guessed at
            }
        });
    }

    // Matches one start, end or self-closing tag, capturing: (1) a leading "/" for an end
    // tag, (2) the tag name, (3) the raw attribute text, (4) a trailing "/" for a
    // self-closing tag. Attribute values must be double-quoted, which every attribute in
    // this format's own files is.
    var TAG_PATTERN = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_:][\w:.-]*\s*=\s*"[^"]*")*)\s*(\/?)\s*>/g;
    var ATTRIBUTE_PATTERN = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;

    /** The attributes of one tag, decoded, from the raw text `TAG_PATTERN` captured. */
    function parseAttributes(rawAttributes) {
        var attributes = {};
        var match;

        ATTRIBUTE_PATTERN.lastIndex = 0;

        while ((match = ATTRIBUTE_PATTERN.exec(rawAttributes)) !== null) {
            attributes[match[1]] = decodeEntities(match[2]);
        }

        return attributes;
    }

    /**
     * Parses `xml` into a tree of `{tag, attributes, children}` nodes under one synthetic
     * root (tag `"#document"`), matching start/end tags with a stack so a document whose
     * tags do not nest correctly is refused rather than silently misread. Does not strip
     * XML comment markup -- this format's own files (examined 2026-09-18) never contain
     * any, and the literal four-character comment-open token cannot appear in this
     * source file at all (make_page.py's `inline_script_text` refuses to inline any
     * script containing it, the same rule gemcad_obj.js's own header comment describes
     * without quoting it), so a helper for it could not even be written straightforwardly
     * in a doc comment, let alone the code.
     */
    function parseXml(xml) {
        var root = { tag: "#document", attributes: {}, children: [] };
        var stack = [root];
        var match;

        TAG_PATTERN.lastIndex = 0;

        while ((match = TAG_PATTERN.exec(xml)) !== null) {
            var isEndTag = match[1] === "/";
            var tagName = match[2];
            var isSelfClosing = match[4] === "/";

            if (isEndTag) {
                var top = stack[stack.length - 1];

                if (stack.length < 2 || top.tag !== tagName) {
                    throw new Error(
                        "malformed .gcs: </" + tagName + "> does not match the open element " +
                        (stack.length < 2 ? "(none)" : "<" + top.tag + ">")
                    );
                }

                stack.pop();
                continue;
            }

            var node = { tag: tagName, attributes: parseAttributes(match[3]), children: [] };

            stack[stack.length - 1].children.push(node);

            if (!isSelfClosing) {
                stack.push(node);
            }
        }

        if (stack.length !== 1) {
            throw new Error("malformed .gcs: <" + stack[stack.length - 1].tag + "> is never closed");
        }

        return root;
    }

    /** `node`'s direct children whose tag is `tagName`, in document order. */
    function childrenNamed(node, tagName) {
        return node.children.filter(function (child) {
            return child.tag === tagName;
        });
    }

    /** `node`'s `name` attribute, parsed as a finite number, or an Error naming both. */
    function numberAttribute(node, name) {
        var raw = node.attributes[name];
        var value = raw === undefined ? NaN : Number(raw);

        if (!Number.isFinite(value)) {
            throw new Error(
                "malformed .gcs: <" + node.tag + "> has no numeric \"" + name + "\" attribute " +
                "(got " + JSON.stringify(raw) + ")"
            );
        }

        return value;
    }

    /* ---------------------------------------------------------------- *
     * Building the GemCadFileData shape
     * ---------------------------------------------------------------- */

    /**
     * `facet/@index_angle`, converted to the tooth `GemCadDesign.polarOf` would recover
     * from the SAME facet's normal -- these are not the same number in the file's own
     * units, and the difference is not noise.
     *
     * MEASURED (2026-09-18, against every one of resources/hex_cut_v2.gcs's 66 off-axis
     * facets, worst residual 2.1e-14 of a tooth): a crown facet's index_angle relates to
     * design.js's own azimuth (measured from +Y towards +X, GemCad's wheel zero) by
     * `azimuth = 180 - index_angle`, while a PAVILION OR GIRDLE facet's relates by
     * `azimuth = 180 + index_angle` -- mirrored, not merely offset. T-0148's ticket
     * description assumed the crown formula everywhere ("index_angle / (360/gear)" with
     * no sign distinction) and got P1's first facet wrong by exactly half the gear (tooth
     * 4 by that arithmetic, tooth 52 by the geometry) -- 48 teeth is 180 degrees, which is
     * the mirror this function accounts for. See kb/reading-gemcad-and-gcs-index-angle-
     * conventions.md for the full measurement and a plausible reason (a cutter dops the
     * pavilion end-for-end from the crown, which both reverses the apparent rotation
     * sense and rotates the reference zero by half a turn).
     *
     * Which side a tier is on is decided by the tier's own RAW POLAR angle (essentially
     * >= 90 is pavilion or girdle), not by the mast angle `mastAngleOf` produces:
     * `mastAngleOf`'s own `<=` branch can push a polar angle a hair over 90 (hex_cut_v2's
     * own G1, 90.000000000001691) to a mast angle a hair under -90, which would put a
     * girdle on the wrong side of a `<` test on the CONVERTED angle. The raw polar angle
     * has no such edge from `mastAngleOf`'s own arithmetic -- but a real girdle's raw
     * angle is not always a hair OVER 90 the way hex_cut_v2's is: NQR_Round.gcs and
     * Round_Cushion.gcs (reference/gemology-project-designs/) both store G1 at
     * 89.999999999999986/89.999999999999929 -- a hair UNDER 90, from whatever arithmetic
     * Gem Cut Studio itself used to write the file. A bare `>= 90` misclassified both as
     * crown, using the wrong mirror formula for every off-axis G1 facet and throwing on
     * the cross-check below by exactly `2 * index_angle` teeth (measured: index_angle 30,
     * gear 96 -> 60 degrees -> 16 teeth, matching both files' actual error). `GIRDLE_ANGLE_
     * EPSILON` treats anything within it of 90 as the girdle side regardless of which way
     * the file's own noise falls, the same way `TIER_ANGLE_EPSILON` (web/src/lib/tiers.js)
     * already treats a mast angle near 0 or 90 as the table or the girdle for the same
     * reason -- a genuine crown facet is nowhere near this close to 90 in any real design.
     */
    var GIRDLE_ANGLE_EPSILON = 1e-6;

    function toothFromIndexAngle(indexAngle, polarAngle, stepAngle, originIndex, teeth) {
        var pavilionOrGirdle = polarAngle >= 90 - GIRDLE_ANGLE_EPSILON;
        var azimuth = pavilionOrGirdle ? (180 + indexAngle) : (180 - indexAngle);
        var tooth = azimuth / stepAngle + originIndex;

        return ((tooth % teeth) + teeth) % teeth;
    }

    /** One `<facet>` element, as a `GemCadFileTierIndexData`-shaped object (gemcad.js),
     * plus the cross-check against its own `index_angle` attribute described in the file
     * header comment above and in `toothFromIndexAngle`. `polarAngle` is the enclosing
     * tier's raw (pre-mastAngleOf) angle; `stepAngle` and `designStub` are the whole
     * design's shared index-wheel geometry, computed once by the caller. */
    function readFacet(facetNode, tierName, polarAngle, stepAngle, designStub) {
        var normal = {
            x: numberAttribute(facetNode, "nx"),
            y: numberAttribute(facetNode, "ny"),
            z: numberAttribute(facetNode, "nz"),
        };
        var indexAngle = numberAttribute(facetNode, "index_angle");

        var points = childrenNamed(facetNode, "vertex").map(function (vertexNode) {
            return {
                x: numberAttribute(vertexNode, "x"),
                y: numberAttribute(vertexNode, "y"),
                z: numberAttribute(vertexNode, "z"),
            };
        });

        if (points.length < 3) {
            throw new Error(
                "malformed .gcs: a facet in tier \"" + tierName + "\" has only " +
                points.length + " <vertex> corners"
            );
        }

        var teeth = designStub.gear.teeth;
        var fileIndex = toothFromIndexAngle(
            indexAngle, polarAngle, stepAngle, designStub.gear.originIndex, teeth
        );

        // The tooth the facet's OWN geometry says it is cut at: an independent route to
        // the same number, using exactly the function `GemCadDesign.fromGemCad` uses
        // internally, so this is a genuine cross-check rather than the same arithmetic
        // read twice. Skipped on the optical axis (the table, here), where every index
        // describes the same plane and `index_angle` is not meaningful -- design.js
        // canonicalises that case to index 0 itself.
        var recovered = globalThis.GemCadDesign.polarOf(designStub, normal);

        if (!recovered.onAxis) {
            var difference = Math.abs(fileIndex - recovered.index);
            var circularDifference = Math.min(difference, teeth - difference);
            var tolerance = globalThis.GemCadDesign.tolerances.indexSnap;

            if (circularDifference > tolerance) {
                throw new Error(
                    "tier \"" + tierName + "\": a facet's index_angle (tooth " +
                    fileIndex.toFixed(6) + ") disagrees with the tooth its own normal " +
                    "recovers (" + recovered.index.toFixed(6) + ") by " +
                    circularDifference.toFixed(6) + " of a tooth, past the " +
                    tolerance + " tolerance"
                );
            }
        }

        return {
            tier: 0, // unused downstream; GemCadFileTierIndexData carries it but nothing reads it
            name: "",
            index: fileIndex,
            facetNormal: normal,
            points: points,
            renderingTriangles: [], // .gcs has no smoothed render mesh; toObjText never reads this
        };
    }

    /** One `<tier>` element, as a `GemCadFileTierData`-shaped object (gemcad.js).
     * `designStub` is the whole design's index-wheel geometry (gear, origin), needed to
     * cross-check each facet's `index_angle` against its own normal. */
    function readTier(tierNode, designStub) {
        var polarAngle = numberAttribute(tierNode, "angle");
        var name = tierNode.attributes.name || "";
        var stepAngle = 360 / designStub.gear.teeth;

        var indices = childrenNamed(tierNode, "facet").map(function (facetNode) {
            return readFacet(facetNode, name, polarAngle, stepAngle, designStub);
        });

        if (indices.length === 0) {
            throw new Error("malformed .gcs: tier \"" + name + "\" has no <facet> elements");
        }

        return {
            isPreform: false, // .gcs marks no tier as a preform stage; nothing reads this for a .gcs
            number: 0,
            // POLAR to MAST: see the file header comment. The same conversion the page's
            // own selfCheckTierIdsAgainstHexCutV2Gcs applies before classifying a tier.
            angle: globalThis.GemCadDesign.mastAngleOf(polarAngle),
            distance: numberAttribute(tierNode, "depth"),
            cuttingInstructions: tierNode.attributes.instructions || "",
            indices: indices,
        };
    }

    /** `<info>`'s three attributes, each "" (not undefined) when the file omits it, so a
     * caller can always destructure the result without a further null check. */
    function readInfo(root) {
        var infoNodes = childrenNamed(root, "info");
        var info = infoNodes.length > 0 ? infoNodes[0].attributes : {};

        return {
            title: info.title || "",
            author: info.author || "",
            date: info.date || "",
        };
    }

    /**
     * Parses `.gcs` file text into `{parsed, info}` -- see the file header comment for
     * what each half is and why. Throws on anything malformed; the caller (the page's
     * `objTextFromBytes`) is expected to let a design-shaping failure fall back to a null
     * design rather than refuse to load the stone, the same rule T-0153 established for
     * `.asc`/`.gem` (kb/the-polar-internal-representation.md). A structurally broken file
     * (no `<index>`, no tiers, a facet with under three corners) is different: nothing
     * downstream could render it either, so it throws all the way out.
     *
     * Requires `globalThis.GemCadDesign` (design.js) to already be loaded, for
     * `mastAngleOf`, `polarOf` and `tolerances.indexSnap`. `make_page.py` concatenates
     * gemcad.js, gemcad_obj.js, design.js and this file in that order and runs them
     * together before anything calls `importText`, so this is a load-order requirement on
     * the bundle, not a circular dependency: this module calls into design.js at
     * `importText` time, never at load time, and design.js itself calls nothing here.
     */
    function importText(text) {
        var document = parseXml(text);
        var roots = childrenNamed(document, "GemCutStudio");

        if (roots.length !== 1) {
            throw new Error(
                "not a Gem Cut Studio .gcs file: expected one <GemCutStudio> element, found " +
                roots.length
            );
        }

        var root = roots[0];
        var indexNodes = childrenNamed(root, "index");

        if (indexNodes.length !== 1) {
            throw new Error(
                "malformed .gcs: expected one <index> element, found " + indexNodes.length
            );
        }

        var indexNode = indexNodes[0];
        var gear = numberAttribute(indexNode, "gear");
        var base = indexNode.attributes.base !== undefined ? Number(indexNode.attributes.base) : 0;
        var symmetryFolds = indexNode.attributes.symmetry !== undefined
            ? Number(indexNode.attributes.symmetry)
            : 1;
        var symmetryMirror = indexNode.attributes.mirror !== undefined &&
            Number(indexNode.attributes.mirror) !== 0;

        // Only used to cross-check each facet's index_angle (readFacet, readTier) before
        // GemCadDesign.fromGemCad builds the real design from the metadata below; kept
        // deliberately minimal (just what GemCadDesign.polarOf reads) rather than a full
        // design object, so it cannot be mistaken for one.
        var designStub = {
            gear: { teeth: Math.abs(gear), reversed: gear < 0, originIndex: base },
        };

        var tierNodes = childrenNamed(root, "tier");

        if (tierNodes.length === 0) {
            throw new Error("malformed .gcs: no <tier> elements");
        }

        var tiers = tierNodes.map(function (tierNode) {
            return readTier(tierNode, designStub);
        });

        var parsed = {
            metadata: {
                gear: gear,
                gearLocationAngle: base,
                // Deliberately NOT read from <render refractive_index="...">: see the file
                // header comment. Left at gemcad.js's own GemCadFileMetadata default.
                refractiveIndex: 0,
                symmetryFolds: symmetryFolds,
                symmetryMirror: symmetryMirror,
                headers: [],
                footnotes: [],
            },
            tiers: tiers,
        };

        return { parsed: parsed, info: readInfo(root) };
    }

    globalThis.GemCutStudio = {
        importText: importText,
        // Exposed for the deno oracle test (www/js/tests/gcs_test.js), which needs each
        // tier's own `name` attribute to compare against the page's GENERATED tier ids --
        // `name` is not part of the GemCadFileData shape `importText` returns, because
        // nothing in the render/design path reads a tier's file-authored name (T-0152).
        parseXml: parseXml,
        childrenNamed: childrenNamed,
    };
}());
