#version 300 es

// Gemstone ray tracer: the deterministic renderer.
//
// A Whitted-style, specular-only ray tracer, not a path tracer. It makes no random choices:
// at every surface it keeps both Fresnel branches (the transmitted part is weighted and
// gathered straight away, the reflected part carries on) instead of sampling one, so the
// image is finished in a single draw with no noise. The Monte Carlo path tracer is the
// LuxCore port in lux/.
//
// One ray per pixel per frame enters the stone, then bounces inside it until it refracts out
// or runs out of energy. Everything that makes a gem look like a gem comes from that
// interior march:
//
//   * Total internal reflection. Past the critical angle a facet becomes a perfect
//     mirror from the inside. Light entering the crown is trapped, bounces off the
//     pavilion, and returns to the eye. That return is "brilliance", and it is the
//     entire reason a gem is cut with a pointed pavilion instead of a flat back.
//   * Dispersion. The refractive index varies with wavelength, so each colour takes
//     a slightly different path and exits in a slightly different direction. That
//     splitting is "fire", the coloured flashes.
//   * Fresnel. At every surface some light reflects and some transmits, in a ratio
//     that depends on angle. Tracking both is what produces the layered, glassy
//     depth; a single refraction looks like a plastic bead.
//
// The geometry is read from float textures rather than vertex buffers, and the BVH is
// walked with skip pointers so no stack is required (GLSL ES 3.00 has neither
// recursion nor dynamic allocation). See src/accel.rs for the packing.
//
// The intersection routines here mirror `intersect_triangle` and `intersect_aabb` in
// src/accel.rs line for line, and the environment lookup mirrors
// `direction_to_equirect_uv` in src/env_map.rs. Those Rust versions are unit tested
// against brute force, so keep the two in step when editing either.
//
// ---------------------------------------------------------------------------------
// THIS FILE IS NO LONGER A COMPLETE SHADER ON ITS OWN (T-0120).
//
// `src/lib.rs` concatenates it with the ported LuxCore shader files into one
// translation unit, in this exact order:
//
//     gem.frag
//     lux/prelude.glsl  lux/host.glsl  lux/math.glsl  lux/glass.glsl
//     lux/sampler.glsl  lux/pathtracer.glsl  lux/lights.glsl  lux/entry.glsl
//
// `lux/entry.glsl` owns `main()` and dispatches on the `uRenderer` uniform: 0 runs this
// file's `renderHandWritten()` (the deterministic renderer; what `main()` used to be), 1
// runs the ported LuxCore path integrator. The order is deliberately not
// order-independent; a wrong order gives a loud duplicate-definition error (see
// lux/glass.glsl's COMPILE-ONLY STUBS block).
//
// gem.frag stays first so its `#version` directive is first in the unit and so its
// `traceScene()` is already defined when lux/pathtracer.glsl's `Scene_Intersect()`
// calls it. The `LUX_HAS_GEM_FRAG` define below is what tells that file so.
//
// To compile-check the whole unit by hand (one line; --no-header because this file
// already carries the #version directive, which is only legal as the first token):
//
//     tools/glsl_check.sh --no-header --no-prelude --no-stub src/shaders/gem.frag
//     src/shaders/lux/{prelude,host,math,glass,volume,sampler,pathtracer,lights,entry}.glsl
//
// `shader_source_files_are_concatenated_in_the_documented_order` in src/lib.rs pins the
// order against this comment, so the two cannot drift.
// ---------------------------------------------------------------------------------

precision highp float;
// Covers `uint` as well as `int`, which the ported Tausworthe RNG in lux/sampler.glsl
// depends on: GLSL ES 3.00 only guarantees `highp int` the full 32 bits, and that
// generator's whole correctness rests on exact mod-2^32 wraparound.
precision highp int;
precision highp sampler2D;

// Marks "gem.frag has been concatenated ahead of the lux/*.glsl files", which is what
// lux/pathtracer.glsl tests to decide between its standalone Scene_Intersect stub and the
// real implementation that calls traceScene() below. Defined here rather than passed in
// from the host so the two halves cannot be assembled in the wrong order silently.
#define LUX_HAS_GEM_FRAG 1

in vec2 vNdc;
out vec4 fragColor;

// ---------------------------------------------------------------- camera
uniform vec3 uCameraOrigin;
uniform vec3 uCameraRight;
uniform vec3 uCameraUp;
uniform vec3 uCameraForward;
uniform float uTanHalfFov;
uniform float uAspect;
// Half the view height in world units when orthographic, or 0.0 for perspective.
// The sign alone selects the projection, so no separate flag uniform is needed.
uniform float uOrthographicHalfHeight;
// Backing-store size in pixels. Read here by the facet wireframe, whose line width is in
// pixels, and by lux/entry.glsl to turn sub-pixel samples into NDC.
uniform vec2 uResolution;

// ---------------------------------------------------------------- geometry
// Three texels per triangle: (a.xyz, facetId), (b.xyz, facet-edge mask), (c.xyz, unused).
uniform highp sampler2D uTriangles;
// Two texels per BVH node: (min.xyz, link), (max.xyz, exitIndex).
// A negative link marks a leaf and encodes -(shapeIndex + 1).
uniform highp sampler2D uNodes;
uniform int uNodeCount;

// ---------------------------------------------------------------- environment
uniform sampler2D uEnvironment;
uniform float uEnvIntensity;
uniform float uEnvRotation;

// Which lighting model is loaded: 0 studio, 1 angle rings, 2 isometric, 3 cosine, 4 image. The
// three analytical models are evaluated exactly rather than read from uEnvironment; see
// analyticalRadiance().
uniform int uLightingModel;

// Cosine of the head-shadow half angle, or a value above 1.0 when disabled.
//
// Passed as a cosine rather than an angle so the per-lookup test is a dot product
// compare instead of an acos; sampleEnvironment runs thousands of times per pixel.
// Disabled is encoded as 2.0, which no unit dot product can reach, so the branch is
// simply never taken and needs no separate flag uniform.
uniform float uHeadShadowCosine;
uniform vec3 uHeadShadowColor;

// Radius, in world units, of the observer: a small opaque body on the view axis that blocks
// light leaving the stone back towards the viewer from near that axis. 0.0 disables it. See
// blockedByObserver().
uniform float uObserverRadius;

// Flat backdrop for rays that miss the stone, when uUseBackgroundColor is non-zero.
uniform int uUseBackgroundColor;
uniform vec3 uBackgroundColor;

// Colour for light arriving from behind the stone, when uUseWindowColor is non-zero. See
// arrivingLight().
uniform int uUseWindowColor;
uniform vec3 uWindowColor;

// Non-zero when the lighting is fixed to the viewer rather than to the world. See
// toLightingFrame().
uniform int uLightingFollowsView;

// 0 = filmic (Reinhard plus gamma), 1 = linear clamp, 2 = clamp plus gamma. See tonemap().
uniform int uToneMapMode;

// ---------------------------------------------------------------- material
// Refractive index for the red, green and blue samples. Blue is largest, because
// shorter wavelengths bend more.
uniform vec3 uSpectralIor;
// Beer-Lambert absorption coefficient per channel, in inverse world units.
uniform vec3 uAbsorption;
uniform int uMaxBounces;
// Display shade of the stone colour given to light still inside when uMaxBounces runs out;
// 0.0 truncates to black. See traceInterior().
uniform float uExhaustionShade;
uniform int uSpectralSamples;
uniform float uExposure;
uniform int uDebugMode;
// Non-zero to outline the visible facets. See wireframeCoverage().
uniform int uWireframe;
// One texel per facet id: red channel 1.0 for a facet to tint as selected, 0.0 for not (T-0160,
// replacing a single scalar facet id -- a click now selects a whole design tier, which can have
// more facets than any sensible fixed-size uniform array, so this is sized to the model's own
// facet count instead). Read where `selected` is computed below, and see
// GemApp::upload_highlight_texture.
uniform highp sampler2D uHighlightTexture;

// The cutting assistant's dop (T-0234): the bronze rod the rough is glued to, a cylinder from the
// glued end's centre (uDopStart.xyz) to the far end's (uDopEnd.xyz), of radius uDopStart.w, in
// world units. A radius of 0 means there is no dop, which is every frame outside that mode.
// uDopEnd.w is 1 when the glued end is drawn as a flat cap and 0 when it is not, because it lies
// inside the stone (the crown phase, T-0239). See dopDistance().
uniform vec4 uDopStart;
uniform vec4 uDopEnd;

// ---------------------------------------------------------------- constants

// Compile-time loop bound. Must match `params::MAX_BOUNCES` on the Rust side, which
// clamps the uniform so the two can never disagree.
const int MAX_BOUNCE_LIMIT = 32;

// How far to push a ray off a surface before continuing. Large enough that float
// error cannot leave the origin on the wrong side (which would immediately re-hit
// the facet just left), small enough not to skip a genuinely thin girdle.
const float SURFACE_EPSILON = 1e-4;

// Smallest hit distance the interior march accepts (`tMin` in its traceScene call).
//
// It is **not** a self-hit guard. The side rule in hitTriangle() is what stops the march from
// re-hitting the facet it just left, and it rejects that facet before the distance test runs.
// After `direction = reflect(direction, outwardNormal)` the new direction satisfies
// dot(direction, outwardNormal) <= 0, so for that facet -- and for every other triangle lying in
// its plane -- the determinant is -dot(direction, (b - a) x (c - a)) >= 0, which makes
// `determinant * RAY_FROM_INSIDE <= 0` and fails the `< 1e-8` test. The entry facet is rejected
// the same way after refraction, since the refracted ray also points into the solid. Measured
// (T-0082): 482M interior segments from full marches of both stones at seven poses, plus 7.6M
// synthetic bounces landing within 1e-5 to 1e-2 of a facet edge at incidences down to 1e-7 of
// grazing -- including all 416k of those where the normal had to be flipped -- traced with a
// tMin of exactly 0. Not one trace came back on the plane it had just left.
//
// So this bound only has to stay above the noise floor of the distance itself. That distance is
// a ratio of dot products of unit-size operands, carrying an absolute f32 error of order 1e-7,
// so anything reported below that is not distinguishable from zero. 1e-6 is an order of
// magnitude above the noise and a hundredth of SURFACE_EPSILON, so it cannot reject an exit that
// the geometric nudge has separated from the surface. The float64 reference tracer uses 1e-6 for
// the same job (tools/reference_tracer/trace.py, SELF_HIT_EPSILON).
//
// It was SURFACE_EPSILON until T-0082, which made it a dead zone rather than a guard: a genuine
// exit nearer than 1e-4 was reported as a miss, and traceInterior discards a path's whole
// remaining throughput on a miss, which is a dark pixel. Exits do get that close. A bounce
// landing within about SURFACE_EPSILON of a facet edge leaves the origin barely inside the
// neighbouring facet, so the next segment is short: the shortest measured in a camera march is
// 6.8e-5, and near-edge synthetic bounces reach 1e-8.
const float INTERIOR_T_MIN = 1e-6;

// Below this the remaining light cannot affect the final pixel, so the march stops.
const float THROUGHPUT_CUTOFF = 1e-4;

const float FAR_DISTANCE = 1e9;
const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;

// Display transfer modes. Must match `params::ToneMapMode`.
const int TONEMAP_FILMIC = 0;
const int TONEMAP_LINEAR = 1;
const int TONEMAP_GAMMA = 2;

// Exponent relating display values to linear radiance. Image environments are decoded
// with it on the Rust side, and encoded with its inverse here. Must match
// env_map::DISPLAY_GAMMA; a test enforces that.
const float DISPLAY_GAMMA = 2.2;

// Largest filmic-compressed value displayToRadiance() inverts; Reinhard's inverse diverges
// at 1.0. Must match params::FILMIC_DECODE_CEILING; a test enforces that.
const float FILMIC_DECODE_CEILING = 0.999;

// Lighting model numbering. Must match params::LightingModel::as_u32; a test enforces that.
const int LIGHTING_ANGLE_RINGS = 1;
const int LIGHTING_ISOMETRIC = 2;
const int LIGHTING_COSINE = 3;

// The analytical models' definitions. Must match env_map::ANGLE_RING_RADII_TEXELS,
// env_map::ANGLE_RING_LOOKUP_RADIUS_TEXELS, env_map::ANGLE_RING_LOOKUP_OFFSET_TEXELS,
// env_map::ANGLE_RING_BLEND_TEXELS, env_map::ANGLE_RING_COLORS and env_map::RING_LEVEL; a test
// enforces that.
//
// Angle Rings is Gem Cut Studio's own lookup into its own 256 x 256 lighting map, in closed form:
// ring boundaries at 35 / 64 / 96 texels, read orthographically at a radius scale of 127 rather
// than 128, half a texel off centre on each axis, with each boundary blended over two texels
// (T-0056, the user's choice, 2026-09-18; measured and verified in T-0030). It is not the
// manual's 15 / 30 / 50 degrees, and since T-0056 it is not the hard tilt edges of T-0033 either.
// See env_map's constants for what each number means and how it was checked.
const vec3 ANGLE_RING_RADII_TEXELS = vec3(35.0, 64.0, 96.0);
const float ANGLE_RING_LOOKUP_RADIUS_TEXELS = 127.0;
const vec2 ANGLE_RING_LOOKUP_OFFSET_TEXELS = vec2(-0.5, 0.5);
const float ANGLE_RING_BLEND_TEXELS = 2.0;
const vec3 RING_RED = vec3(1.0, 0.0, 0.0);
const vec3 RING_CYAN = vec3(0.0, 1.0, 1.0);
const vec3 RING_YELLOW = vec3(1.0, 1.0, 0.0);
const vec3 RING_MAGENTA = vec3(1.0, 0.0, 1.0);
const float RING_LEVEL = 1.0;

const int DEBUG_FULL = 0;
const int DEBUG_NORMALS = 1;
const int DEBUG_FACET_ID = 2;
const int DEBUG_TRAVERSAL_COST = 3;
const int DEBUG_BOUNCE_COUNT = 4;

// ---------------------------------------------------------------- data access

// Width of the geometry data textures. A compile-time power-of-two constant rather
// than a uniform, which matters a great deal for performance.
//
// This function is the hottest code in the renderer: a single pixel runs it a few
// thousand times (roughly 49 ray casts, each visiting tens of nodes, two texels per
// node). Unwrapping a linear index needs a division and a modulo, and GPUs have no
// native integer division. With the width as a uniform the compiler cannot strength
// reduce them, so it emits the full sequence every time; as a constant power of two
// it becomes one bitwise AND and one shift.
//
// Must equal DATA_TEXTURE_WIDTH in src/accel.rs; a test enforces that.
const int DATA_TEXTURE_WIDTH_MASK = 1023;
const int DATA_TEXTURE_WIDTH_SHIFT = 10;

vec4 fetchTexel(highp sampler2D source, int index) {
    return texelFetch(
        source,
        ivec2(index & DATA_TEXTURE_WIDTH_MASK, index >> DATA_TEXTURE_WIDTH_SHIFT),
        0
    );
}

float maxComponent(vec3 value) {
    return max(max(value.x, value.y), value.z);
}

struct Triangle {
    vec3 a;
    vec3 b;
    vec3 c;
    float facet;
};

Triangle fetchTriangle(int index) {
    int base = index * 3;

    vec4 first = fetchTexel(uTriangles, base);
    vec4 second = fetchTexel(uTriangles, base + 1);
    vec4 third = fetchTexel(uTriangles, base + 2);

    Triangle triangle;

    triangle.a = first.xyz;
    triangle.facet = first.w;
    triangle.b = second.xyz;
    triangle.c = third.xyz;

    return triangle;
}

// ---------------------------------------------------------------- intersection

struct Hit {
    float t;
    // Outward normal of the facet, independent of which side the ray arrived from.
    vec3 outwardNormal;
    float facet;
    int nodesVisited;
    // Index of the hit triangle in the triangle texture, or -1 on a miss.
    int triangle;
};

// How far outside a triangle, in barycentric units, a ray may pass and still hit it. A ray
// through an edge or vertex shared by several triangles can round to just outside every one of
// them, and with exact bounds it escapes through a crack (8.9% of rays aimed at the hex cut's
// edges and vertices did). The rounding grows for grazing rays and sliver triangles; the value
// was measured on both shipped stones (worst need 1.27e-4, on an exporter's sliver), see
// accel::TRIANGLE_EDGE_TOLERANCE. Must match that constant; a test enforces that.
const float TRIANGLE_EDGE_TOLERANCE = 5e-4;

// Which side of the stone's surface a ray starts on: the `side` argument of hitTriangle() and
// traceScene(). A ray from outside can only enter the stone, and a ray inside it can only leave.
// Must match accel::RaySide::sign; a test enforces that.
const float RAY_FROM_OUTSIDE = 1.0;
const float RAY_FROM_INSIDE = -1.0;

// Mirrors accel::intersect_triangle.
//
// A triangle is hit only when the ray crosses it the way `side` allows: inwards, against its
// outward normal, for RAY_FROM_OUTSIDE, and outwards for RAY_FROM_INSIDE. A closed surface is
// crossed alternately inwards and outwards, so a ray's first hit is always a crossing its side
// allows, on a concave stone as on a convex one. Every internal bounce meets a facet from behind,
// which is why that crossing must stay accepted for rays inside the stone.
//
// Accepting both crossings let float error become a false exit (T-0032). A primary hit computed
// slightly outside the surface started the interior march outside the stone. The march then met the
// entry facet again from outside and took it for an exit through a facet facing into the stone,
// which the back-facet leak rule showed as the window colour, in thin lines along facet edges.
bool hitTriangle(vec3 origin, vec3 direction, Triangle triangle,
                 float tMin, float tMax, float side, out float distanceOut) {
    vec3 edgeAB = triangle.b - triangle.a;
    vec3 edgeAC = triangle.c - triangle.a;

    vec3 perpendicular = cross(direction, edgeAC);
    float determinant = dot(edgeAB, perpendicular);

    // The determinant is -dot(direction, (b - a) x (c - a)), and (b - a) x (c - a) is the outward
    // normal of an outward-wound triangle. So it is positive when the ray crosses inwards and
    // negative when it crosses outwards, and times `side` it is positive exactly when this ray can
    // make the crossing.
    //
    // Near zero means the ray runs parallel to the triangle's plane. The threshold is 1e-8 rather
    // than something tighter because GLSL ES 3.00 only guarantees `highp float` a relative
    // precision of 2^-16, so a much smaller bound would sit inside the noise floor on a minimally
    // conformant implementation and let a near-parallel ray through with a garbage distance. A
    // genuine non-parallel hit on a model normalised to unit radius produces a determinant many
    // orders of magnitude larger than this, so nothing real is rejected. Kept identical in
    // accel::intersect_triangle.
    if (determinant * side < 1e-8) {
        return false;
    }

    float inverseDeterminant = 1.0 / determinant;
    vec3 aToOrigin = origin - triangle.a;

    float u = dot(aToOrigin, perpendicular) * inverseDeterminant;

    if (u < -TRIANGLE_EDGE_TOLERANCE || u > 1.0 + TRIANGLE_EDGE_TOLERANCE) {
        return false;
    }

    vec3 q = cross(aToOrigin, edgeAB);
    float v = dot(direction, q) * inverseDeterminant;

    if (v < -TRIANGLE_EDGE_TOLERANCE || u + v > 1.0 + TRIANGLE_EDGE_TOLERANCE) {
        return false;
    }

    float hitDistance = dot(edgeAC, q) * inverseDeterminant;

    if (hitDistance <= tMin || hitDistance >= tMax) {
        return false;
    }

    distanceOut = hitDistance;

    return true;
}

// Mirrors accel::intersect_aabb. Slab test using a precomputed reciprocal direction.
//
// A zero direction component yields an infinite reciprocal, which is fine: the Rust
// packer pads every node bound outward so no slab is ever exactly zero thickness,
// which is what would turn this into 0 * infinity == NaN and silently miss.
bool hitAabb(vec3 origin, vec3 inverseDirection, vec3 low, vec3 high,
             float tMin, float tMax) {
    vec3 first = (low - origin) * inverseDirection;
    vec3 second = (high - origin) * inverseDirection;

    vec3 near = min(first, second);
    vec3 far = max(first, second);

    float enter = max(max(near.x, near.y), max(near.z, tMin));
    float exitAt = min(min(far.x, far.y), min(far.z, tMax));

    return enter <= exitAt;
}

// Nearest hit against the whole stone, among the triangles the ray crosses the way `side`
// allows: RAY_FROM_OUTSIDE or RAY_FROM_INSIDE, see hitTriangle().
//
// Walks the flattened BVH with skip pointers: on a hit descend to `link`, on a miss
// jump to `exitIndex`, which skips the entire subtree. The loop ends when the index
// runs past the last node. No stack, no recursion, no depth limit.
bool traceScene(vec3 origin, vec3 direction, float tMin, float tMax, float side, out Hit hit) {
    vec3 inverseDirection = 1.0 / direction;

    // Fully initialised up front: an out parameter left unwritten is undefined, and
    // the caller reads `nodesVisited` even on a miss.
    hit.t = tMax;
    hit.outwardNormal = vec3(0.0, 1.0, 0.0);
    hit.facet = 0.0;
    hit.nodesVisited = 0;
    hit.triangle = -1;

    bool found = false;
    float best = tMax;
    int index = 0;

    // Hard iteration cap, purely defensive.
    //
    // With data the packer produced, `index` increases strictly on every step (both
    // link fields point forward in depth-first order) so this loop always ends on
    // its own. The cap exists because the consequence of it *not* ending is out of
    // all proportion to the cost of the guard: WebGL cannot interrupt a fragment
    // shader, so an infinite loop is a driver reset, a lost context and a hung tab
    // rather than a visibly wrong frame. A zeroed node texture with a non-zero node
    // count would be enough to do it, since node 0 would then decode as an inner
    // node whose exit index is also 0.
    //
    // A correct hierarchy visits far fewer nodes than this bound, so it can never
    // truncate a legitimate traversal.
    for (int step = 0; step < 4 * uNodeCount; ++step) {
        if (index >= uNodeCount) {
            break;
        }

        hit.nodesVisited += 1;

        vec4 nodeLow = fetchTexel(uNodes, index * 2);
        vec4 nodeHigh = fetchTexel(uNodes, index * 2 + 1);

        float link = nodeLow.w;
        int exitIndex = int(nodeHigh.w);

        if (link < 0.0) {
            // Leaf. Decode -(shapeIndex + 1) back to the triangle index.
            int shapeIndex = int(-link) - 1;
            Triangle triangle = fetchTriangle(shapeIndex);

            float hitDistance;

            if (hitTriangle(origin, direction, triangle, tMin, best, side, hitDistance)) {
                best = hitDistance;
                found = true;

                hit.t = hitDistance;
                hit.facet = triangle.facet;
                hit.triangle = shapeIndex;
                // Derived from the winding rather than stored, which guarantees it
                // agrees with the geometry. The mesh conditioner has already forced
                // outward winding.
                hit.outwardNormal = normalize(
                    cross(triangle.b - triangle.a, triangle.c - triangle.a)
                );
            }

            index = exitIndex;
        } else if (hitAabb(origin, inverseDirection, nodeLow.xyz, nodeHigh.xyz, tMin, best)) {
            index = int(link);
        } else {
            index = exitIndex;
        }
    }

    return found;
}

// ---------------------------------------------------------------- environment

// The radiance that tonemap() displays as `display`. Mirrors params::ToneMapMode::decode,
// whose round trip against tonemap is tested on the host.
//
// For colours picked in the page that still have to mix with real light: the head shadow
// and window colours. Decoding them first means a fully lit region shows the picked colour
// under every transfer, instead of the filmic curve dimming white to 73% grey.
vec3 displayToRadiance(vec3 display) {
    vec3 value = clamp(display, 0.0, 1.0);

    if (uToneMapMode == TONEMAP_LINEAR) {
        return value / uExposure;
    }

    // The gamma and filmic transfers both end in the same gamma encode.
    value = pow(value, vec3(DISPLAY_GAMMA));

    if (uToneMapMode == TONEMAP_GAMMA) {
        return value / uExposure;
    }

    value = min(value, vec3(FILMIC_DECODE_CEILING));

    return value / (1.0 - value) / uExposure;
}

// Expresses a world direction in the lighting frame, whose +Y is the lighting's zenith.
// Mirrors camera::CameraBasis::to_lighting_frame.
//
// With the lighting fixed to the viewer, as in Gem Cut Studio, the zenith is the direction
// back towards the viewer (-forward), +X is screen right and +Z is screen down. Rotating the
// view then behaves like GCS rotating the stone under fixed lights. At the default top-down
// pose this is exactly the identity, so the front view is the same in both
// modes. With the lighting fixed to the world, directions are used as they are.
vec3 toLightingFrame(vec3 worldDirection) {
    if (uLightingFollowsView == 0) {
        return worldDirection;
    }

    return vec3(
        dot(worldDirection, uCameraRight),
        -dot(worldDirection, uCameraForward),
        -dot(worldDirection, uCameraUp)
    );
}

// Radiance of the loaded analytical lighting model along a lighting-frame direction, before
// uEnvIntensity. Mirrors env_map::angle_rings_radiance, isometric_radiance and cosine_radiance.
//
// These models were once read from the 1024 x 512 environment texture like the others. Its
// bilinear filtering blends neighbouring rows, so within about 0.18 degrees of every band edge
// (half a 0.35-degree row) light took a mixture of two bands, where the specification's edges are
// hard. An independent float64 reference tracer found that every flat region where it disagreed
// with the GPU render had light leaving within 0.21 degrees of an edge (T-0023). Evaluating the
// definitions directly removes the smear.
//
// Isometric and Cosine depend only on the tilt. Angle Rings has not since T-0056: its lookup is
// half a texel off centre, so it varies with azimuth too, by up to 0.71 texels of radius. The
// environment rotation still does not apply to any of them, because all three are evaluated here
// in the lighting frame rather than sampled from the rotated texture. Note the frame's +X is
// screen right and +Z is screen down, which is the frame the half-texel offset was measured in.
vec3 analyticalRadiance(vec3 direction) {
    float height = clamp(direction.y, -1.0, 1.0);

    // No light from below the horizon, in all three models.
    if (height < 0.0) {
        return vec3(0.0);
    }

    if (uLightingModel == LIGHTING_ISOMETRIC) {
        return vec3(RING_LEVEL);
    }

    // Despite its name, Gem Cut Studio's Cosine falls off as 1 - sin(tilt): full brightness at
    // the zenith, 0.5 at 30 degrees, black at the horizon. That is a linear ramp in radius across
    // an orthographic sphere map. Fitted from GCS's screenshots (T-0004); a true cosine rendered
    // about 70 levels too bright. Mirrors env_map::cosine_radiance.
    if (uLightingModel == LIGHTING_COSINE) {
        return vec3(RING_LEVEL * (1.0 - sqrt(max(1.0 - height * height, 0.0))));
    }

    // Angle Rings, through Gem Cut Studio's own lookup. Mirrors env_map::angle_rings_radiance.
    //
    // The lookup is orthographic, so a unit direction's horizontal part is already sin(tilt) and
    // needs no trigonometry: scale it into texels and shift it by the half-texel offset, and the
    // result is the radius GCS reads its map at. The horizon needs no test of its own, the
    // height check above having already returned.
    vec2 lookup = ANGLE_RING_LOOKUP_RADIUS_TEXELS * vec2(direction.x, direction.z)
                + ANGLE_RING_LOOKUP_OFFSET_TEXELS;
    float texelRadius = length(lookup);

    // Start at red and cross each boundary in turn. With hard boundaries this is exactly a band
    // lookup; with soft ones it blends, and it branches either way. The boundaries are 29 texels
    // apart at the closest and the blend window is 2, so no radius is ever inside two at once.
    float halfWindow = ANGLE_RING_BLEND_TEXELS * 0.5;
    vec3 blend = clamp(
        (vec3(texelRadius) - (ANGLE_RING_RADII_TEXELS - vec3(halfWindow)))
            / ANGLE_RING_BLEND_TEXELS,
        0.0,
        1.0
    );

    vec3 rings = RING_RED
               + (RING_CYAN - RING_RED) * blend.x
               + (RING_YELLOW - RING_CYAN) * blend.y
               + (RING_MAGENTA - RING_YELLOW) * blend.z;

    return rings * RING_LEVEL;
}

// The lighting's radiance along a lighting-frame direction, before the head shadow: the
// analytical models exactly, and the texture (studio rig or skybox) otherwise, times
// uEnvIntensity. Mirrors env_map::direction_to_equirect_uv, plus a rotation about the vertical
// axis so the rig can be spun without regenerating the texture.
//
// Split out of sampleEnvironment (T-0234) for the dop, which is lit by the environment but is
// not the stone the head shadow is about: the observer's head shades light arriving at the
// stone from behind the viewer, and a rod held under the stone does not see that head.
vec3 environmentRadiance(vec3 direction) {
    // The analytical models are computed exactly; see analyticalRadiance().
    if (uLightingModel >= LIGHTING_ANGLE_RINGS && uLightingModel <= LIGHTING_COSINE) {
        return analyticalRadiance(direction) * uEnvIntensity;
    }

    float cosine = cos(uEnvRotation);
    float sine = sin(uEnvRotation);

    vec3 rotated = vec3(
        cosine * direction.x + sine * direction.z,
        direction.y,
        -sine * direction.x + cosine * direction.z
    );

    float u = atan(rotated.z, rotated.x) / TAU + 0.5;
    float v = acos(clamp(rotated.y, -1.0, 1.0)) / PI;

    return texture(uEnvironment, vec2(u, v)).rgb * uEnvIntensity;
}

// The lighting along a lighting-frame direction, as the stone sees it: environmentRadiance()
// with the head shadow applied.
//
// `direction` is in the lighting frame; see toLightingFrame().
vec3 sampleEnvironment(vec3 direction) {
    // Head shadow, applied here as a post-process on the lookup rather than baked into
    // the texture. Two reasons: the half angle can then be changed without regenerating
    // and re-uploading the map, and it keeps the environment definition independent of
    // the observer, which is how the environments are specified.
    //
    // The cone is about the lighting zenith. With the lighting following the view (the
    // default, as in Gem Cut Studio), that is the viewer's own axis, which is where a real
    // observer's head is. With the lighting fixed to the world, it is world +Y, which
    // matches the viewer only when looking straight down the optical axis.
    //
    // The colour is a picked display colour, as in Gem Cut Studio, so it is decoded rather
    // than scaled by the environment intensity: a shadowed facet shows the colour chosen,
    // whatever the lighting. Black, the default, is no light under every transfer.
    if (direction.y >= uHeadShadowCosine) {
        return displayToRadiance(uHeadShadowColor);
    }

    return environmentRadiance(direction);
}

// ---------------------------------------------------------------- the dop (T-0234)
//
// The cutting assistant walks a cutter through the design from a rough cube, "at the bottom of the
// cube, our dop (a medium sized rod rendered in bronze) sticks out" (the user, 2026-09-23). It is
// drawn here as an analytic capped cylinder rather than as triangles in the stone's mesh: the mesh
// is what every renderer refracts through, and a rod in it would be traced as glass. The
// deterministic and flat renderers draw it for the primary ray only (renderHandWritten,
// renderFlat, through dopInFront): dopDistance() says where the rod is, and dopRadiance() shades
// it where it is the nearest thing.
//
// It is NOT seen through the stone or in its facets (2026-09-24, the user: "showing the bronze
// through the crown is good but not necessary - if its faster if we remove the bronze or if theres
// any benefit at all to not showing it just make it not visible"). Testing the rod in arrivingLight
// cost a cylinder test on every ray leaving the stone, inside the deterministic renderer's bounce
// march, which the compiler unrolls, so it was paid in compile time too (T-0218). Light leaving
// the stone towards the rod picks up the lighting as if the rod were not there.
// The ported LuxCore (Monte Carlo) path does not draw it either (T-0239, the user: "get rid of the
// dop from monte carlo"): the cutting assistant switches that renderer to the deterministic one
// while it is open.
//
// Only camera rays test the rod. That is what lets the crown phase sink the rod's glued end into
// the pavilion with no cap (uDopEnd.w 0): the stone is convex, so a camera ray meets the stone's
// surface before any part of the rod inside it, and the buried end is never seen.
//
// The rod is opaque and is not path traced: it is lit by the lighting model directly (a diffuse
// term along its normal and a metal's Fresnel reflection along the mirror direction), which is
// all a prop needs. Kept small on purpose, with no loops: T-0218 is about how long this shader
// takes to compile on Windows.

// Bronze, the ticket's sRGB (176, 141, 87), as a display value.
const vec3 DOP_BRONZE = vec3(176.0, 141.0, 87.0) / 255.0;

// How the rod's light divides between the lighting along its normal (a rough, diffuse share) and
// the mirror reflection a polished metal gives, and the floor under the diffuse share so a side
// facing the dark half of a lighting model still reads as bronze rather than black.
const float DOP_DIFFUSE = 0.55;
const float DOP_SPECULAR = 0.6;
const float DOP_AMBIENT = 0.12;

// Where along the ray the dop's surface is first crossed, beyond tMin and before tMax, with the
// surface's outward normal there; FAR_DISTANCE when the ray misses it, or there is no dop.
//
// A capped cylinder is the round side, |p - axis| = radius between the two ends, plus the two flat
// ends. In the frame of the axis w, the side is a quadratic in t in the ray's components across
// the axis; each end is a plane, hit where it is crossed within the radius. The glued end is left
// open when uDopEnd.w is 0 (the crown phase, where it is buried in the pavilion; see above).
float dopDistance(vec3 origin, vec3 direction, float tMin, float tMax, out vec3 normal) {
    normal = vec3(0.0, 1.0, 0.0);

    float radius = uDopStart.w;

    if (radius <= 0.0) {
        return FAR_DISTANCE;
    }

    vec3 axis = uDopEnd.xyz - uDopStart.xyz;
    float len = length(axis);
    vec3 w = axis / len;
    vec3 offset = origin - uDopStart.xyz;
    float offsetAlong = dot(offset, w);
    float directionAlong = dot(direction, w);
    vec3 offsetAcross = offset - w * offsetAlong;
    vec3 directionAcross = direction - w * directionAlong;

    float best = tMax;

    // The round side. Both roots are tried, the nearer first, since a ray can meet the side
    // outside the rod's length first and inside it second.
    float a = dot(directionAcross, directionAcross);

    if (a > 1e-12) {
        float b = dot(offsetAcross, directionAcross);
        float c = dot(offsetAcross, offsetAcross) - radius * radius;
        float discriminant = b * b - a * c;

        if (discriminant >= 0.0) {
            float root = sqrt(discriminant);
            float near = (-b - root) / a;
            float far = (-b + root) / a;
            float nearAlong = offsetAlong + near * directionAlong;
            float farAlong = offsetAlong + far * directionAlong;

            if (near > tMin && near < best && nearAlong >= 0.0 && nearAlong <= len) {
                best = near;
                normal = normalize(offsetAcross + directionAcross * near);
            } else if (far > tMin && far < best && farAlong >= 0.0 && farAlong <= len) {
                best = far;
                normal = normalize(offsetAcross + directionAcross * far);
            }
        }
    }

    // The two flat ends: the glued one (along 0, facing -w), when it is drawn at all, and the far
    // one (along len, +w).
    if (abs(directionAlong) > 1e-12) {
        float glued = -offsetAlong / directionAlong;
        float distal = (len - offsetAlong) / directionAlong;

        if (uDopEnd.w > 0.5 && glued > tMin && glued < best
                && length(offsetAcross + directionAcross * glued) <= radius) {
            best = glued;
            normal = -w;
        }

        if (distal > tMin && distal < best
                && length(offsetAcross + directionAcross * distal) <= radius) {
            best = distal;
            normal = w;
        }
    }

    return best < tMax ? best : FAR_DISTANCE;
}

// The radiance leaving the dop's surface towards a ray travelling along `direction` that met it
// where its outward normal is `normal`: bronze lit by the lighting model, as a rough share along the
// normal plus a polished metal's reflection (Schlick's Fresnel, with the metal's own colour as its
// reflectance at normal incidence).
vec3 dopRadiance(vec3 direction, vec3 normal) {
    vec3 base = pow(DOP_BRONZE, vec3(DISPLAY_GAMMA));
    vec3 facing = dot(normal, direction) > 0.0 ? -normal : normal;
    float cosView = clamp(-dot(direction, facing), 0.0, 1.0);
    vec3 fresnel = base + (vec3(1.0) - base) * pow(1.0 - cosView, 5.0);
    vec3 diffuse = base * (vec3(DOP_AMBIENT) + environmentRadiance(toLightingFrame(facing)));
    vec3 mirror = environmentRadiance(toLightingFrame(reflect(direction, facing)));

    return DOP_DIFFUSE * diffuse + DOP_SPECULAR * fresnel * mirror;
}

// Largest sine of the angle between a ray and the view axis that still counts as heading
// exactly back along it, for blockedByObserver() with the orthographic camera. Float noise in a
// facet normal is around 1e-6; a stone tilted by 0.003 degrees turns its table reflections 1e-4
// away. Must match camera::OBSERVER_ALIGNMENT_TOLERANCE; a test enforces that.
const float OBSERVER_ALIGNMENT_TOLERANCE = 1e-4;

// Radius of the observer's body at a perspective eye, as a multiple of uObserverRadius, for
// blockedByObserver(). Must match camera::OBSERVER_EYE_RADIUS_SCALE; a test enforces that.
const float OBSERVER_EYE_RADIUS_SCALE = 2.0;

// Whether light leaving the stone at `position` along `direction` runs into the observer.
// Mirrors camera::CameraBasis::observer_blocks.
//
// The observer draws the small dark dot at the table centre of Gem Cut Studio's face-up renders,
// even with its head shadow at 0 degrees. Face-up the table reflects light back towards the
// viewer, and the reflections leaving within uObserverRadius of the view axis are blocked. The
// dot's edge measures 0.0268 of the girdle radius in both the Isometric and Cosine screenshots,
// and inside it each drops by exactly the table's reflection of the zenith light. See
// kb/observer-occlusion.md.
//
// Only light leaving within the radius of the view axis, the line through the eye along the view
// direction, can be blocked. Then:
//   * orthographic: the body is infinitely far along the axis, so the direction must be aligned
//     with the axis to within float noise;
//   * perspective, including Gem Cut Studio's default camera: the body sits at the eye,
//     OBSERVER_EYE_RADIUS_SCALE times the radius across, and the light's line must pass that
//     close to the eye. A table reflection leaving r from the axis crosses the eye's plane 2r
//     from it, so the dot keeps the same radius. The orthographic test would shrink it tenfold,
//     because perspective table reflections are up to 1e-3 off the axis.
// Either way the dot vanishes once the stone turns by a fraction of a degree, as in GCS: 0.003
// degrees orthographic, and 2 * radius / eye distance (0.058 degrees) with the default eye.
//
// Every test uses cross-product lengths, which stay accurate for tiny values, rather than
// subtracting nearly equal numbers.
bool blockedByObserver(vec3 position, vec3 direction) {
    if (uObserverRadius <= 0.0) {
        return false;
    }

    vec3 towardsViewer = -uCameraForward;

    if (length(cross(position - uCameraOrigin, towardsViewer)) >= uObserverRadius) {
        return false;
    }

    if (uOrthographicHalfHeight > 0.0) {
        return dot(direction, towardsViewer) > 0.0
            && length(cross(direction, towardsViewer)) <= OBSERVER_ALIGNMENT_TOLERANCE;
    }

    vec3 towardsEye = uCameraOrigin - position;

    return dot(direction, towardsEye) > 0.0
        && length(cross(towardsEye, direction)) < OBSERVER_EYE_RADIUS_SCALE * uObserverRadius;
}

// How far below the lighting horizon, as a sine, a facet's outward normal must point for light
// leaving through that facet to count as coming from behind the stone. Keeps a vertical girdle
// facet, whose normal is level to within float noise (about 1e-6), from speckling between the
// two rules. Must match camera::BACK_FACET_TOLERANCE; a test enforces that.
const float BACK_FACET_TOLERANCE = 1e-4;

// Light arriving along a world direction that leaves the stone at `position` through a facet
// with world `outwardNormal`: out through that facet after any number of internal reflections,
// or reflected off its outside. Mirrors camera::CameraBasis::light_comes_from_behind.
//
// Light that would reach the eye through the observer's own body is blocked and shows the head
// shadow colour; see blockedByObserver().
//
// Follows Gem Cut Studio. Its lighting models cover only the hemisphere facing the viewer, and
// light "coming from behind the stone" shows the separate window colour when that is enabled,
// or otherwise the flat background colour. This is a leak, or "window", at any bounce count, not
// only at the first surface. "Behind" is either of:
//
//   * the light arrives from below the lighting horizon: with the lighting following the view,
//     that is exactly away from the viewer;
//   * it leaves through a facet facing below that horizon, whatever its direction. Light can
//     leave a pavilion facet heading slightly upwards. It then counts as seen through the back of
//     the stone. The oval cut's face-up end windows are such exits, heading 11 degrees up. The
//     direction test alone lit them and matched 5% of GCS's window pixels; adding this matched 91%
//     (T-0026, from an independent reference tracer). A stone with pavilions steep enough to exit
//     only downwards, like the hex cut face-up, is almost unchanged.
//
// With neither colour enabled, the environment is sampled as usual, lower hemisphere included.
// Picked colours are decoded like the head shadow colour, so an obvious leak colour reads as
// itself, less the light the surfaces reflect away.
vec3 arrivingLight(vec3 position, vec3 worldDirection, vec3 outwardNormal) {
    if (blockedByObserver(position, worldDirection)) {
        return displayToRadiance(uHeadShadowColor);
    }

    vec3 direction = toLightingFrame(worldDirection);

    if (direction.y < 0.0 || toLightingFrame(outwardNormal).y < -BACK_FACET_TOLERANCE) {
        if (uUseWindowColor != 0) {
            return displayToRadiance(uWindowColor);
        }

        if (uUseBackgroundColor != 0) {
            return displayToRadiance(uBackgroundColor);
        }
    }

    return sampleEnvironment(direction);
}

// ---------------------------------------------------------------- optics

// Unpolarised Fresnel reflectance for a dielectric interface.
//
// `eta` is the ratio of refractive indices, from the medium the ray is in to the one
// it is entering. `cosIncident` is the cosine of the angle to the normal, always
// positive.
//
// Returns exactly 1.0 under total internal reflection. Using the full Fresnel
// equations rather than Schlick's approximation matters here: Schlick is fitted for
// air-to-denser interfaces and does not reproduce the sharp cutoff at the critical
// angle, which is the single most visually important feature of a gem.
float fresnelReflectance(float cosIncident, float eta) {
    float sinTransmittedSquared = eta * eta * (1.0 - cosIncident * cosIncident);

    // Beyond the critical angle there is no transmitted ray at all.
    if (sinTransmittedSquared >= 1.0) {
        return 1.0;
    }

    float cosTransmitted = sqrt(1.0 - sinTransmittedSquared);

    // Perpendicular and parallel polarisation, averaged for unpolarised light.
    float perpendicular =
        (eta * cosIncident - cosTransmitted) / (eta * cosIncident + cosTransmitted);
    float parallel =
        (cosIncident - eta * cosTransmitted) / (cosIncident + eta * cosTransmitted);

    return 0.5 * (perpendicular * perpendicular + parallel * parallel);
}

// Vector form of Snell's law.
//
// `incident` points at the surface, `normal` faces the side the ray came from (so
// dot(incident, normal) < 0), and `eta` is from-index over into-index. Returns false
// under total internal reflection.
//
// Written out rather than using GLSL's built-in `refract` because the built-in
// silently returns a zero vector on total internal reflection, and a zero direction
// is indistinguishable from a legitimate result until it produces NaNs several
// bounces later.
bool refractRay(vec3 incident, vec3 normal, float eta, out vec3 transmitted) {
    float cosIncident = -dot(incident, normal);
    float sinTransmittedSquared = eta * eta * (1.0 - cosIncident * cosIncident);

    if (sinTransmittedSquared >= 1.0) {
        return false;
    }

    float cosTransmitted = sqrt(1.0 - sinTransmittedSquared);

    transmitted = eta * incident + (eta * cosIncident - cosTransmitted) * normal;

    return true;
}

// Marches one wavelength band through the interior of the stone.
//
// `channelMask` selects which colour channels this pass contributes to: (1,1,1)
// traces all three together with a single refractive index (no dispersion), while a
// unit basis vector traces one channel with its own index (dispersion on).
//
// Returns the radiance gathered by light that entered here and left through some
// facet, having possibly reflected internally many times on the way.
vec3 traceInterior(vec3 entryPoint, vec3 viewDirection, vec3 entryNormal,
                   float refractiveIndex, vec3 channelMask, out int bounceCount) {
    bounceCount = 0;

    // Entering the stone: air to gem.
    float etaEntering = 1.0 / refractiveIndex;
    vec3 interiorDirection;

    if (!refractRay(viewDirection, entryNormal, etaEntering, interiorDirection)) {
        // Unreachable when entering a denser medium, but guarded so a nonsensical
        // refractive index cannot produce garbage.
        return vec3(0.0);
    }

    float cosEntry = -dot(viewDirection, entryNormal);
    float entryReflectance = fresnelReflectance(cosEntry, etaEntering);

    // Only the transmitted fraction enters. The reflected fraction is handled by the
    // caller as a surface highlight.
    vec3 throughput = channelMask * (1.0 - entryReflectance);
    vec3 gathered = vec3(0.0);

    // Start just inside the surface so the first trace cannot re-hit this facet.
    vec3 origin = entryPoint - entryNormal * SURFACE_EPSILON;
    vec3 direction = normalize(interiorDirection);

    // Whether the march ends because the bounce budget ran out while light remained, as
    // opposed to missing the stone or the light dying away. Only that case is filled in.
    bool exhausted = true;

    for (int bounce = 0; bounce < MAX_BOUNCE_LIMIT; ++bounce) {
        if (bounce >= uMaxBounces) {
            break;
        }

        Hit interior;

        // Traced as a ray from inside, so only a facet the ray leaves through can be hit. A march
        // that float error started just outside the stone passes through the facet it came in by,
        // instead of taking it for an exit (T-0032). That same rule, and not the minimum distance,
        // is what keeps the march from re-hitting the facet it just left; see INTERIOR_T_MIN,
        // which is deliberately far smaller than the nudge that starts the ray inside the surface.
        if (!traceScene(origin, direction, INTERIOR_T_MIN, FAR_DISTANCE, RAY_FROM_INSIDE, interior)) {
            // A watertight stone cannot leak, so this only fires on numerical edge
            // cases. Dropping the remaining energy is the safe response: adding it
            // to the pixel would show up as a bright speckle.
            exhausted = false;
            break;
        }

        bounceCount = bounce + 1;

        vec3 surfacePoint = origin + direction * interior.t;

        // Beer-Lambert absorption over the distance just travelled through the
        // solid. This is what gives a coloured stone its body colour, and why a
        // deeper stone reads darker and more saturated than a shallow one.
        throughput *= exp(-uAbsorption * interior.t);

        // Travelling outward from inside. The side rule already means the facet's normal points
        // along the ray; this only guards a grazing hit, where rounding can give the normal and the
        // triangle test's determinant different signs.
        vec3 outwardNormal = interior.outwardNormal;

        if (dot(direction, outwardNormal) < 0.0) {
            outwardNormal = -outwardNormal;
        }

        // The face the ray arrived from is the inner one.
        vec3 arrivalNormal = -outwardNormal;
        float cosInterior = dot(direction, outwardNormal);

        // Leaving the stone: gem to air. This eta is greater than 1, which is what
        // makes total internal reflection possible.
        float etaLeaving = refractiveIndex;
        float reflectance = fresnelReflectance(cosInterior, etaLeaving);

        vec3 exitDirection;

        if (reflectance < 1.0 && refractRay(direction, arrivalNormal, etaLeaving, exitDirection)) {
            // The transmitted part escapes and picks up whatever lies along its exit,
            // including the window rules for light arriving from behind the stone.
            gathered += throughput * (1.0 - reflectance)
                      * arrivingLight(surfacePoint, normalize(exitDirection), outwardNormal);
        }

        // The rest reflects back inside and keeps going. When `reflectance` is 1.0
        // this is total internal reflection and no light is lost at all.
        throughput *= reflectance;

        // Stop once no channel can still affect the pixel.
        //
        // Tested on the largest channel rather than the sum, so the threshold means
        // the same thing whether one channel is active (dispersive mode) or three
        // (mono mode). Summing would make the effective per-channel cutoff three
        // times stricter in mono mode, so toggling dispersion would shift where
        // paths terminate on top of the intended change, confounding the one
        // comparison that toggle exists to make.
        //
        // Placed after the transmitted contribution is gathered, so the light
        // leaving at this surface is still counted; breaking before it would
        // systematically darken the result rather than truncating neutrally.
        if (maxComponent(throughput) < THROUGHPUT_CUTOFF) {
            exhausted = false;
            break;
        }

        direction = reflect(direction, outwardNormal);
        origin = surfacePoint - outwardNormal * SURFACE_EPSILON;
    }

    // Out of bounces with light still inside: fill it in rather than discard it.
    //
    // Follows Gem Cut Studio, which colours such areas "a slightly darker tint of the gem
    // color". Its screenshots measure that as half, which uExhaustionShade defaults to.
    // Discarding the light instead turns every deeply trapped path black, although total
    // internal reflection loses almost nothing, so it would eventually have come out. The
    // remaining throughput still scales it.
    //
    // The two factors are different kinds of quantity and must be combined in that order
    // (T-0072):
    //   * uExhaustionShade is a **display** value, decoded like the head shadow and window
    //     colours so a fully trapped path in a colourless stone reads as exactly that shade
    //     under every transfer;
    //   * exp(-uAbsorption), the stone's transmittance over a unit distance, is already
    //     **linear**: a multiplier on radiance, exactly like the exp(-uAbsorption * t) applied
    //     at each segment above. So it multiplies the decoded shade and is not decoded itself.
    // Decoding their product instead raised the transmittance to the power DISPLAY_GAMMA under
    // the filmic and gamma transfers, which nearly doubled the fill's saturation: for amethyst
    // (0.35, 0.80, 0.20) at shade 0.5 under the filmic curve the tint ratio r:g:b came out
    // 2.881 : 1 : 4.191 instead of 1.568 : 1 : 1.822, and the fill was 12-37 levels of 255 too
    // dark as well. Under TONEMAP_LINEAR decode is linear, so the two forms agree exactly, and
    // for a colourless stone exp(0) is exactly 1.0 under all three -- which is why the
    // GCS-validated corner value (0.5 * 0.8652 + 0.1348 = 144.7/255) is untouched.
    if (exhausted && uExhaustionShade > 0.0) {
        vec3 stoneColor = exp(-uAbsorption);

        gathered += throughput * displayToRadiance(vec3(uExhaustionShade)) * stoneColor;
    }

    return gathered;
}

// ---------------------------------------------------------------- presentation

// Reinhard tone mapping followed by a gamma transfer curve.
//
// Tone mapping is not optional here: the environment is genuinely high dynamic
// range, and a stone concentrates it further, so raw radiance routinely exceeds 1.0
// by a large factor. Clamping instead would flatten every flash into a white blob.
vec3 tonemap(vec3 color) {
    color = max(color * uExposure, vec3(0.0));

    // Analytical lighting models need a *linear* transfer, not a tone curve.
    //
    // Their whole value is that the output colour can be read back as a quantity. The
    // Isometric model is specified so that a facet returning light from above "will
    // appear as white", and the Angle Rings bands are meant to show as their own flat
    // hues. A compressive curve breaks both: it maps a unit radiance to 0.73, so a fully
    // returning facet renders as grey rather than white and every band comes out
    // desaturated. Since these models define unit radiance to *be* white, clamping is
    // the correct display transform and the reading survives.
    if (uToneMapMode == TONEMAP_LINEAR) {
        return clamp(color, 0.0, 1.0);
    }

    // Image environments: the exact inverse of how their pixels were decoded, so the
    // surroundings keep the brightness they had in the image. An 8-bit image holds no
    // radiance above 1.0, so there is nothing for a compressive curve to rescue, and it
    // would only dim every wall and window.
    if (uToneMapMode == TONEMAP_GAMMA) {
        return pow(clamp(color, 0.0, 1.0), vec3(1.0 / DISPLAY_GAMMA));
    }

    // Maps [0, inf) into [0, 1) while preserving contrast at the low end. Right for the
    // studio rig, whose small sources peak in the hundreds and would otherwise clip to
    // flat white across every bright facet.
    color = color / (1.0 + color);

    return pow(color, vec3(1.0 / DISPLAY_GAMMA));
}

// Distinct colour per facet, for verifying facet grouping.
//
// Steps the hue by the golden ratio so consecutive facet ids land far apart and
// neighbouring facets are easy to tell apart.
vec3 facetColor(float facet) {
    float hue = fract(facet * 0.6180339887498949);

    // Standard hue-to-RGB ramp.
    vec3 ramp = abs(mod(hue * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0;

    return clamp(ramp, 0.0, 1.0);
}

// Blue through green to red, for traversal cost and bounce counts.
vec3 heatmap(float amount) {
    amount = clamp(amount, 0.0, 1.0);

    return vec3(
        smoothstep(0.5, 1.0, amount),
        1.0 - abs(amount - 0.5) * 2.0,
        1.0 - smoothstep(0.0, 0.5, amount)
    );
}

// ---------------------------------------------------------------- facet wireframe

// Half the width of a facet outline, in CSS pixels: on-screen size, not backing-store pixels.
// The backing store shrinks while dragging (the page's "Drag quality", 40% by
// default) and grows with devicePixelRatio, and a width in its pixels made the lines 2.5x
// thicker mid-drag than at rest. uWireframePixelScale converts. An edge between two visible
// facets is drawn from both sides, so it is twice this wide; a silhouette edge only from the one
// visible side.
const float WIREFRAME_HALF_WIDTH_CSS_PIXELS = 0.5;

// Backing-store pixels per CSS pixel of the canvas, for the wireframe's width.
uniform float uWireframePixelScale;

// Display colour of the outline, painted over the tone-mapped pixel, and how opaque it is where
// it fully covers a pixel (0.5 at the user's request, 2026-09-18).
const vec3 WIREFRAME_COLOR = vec3(0.0);
const float WIREFRAME_OPACITY = 0.5;

// Display colour of the selected facet (the page's UI background, --panel, in display
// values since it is mixed after the tone map) and how much of it replaces the tone-mapped
// pixel: three quarters, at the user's request (2026-09-18), so the stone still shows through
// faintly. It was the accent blue at 0.4 first, then this colour at 1.0, then 0.5.
// Nord nord0 #2e3440 since the page moved to the Nord palette (T-0150); it tracks --panel.
const vec3 HIGHLIGHT_COLOR = vec3(46.0, 52.0, 64.0) / 255.0;
const float HIGHLIGHT_OPACITY = 0.75;
// The selected facet has no border of its own: the user had one removed (2026-09-18), so it
// shows the ordinary wireframe outline like every other facet.

// Bits of the per-triangle mask accel::Accel::to_gpu packs into texel 1's w. Must match
// mesh::Mesh::facet_boundary_masks; a test enforces that.
const int WIREFRAME_EDGE_AB = 1;
const int WIREFRAME_EDGE_BC = 2;
const int WIREFRAME_EDGE_CA = 4;
const int WIREFRAME_CORNER_A = 8;
const int WIREFRAME_CORNER_B = 16;
const int WIREFRAME_CORNER_C = 32;

// Where a world point lands on the screen, in pixels from the centre of the view. The exact
// inverse of the primary ray setup in renderHandWritten(), for either projection.
vec2 worldToScreenPixels(vec3 point) {
    vec3 offset = point - uCameraOrigin;
    vec2 ndc;

    if (uOrthographicHalfHeight > 0.0) {
        ndc = vec2(
            dot(offset, uCameraRight) / (uAspect * uOrthographicHalfHeight),
            dot(offset, uCameraUp) / uOrthographicHalfHeight
        );
    } else {
        // The camera sits outside the stone, so every vertex is in front of it; the floor only
        // keeps a degenerate pose from dividing by zero.
        float depth = max(dot(offset, uCameraForward), 1e-6);

        ndc = vec2(
            dot(offset, uCameraRight) / (depth * uAspect * uTanHalfFov),
            dot(offset, uCameraUp) / (depth * uTanHalfFov)
        );
    }

    return ndc * 0.5 * uResolution;
}

// Screen distance, in pixels, from `pixel` to the segment from `from` to `to`.
float distanceToSegment(vec2 pixel, vec2 from, vec2 to) {
    vec2 along = to - from;
    float lengthSquared = dot(along, along);
    float fraction = lengthSquared > 0.0
        ? clamp(dot(pixel - from, along) / lengthSquared, 0.0, 1.0)
        : 0.0;

    return length(pixel - (from + along * fraction));
}

// How much of a pixel whose centre is `nearest` backing-store pixels from a line of half-width
// `halfWidthCssPixels` CSS pixels the line covers, 0 to 1.
//
// Coverage is how much of a one-pixel-wide footprint across the line, [nearest - 0.5,
// nearest + 0.5], the line [-halfWidth, halfWidth] overlaps: a box filter. A line narrower
// than a pixel then draws fainter rather than wider, so at low resolution it keeps the
// same apparent weight and only gets softer. A fixed fade in pixels widened it instead.
float lineCoverage(float nearest, float halfWidthCssPixels) {
    float halfWidth = halfWidthCssPixels * uWireframePixelScale;

    return clamp(min(nearest + 0.5, halfWidth) - max(nearest - 0.5, -halfWidth), 0.0, 1.0);
}

// How much of this pixel the facet outline covers, 0 to 1, given the triangle the primary ray
// hit.
//
// Only that triangle's own outline edges are measured, and that is the whole of the hidden-line
// removal: the primary ray stops at the nearest surface, so a pixel only ever belongs to a
// visible facet, and an edge behind the stone -- or behind a nearer part of it -- is never the
// edge of the triangle a pixel hit. Edges between two triangles of one facet are not in the
// mask (see mesh::Mesh::facet_boundary_masks), so the triangulation stays invisible.
//
// Distances are measured on the screen, between projected points, not in the facet's plane, so
// a facet seen edge-on still gets a line of the same width. The corner discs fill the notch a
// fan triangulation would otherwise leave where a sliver triangle meets a facet corner.
float wireframeCoverage(int triangleIndex) {
    int mask = int(fetchTexel(uTriangles, triangleIndex * 3 + 1).w + 0.5);

    if (mask == 0) {
        return 0.0;
    }

    Triangle triangle = fetchTriangle(triangleIndex);
    vec2 pixel = vNdc * 0.5 * uResolution;
    vec2 a = worldToScreenPixels(triangle.a);
    vec2 b = worldToScreenPixels(triangle.b);
    vec2 c = worldToScreenPixels(triangle.c);

    float nearest = FAR_DISTANCE;

    if ((mask & WIREFRAME_EDGE_AB) != 0) {
        nearest = min(nearest, distanceToSegment(pixel, a, b));
    }

    if ((mask & WIREFRAME_EDGE_BC) != 0) {
        nearest = min(nearest, distanceToSegment(pixel, b, c));
    }

    if ((mask & WIREFRAME_EDGE_CA) != 0) {
        nearest = min(nearest, distanceToSegment(pixel, c, a));
    }

    if ((mask & WIREFRAME_CORNER_A) != 0) {
        nearest = min(nearest, length(pixel - a));
    }

    if ((mask & WIREFRAME_CORNER_B) != 0) {
        nearest = min(nearest, length(pixel - b));
    }

    if ((mask & WIREFRAME_CORNER_C) != 0) {
        nearest = min(nearest, length(pixel - c));
    }

    return lineCoverage(nearest, WIREFRAME_HALF_WIDTH_CSS_PIXELS);
}

// ---------------------------------------------------------------- entry point

// Distance from the world origin at which primary rays start to be traced. The mesh conditioner
// centres every stone on the origin at radius 1, so the stone lies inside it. Must match
// camera::PRIMARY_RAY_START_RADIUS; a test enforces that.
const float PRIMARY_RAY_START_RADIUS = 1.05;

// The primary ray for this fragment, from the camera basis. Mirrors
// camera::CameraBasis::ray_origin, camera::CameraBasis::ray_direction and
// camera::CameraBasis::ray_start.
//
// Perspective: every ray starts at the eye and fans out. This is the default, Gem Cut
// Studio's camera with its eye 52 world units away (camera::GEM_CUT_STUDIO_EYE_DISTANCE),
// and a lens set with the fov parameter takes the same path.
//
// Where a primary ray from `eye` along `direction` starts when the cutting assistant's dop is out
// (T-0234), given `start`, where it starts otherwise. The assistant lets the rod reach past the
// stone's unit sphere (cutting_assistant.js's DOP_VIEW_REACH) rather than shrink the rough to make
// room for it, and a ray starting at PRIMARY_RAY_START_RADIUS would begin inside the rod's far end
// and miss it. So with a dop the start moves out to beyond the rod's furthest point; without one
// this returns `start` untouched, and the ray is exactly the one camera::CameraBasis::ray_start
// mirrors. Only the renderers that draw the rod use it (not the ported path's luxEyeRay).
vec3 dopAwareRayStart(vec3 eye, vec3 direction, vec3 start) {
    if (uDopStart.w <= 0.0) {
        return start;
    }

    float reach = max(length(uDopStart.xyz), length(uDopEnd.xyz)) + uDopStart.w + 0.05;

    return eye + direction * max(dot(-eye, direction) - max(reach, PRIMARY_RAY_START_RADIUS), 0.0);
}

// Orthographic: every ray travels along the view axis, and the origins tile a
// plane through the eye. The plane sits at least camera::MIN_DISTANCE from the target,
// outside the unit-radius stone, so no ray starts inside the solid.
void primaryRay(out vec3 origin, out vec3 direction) {
    origin = uCameraOrigin;

    if (uOrthographicHalfHeight > 0.0) {
        origin += uCameraRight * (vNdc.x * uAspect * uOrthographicHalfHeight)
                + uCameraUp * (vNdc.y * uOrthographicHalfHeight);
        direction = uCameraForward;
    } else {
        direction = normalize(
            uCameraForward
            + uCameraRight * (vNdc.x * uAspect * uTanHalfFov)
            + uCameraUp * (vNdc.y * uTanHalfFov)
        );
    }

    // Start tracing where the ray comes within PRIMARY_RAY_START_RADIUS of the stone's centre, not
    // at the eye. The ray is the same and nothing in front of the stone is skipped, but the triangle
    // test then works with numbers near 1. From Gem Cut Studio's eye, 52 units away, f32 cancellation
    // put hits on small triangles up to 2e-3 off the surface, twenty times SURFACE_EPSILON, so the
    // interior march could start outside the stone (T-0032).
    vec3 eye = origin;

    origin += direction * max(dot(-origin, direction) - PRIMARY_RAY_START_RADIUS, 0.0);
    origin = dopAwareRayStart(eye, direction, origin);
}

// The primary ray's meeting with the cutting assistant's dop (T-0234): the display value to show
// when the rod is nearer than the stone -- `stoneT`, or FAR_DISTANCE when the ray missed the stone
// -- and whether it is. `unlit` gives the flat renderer's plain bronze, with no light, as it gives
// the stone its plain colour.
bool dopInFront(vec3 origin, vec3 direction, float stoneT, bool unlit, out vec3 display) {
    vec3 normal;
    float t = dopDistance(origin, direction, SURFACE_EPSILON, stoneT, normal);

    display = DOP_BRONZE;

    if (t >= FAR_DISTANCE) {
        return false;
    }

    if (!unlit) {
        display = tonemap(dopRadiance(direction, normal));
    }

    return true;
}

// What a primary ray that misses the stone shows, as a display value.
//
// A picked background colour is written through untouched, deliberately skipping the tone
// map. It is a flat backdrop chosen in a colour picker, not radiance arriving from a scene, so
// the colour asked for is the colour that should appear -- pure black must come out as exactly
// zero, and a mid grey must not shift. The environment backdrop still goes through the tone
// map, because that genuinely is radiance and shares the stone's exposure.
vec3 missDisplay(vec3 direction) {
    if (uUseBackgroundColor != 0) {
        return uBackgroundColor;
    }

    return tonemap(sampleEnvironment(toLightingFrame(direction)));
}

// `display` with the selected facets' tint and the facet wireframe drawn over it, for the
// primary hit `entry`. Shared by every renderer that draws them (renderHandWritten and
// renderFlat), so the overlays look the same whichever is selected.
vec3 withOverlays(vec3 display, Hit entry) {
    // The selected facets' tint and the facet outline both go over the finished
    // pixel, so they change nothing the stone renders. Only the facet the primary ray struck is
    // tinted, so a selected facet seen through the stone is not. Facet ids are small whole
    // numbers stored exactly in a float; the +0.5 before truncating only guards against a
    // driver's rounding when it was written into the triangle texture in the first place.
    bool selected = texelFetch(uHighlightTexture, ivec2(int(entry.facet + 0.5), 0), 0).r > 0.5;

    if (selected) {
        display = mix(display, HIGHLIGHT_COLOR, HIGHLIGHT_OPACITY);
    }

    if (uWireframe != 0) {
        display = mix(display, WIREFRAME_COLOR, WIREFRAME_OPACITY * wireframeCoverage(entry.triangle));
    }

    return display;
}

// The deterministic renderer's whole frame. This was `main()` until T-0120 wired the ported
// LuxCore path in alongside it; `main()` now lives in src/shaders/lux/entry.glsl and calls
// this when `uRenderer` selects the deterministic path. Its primary ray, background and
// overlays are primaryRay, missDisplay and withOverlays, shared with renderFlat.
void renderHandWritten() {
    vec3 origin;
    vec3 direction;
    primaryRay(origin, direction);

    // The primary ray keeps SURFACE_EPSILON as its minimum distance, unlike the interior march
    // (see INTERIOR_T_MIN), because here the bound is unreachable rather than a dead zone. This
    // origin is PRIMARY_RAY_START_RADIUS before the ray's closest approach to the stone's centre,
    // so it is at least that far from the centre, and the conditioner leaves every vertex within
    // radius 1: the nearest point of the stone is at least 0.05 along the ray, five hundred times
    // this bound. Lowering it could not admit a hit, and it stays as the one guard against a
    // degenerate self-hit if a primary ray ever starts on the surface.
    Hit entry;
    bool struckStone = traceScene(origin, direction, SURFACE_EPSILON, FAR_DISTANCE, RAY_FROM_OUTSIDE, entry);

    if (uDebugMode == DEBUG_TRAVERSAL_COST) {
        // Normalised against a budget that a healthy hierarchy stays well under.
        fragColor = vec4(heatmap(float(entry.nodesVisited) / 96.0), 1.0);
        return;
    }

    // The cutting assistant's dop, when it is nearer than the stone (T-0234).
    vec3 dopDisplay;

    if (dopInFront(origin, direction, struckStone ? entry.t : FAR_DISTANCE, false, dopDisplay)) {
        fragColor = vec4(dopDisplay, 1.0);
        return;
    }

    if (!struckStone) {
        fragColor = vec4(missDisplay(direction), 1.0);
        return;
    }

    vec3 entryPoint = origin + direction * entry.t;

    // Face the normal towards the camera. A ray from outside only hits facets it enters, so this
    // only guards a grazing hit, where rounding can give the normal and the triangle test's
    // determinant different signs.
    vec3 entryNormal = entry.outwardNormal;

    if (dot(direction, entryNormal) > 0.0) {
        entryNormal = -entryNormal;
    }

    if (uDebugMode == DEBUG_NORMALS) {
        fragColor = vec4(entryNormal * 0.5 + 0.5, 1.0);
        return;
    }

    if (uDebugMode == DEBUG_FACET_ID) {
        fragColor = vec4(facetColor(entry.facet), 1.0);
        return;
    }

    // The refractive index each channel is traced with, chosen exactly the way the interior
    // passes below are dispatched: one index per channel with dispersion on, and the mid-band
    // index in all three channels with it off, since that single pass carries all three.
    //
    // Derived once and used by both the highlight and the traces, so the two cannot disagree
    // about which index a channel has. (uSpectralIor already holds three equal indices whenever
    // uSpectralSamples is 1 -- params::RenderParams::spectral_indices returns them that way --
    // so today this select changes nothing; it is what keeps the mono path self-consistent if
    // that ever stops being true.)
    vec3 entryIndices = uSpectralSamples <= 1 ? vec3(uSpectralIor.y) : uSpectralIor;

    // Surface highlight: the fraction that reflects off the outside of the stone without ever
    // entering it.
    //
    // Evaluated per channel. traceInterior admits channelMask * (1.0 - entryReflectance) using
    // that channel's own index, so a single shared reflectance made reflected plus transmitted
    // miss 1.0 in every channel but green: for the default cubic zirconia (2.130 / 2.160 /
    // 2.190) the sum was 1.00442 in red and 0.99559 in blue, and for rutile (2.620 / 2.760 /
    // 2.900) 1.01884 and 0.98176, about 5 levels of 255 on a bright highlight and a warm cast
    // with it. The error is near-constant from normal incidence out to 60 degrees and only dies
    // near grazing, so it was not confined to silhouette edges (T-0071). Evaluating from the
    // same operands here as there makes each channel's sum exactly 1.
    //
    // This costs two extra scalar Fresnel evaluations per pixel and nothing else: the incidence
    // cosine, the mirror direction and the arrivingLight() lookup do not depend on the
    // refractive index, so each is still evaluated once for all three channels.
    float cosEntry = -dot(direction, entryNormal);
    vec3 surfaceReflectance = vec3(
        fresnelReflectance(cosEntry, 1.0 / entryIndices.x),
        fresnelReflectance(cosEntry, 1.0 / entryIndices.y),
        fresnelReflectance(cosEntry, 1.0 / entryIndices.z)
    );
    vec3 color = surfaceReflectance
               * arrivingLight(entryPoint, reflect(direction, entryNormal), entryNormal);

    int bounces = 0;

    if (uSpectralSamples <= 1) {
        // One pass, all three channels sharing a single refractive index: no
        // dispersion, so no fire, but a third of the cost.
        color += traceInterior(entryPoint, direction, entryNormal,
                               entryIndices.y, vec3(1.0), bounces);
    } else {
        // One pass per channel, each with its own refractive index. The channels
        // take measurably different paths inside the stone, and that divergence is
        // exactly what fire is.
        //
        // Unrolled rather than looped so the refractive index is never indexed
        // dynamically, which some drivers handle poorly.
        int redBounces;
        int greenBounces;
        int blueBounces;

        color += traceInterior(entryPoint, direction, entryNormal,
                               entryIndices.x, vec3(1.0, 0.0, 0.0), redBounces);
        color += traceInterior(entryPoint, direction, entryNormal,
                               entryIndices.y, vec3(0.0, 1.0, 0.0), greenBounces);
        color += traceInterior(entryPoint, direction, entryNormal,
                               entryIndices.z, vec3(0.0, 0.0, 1.0), blueBounces);

        bounces = max(redBounces, max(greenBounces, blueBounces));
    }

    if (uDebugMode == DEBUG_BOUNCE_COUNT) {
        fragColor = vec4(heatmap(float(bounces) / float(uMaxBounces)), 1.0);
        return;
    }

    vec3 display = tonemap(color);

    fragColor = vec4(withOverlays(display, entry), 1.0);
}

// The flat renderer (the user's request, 2026-09-18): no rendering at all, only an opaque
// surface. The primary ray is traced exactly as renderHandWritten traces it, and a hit shows
// the stone colour, flat: no light, no reflection, no refraction, no tone map. The stone
// colour is exp(-uAbsorption), what params::RenderParams::stone_color returns and the page's
// Stone colour swatch shows, written through as a display value like a picked background.
// The background, the selected facets' tint and the wireframe are the other renderers', so
// with the wireframe on this is a clean drawing of the facets.
//
// lib.rs's flat_ignored_uniforms scans this function and what it calls to decide which page
// controls to hide under this renderer, so a uniform read here must be read for real.
void renderFlat() {
    vec3 origin;
    vec3 direction;
    primaryRay(origin, direction);

    Hit entry;
    bool struckStone = traceScene(origin, direction, SURFACE_EPSILON, FAR_DISTANCE, RAY_FROM_OUTSIDE, entry);

    // The cutting assistant's dop (T-0234), flat bronze as the stone is flat colour.
    vec3 dopDisplay;

    if (dopInFront(origin, direction, struckStone ? entry.t : FAR_DISTANCE, true, dopDisplay)) {
        fragColor = vec4(dopDisplay, 1.0);
        return;
    }

    if (!struckStone) {
        fragColor = vec4(missDisplay(direction), 1.0);
        return;
    }

    fragColor = vec4(withOverlays(exp(-uAbsorption), entry), 1.0);
}
