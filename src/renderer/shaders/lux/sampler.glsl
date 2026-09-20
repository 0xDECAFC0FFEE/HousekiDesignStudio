// -----------------------------------------------------------------------------
// LuxCore RNG and RANDOM sampler, ported to GLSL ES 3.00.                T-0097
//
// Ported from LuxCoreRender (https://github.com/LuxCoreRender/LuxCore),
// Copyright 1998-2020 by authors (see reference/LuxCore/AUTHORS.txt),
// licensed Apache License, Version 2.0. This file is a derivative work under
// that licence, combined here with the Gem renderer's own Apache-2.0 code
// (Copyright 2026 Lucas Tong; see this project's LICENSE and NOTICE).
//
//     Licensed under the Apache License, Version 2.0 (the "License");
//     you may not use this file except in compliance with the License.
//     You may obtain a copy of the License at
//
//         http://www.apache.org/licenses/LICENSE-2.0
//
//     Unless required by applicable law or agreed to in writing, software
//     distributed under the License is distributed on an "AS IS" BASIS,
//     WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//     See the License for the specific language governing permissions and
//     limitations under the License.
//
// Upstream sources this file transliterates (see per-function comments below
// for exact line ranges at the reference/LuxCore commit e9ced7e):
//   - include/luxrays/core/randomgen_types.cl   -- the `Seed` struct
//   - include/luxrays/core/randomgen_funcs.cl   -- TAUSWORTHE, LCG, ValidSeed,
//     Rnd_Init, Rnd_InitFloat, Rnd_UintValue, Rnd_FloatValue
//   - include/slg/samplers/sampler_types.cl     -- IDX_*/VERTEX_SAMPLE_SIZE
//     dimension-index constants (the SLG_OPENCL_KERNEL branch)
//   - include/slg/samplers/sampler_random_funcs.cl -- RandomSampler_GetSample,
//     RandomSampler_NextSample, and the sample0/sample1 tail of
//     RandomSampler_InitNewSample
//   - src/slg/samplers/random.cpp -- RandomSampler::GetSample,
//     RandomSampler::NextSample, RandomSampler::InitNewSample: the CPU mirror
//     of the .cl functions above, read to confirm the two agree (they do; the
//     bodies are the same operations on differently-spelled types)
//
// -----------------------------------------------------------------------------
// Design decisions this port had to make that upstream never had to (a shader
// invocation has no persistent state between pixels or frames the way a
// LuxCore CPU thread or GPU work-item does across its whole render):
//
// 1. POINTERS -> `inout`. Upstream threads a `Seed *` (and, for the sampler, a
//    `RandomSampler` instance holding that seed plus two cached floats) through
//    a call chain via pointers/member access. GLSL ES 3.00 has no pointers; every
//    function below takes `inout Seed` or `inout RandomSamplerState` instead,
//    which has the same single-object aliasing behaviour a pointer would.
//
// 2. SEEDING. Upstream seeds one `Seed` per render thread, once, from a thread
//    index, and keeps drawing from it for the entire render. A fragment shader
//    invocation has no identity that survives between frames, so `Sampler_Init`
//    below takes an already-computed `uint seed` argument rather than a thread
//    index. **This file does not decide how that seed is derived** (no upstream
//    function to port for it -- LuxCore's per-thread seed is just an incrementing
//    counter, meaningless per-pixel). The integration ticket must combine the
//    pixel coordinate with the frame/accumulation-pass number into that `uint`
//    (e.g. a hash of `uvec2(gl_FragCoord.xy)` and the pass number), so that every
//    pixel gets an independent stream and every accumulated frame a different one.
//    See T-0100 for a cheaper-seeding perf note; the hash function itself belongs
//    to whichever ticket wires this file into gem.frag, not to this one.
//
// 3. RandomSamplerState is this port's own struct (no single upstream struct
//    matches it): it bundles the `Seed` with the two cached screen-jitter values
//    upstream keeps as the `RandomSampler` object's `sample0`/`sample1` members
//    (declared in include/slg/samplers/random.h, which has no logic of its own
//    and so is not separately transliterated).
//
// 4. INTEGER TYPES. The .cl kernels already do this RNG's entire arithmetic in
//    `uint` (unlike the CPU-only 4-state taus113 `RandomGenerator` in
//    randomgen.h, which is NOT what this file ports -- see "Which generator"
//    below). GLSL ES 3.00 `uint` wraps modulo 2^32 on overflow and shifts
//    logically, exactly like OpenCL/C `uint32_t`, so every expression below is a
//    literal, unmodified transliteration. The only textual changes from the
//    upstream .cl are: (a) explicit `u` suffixes on integer literals used in
//    `uint` arithmetic, which GLSL ES requires and C/OpenCL do not (e.g.
//    `x * 69069u`, not `x * 69069`) -- purely a syntax requirement, verified by
//    glslangValidator, with no effect on the value; (b) bare float literals
//    (`1.0`, not `1.f`), per this project's prelude convention; (c)
//    `Rnd_InitFloat`'s float-to-bits reinterpretation uses GLSL's built-in
//    `floatBitsToUint`, which performs the exact IEEE-754 bit reinterpretation
//    the upstream C `union { float f; uint i; }` trick relies on -- not a
//    semantic divergence, just the native spelling of the same operation (the
//    prelude does the same thing for `native_sqrt` and friends).
//
// Which generator: LuxCore keeps TWO Tausworthe generators. `RandomGenerator` in
// randomgen.h is a CPU-only, 4-state (taus113) generator used for host-side
// scene setup. The .cl `Seed`/`Rnd_*` functions ported here are a 3-state
// Tausworthe generator (equivalent to randomgen.h's `TauswortheRandomGenerator`
// CPU mirror, which was read only to build an independent oracle for this port
// -- see the KB article -- and is not itself the port source). The .cl version is
// what every GPU kernel and therefore every sampler actually draws from, and it
// needs no 64-bit arithmetic anywhere, so this port needed no int64 workaround.
//
// What was cut, deliberately, as generality this project (a single faceted
// gemstone, no tiled/networked rendering, no adaptive noise-driven resampling)
// has no use for -- see T-0098 (bucket/tile/adaptive sampling) and T-0099
// (Sobol sampler; this ticket's stretch goal, declined in favour of a correct
// RANDOM sampler per the user's explicit instruction). Speed-up ideas that
// would diverge from a literal port are recorded, not implemented, in T-0100.
// -----------------------------------------------------------------------------

#ifndef LUX_SAMPLER_GLSL
#define LUX_SAMPLER_GLSL

// OPENCL_FORCE_INLINE is an OpenCL-build-configuration macro upstream (it can
// expand to nothing or to an inline-forcing attribute depending on the LuxCore
// build). The prelude does not define it, since it is unique to this file's
// sources; GLSL has no equivalent concept, so it maps to nothing, exactly like
// the prelude maps __global to nothing.
#ifndef OPENCL_FORCE_INLINE
#define OPENCL_FORCE_INLINE
#endif

// -----------------------------------------------------------------------------
// Seed struct.
// Ported from: include/luxrays/core/randomgen_types.cl, lines 21-23.
// -----------------------------------------------------------------------------
struct Seed {
    uint s1, s2, s3;
};

// -----------------------------------------------------------------------------
// Random number generator: maximally equidistributed combined Tausworthe
// generator (a taus88-family generator: 3 combined Tausworthe LFSR states).
// Ported from: include/luxrays/core/randomgen_funcs.cl, lines 26-70.
// -----------------------------------------------------------------------------

// FLOATMASK: upstream's #define FLOATMASK 0x00ffffffu (randomgen_funcs.cl:26).
#ifndef FLOATMASK
#define FLOATMASK 0x00ffffffu
#endif

// randomgen_funcs.cl:28-32.
OPENCL_FORCE_INLINE uint TAUSWORTHE(const uint s, const uint a,
        const uint b, const uint c, const uint d) {
    return ((s & c) << d) ^ (((s << a) ^ s) >> b);
}

// randomgen_funcs.cl:34. `69069u`: GLSL ES requires the `u` suffix to multiply
// a uint by an integer literal (upstream's untyped `69069` is implicitly
// widened to unsigned in C); the value and the wraparound behaviour are
// identical, verified against upstream bit-for-bit (see this ticket's close
// note).
OPENCL_FORCE_INLINE uint LCG(const uint x) { return x * 69069u; }

// randomgen_funcs.cl:36-38.
OPENCL_FORCE_INLINE uint ValidSeed(const uint x, const uint m) {
    return (x < m) ? (x + m) : x;
}

// randomgen_funcs.cl:40-44.
OPENCL_FORCE_INLINE void Rnd_Init(uint seed, inout Seed s) {
    s.s1 = ValidSeed(LCG(seed), 1u);
    s.s2 = ValidSeed(LCG(s.s1), 7u);
    s.s3 = ValidSeed(LCG(s.s2), 15u);
}

// This constructor is used to build a sequence of pseudo-random numbers
// starting form a floating point seed (usually another pseudo-random
// number)
// randomgen_funcs.cl:46-58. Upstream reinterprets the float's bits through a
// `union { float f; uint i; }`; GLSL's built-in `floatBitsToUint` performs the
// same IEEE-754 bit reinterpretation natively (see file header, point 4).
OPENCL_FORCE_INLINE void Rnd_InitFloat(const float floatSeed, inout Seed s) {
    uint bits_i = floatBitsToUint(floatSeed);

    Rnd_Init(bits_i, s);
}

// randomgen_funcs.cl:60-66. Upstream declares this `unsigned long` (OpenCL's
// 64-bit type) but every operand and the returned XOR are 32-bit `uint`
// values; the wide return type only zero-extends the top 32 bits, which
// Rnd_FloatValue's FLOATMASK (24 bits) never reaches. So the `uint` return
// type here is not a divergence -- it drops bits the upstream value never
// carried in the first place. Verified against the upstream CPU oracle bit
// for bit (see close note); no 64-bit arithmetic is needed anywhere in this
// generator.
OPENCL_FORCE_INLINE uint Rnd_UintValue(inout Seed s) {
    s.s1 = TAUSWORTHE(s.s1, 13u, 19u, 4294967294u, 12u);
    s.s2 = TAUSWORTHE(s.s2, 2u, 25u, 4294967288u, 4u);
    s.s3 = TAUSWORTHE(s.s3, 3u, 11u, 4294967280u, 17u);

    return ((s.s1) ^ (s.s2) ^ (s.s3));
}

// randomgen_funcs.cl:68-70. `(1.0 / float(FLOATMASK + 1u))`: upstream writes
// `(1.f / (FLOATMASK + 1UL))`, an implicit uint-to-float conversion C allows
// and GLSL ES does not (glslangValidator rejects the bare mixed-type
// expression); the explicit `float()` cast changes nothing about the value.
OPENCL_FORCE_INLINE float Rnd_FloatValue(inout Seed s) {
    return float(Rnd_UintValue(s) & FLOATMASK) * (1.0 / float(FLOATMASK + 1u));
}

// -----------------------------------------------------------------------------
// Indices of Sample related u[] array.
// Ported from: include/slg/samplers/sampler_types.cl, lines 25-47 (the
// SLG_OPENCL_KERNEL branch -- the non-OpenCL branch is the C++ host code's
// path and defines nothing here, since the .cpp samplers index by raw
// integers instead of these names).
//
// These dimension indices are load-bearing for whatever ports LuxCore's path
// integrator on top of this sampler: IDX_SCREEN_X/Y are consumed by this file
// (RandomSampler_GetSample below); IDX_EYE_TIME, IDX_DOF_X/Y and everything
// from IDX_BSDF_OFFSET onward are for the eye-ray and per-bounce BSDF/direct-
// light/Russian-roulette dimensions an integrator will request by index, and
// are ported here only as constants -- this ticket does not consume them.
// -----------------------------------------------------------------------------

#define IDX_SCREEN_X 0
#define IDX_SCREEN_Y 1
#define IDX_EYE_TIME 2
#define IDX_DOF_X 3
#define IDX_DOF_Y 4
#define IDX_BSDF_OFFSET 5

// Relative to IDX_BSDF_OFFSET + PathDepth * VERTEX_SAMPLE_SIZE
#define IDX_PASSTHROUGH 0
#define IDX_BSDF_X 1
#define IDX_BSDF_Y 2
#define IDX_DIRECTLIGHT_X 3
#define IDX_DIRECTLIGHT_Y 4
#define IDX_DIRECTLIGHT_Z 5
#define IDX_DIRECTLIGHT_W 6
#define IDX_DIRECTLIGHT_A 7
#define IDX_RR 8

#define VERTEX_SAMPLE_SIZE 9

// -----------------------------------------------------------------------------
// RandomSamplerState: this port's own struct, not a transliteration of any one
// upstream type (see file header, point 3). It is the `inout` object every
// RandomSampler_* function below threads instead of a `RandomSampler *this`
// plus its own `rngGeneratorSeed`.
// -----------------------------------------------------------------------------
struct RandomSamplerState {
    Seed seed;
    float sample0;
    float sample1;
};

// -----------------------------------------------------------------------------
// RandomSampler_InitNewSample: the pixel-jitter tail of upstream's function of
// the same name.
//
// Ported from: include/slg/samplers/sampler_random_funcs.cl, lines 158-161
// (the only part of RandomSampler_InitNewSample, lines 62-168, that survives
// -- see file header and T-0098 for what was cut and why: bucket/tile
// assignment via a Morton curve, super-sampling/overlapping counts, and
// adaptive resampling against a film noise/importance channel, none of which
// apply when a fragment-shader invocation already IS one pixel with no
// persistent film to read noise from). Cross-checked against the equivalent
// tail of RandomSampler::InitNewSample, src/slg/samplers/random.cpp lines
// 163-164 (`sample0 = pixelX + rndGen->floatValue(); sample1 = pixelY +
// rndGen->floatValue();`), which is the same operation on the CPU-side names.
// -----------------------------------------------------------------------------
OPENCL_FORCE_INLINE void RandomSampler_InitNewSample(inout RandomSamplerState state,
        float pixelX, float pixelY) {
    // Initialize IDX_SCREEN_X and IDX_SCREEN_Y sample
    state.sample0 = pixelX + Rnd_FloatValue(state.seed);
    state.sample1 = pixelY + Rnd_FloatValue(state.seed);
}

// -----------------------------------------------------------------------------
// RandomSampler_GetSample.
// Ported from: include/slg/samplers/sampler_random_funcs.cl, lines 27-42
// (the `samplesData[]` array lookup for IDX_SCREEN_X/Y is replaced here by the
// `state.sample0`/`state.sample1` fields RandomSampler_InitNewSample fills in,
// since this port has no per-work-item samplesDataBuff to index). Cross-checked
// against RandomSampler::GetSample, src/slg/samplers/random.cpp lines 178-189,
// whose `case 0: return sample0; case 1: return sample1; default: return
// rndGen->floatValue();` is the same three-way switch under the CPU names.
// -----------------------------------------------------------------------------
OPENCL_FORCE_INLINE float RandomSampler_GetSample(inout RandomSamplerState state,
        const uint index) {
    // `case uint(IDX_SCREEN_X):`, not the bare `case IDX_SCREEN_X:` upstream writes.
    //
    // GLSL ES 3.00 requires a case label to have the same type as the switch expression,
    // and `index` is `uint` (upstream's `const unsigned int`, which C happily compares
    // against a plain `int` literal). This is the same implicit-conversion gap this file's
    // header already documents for `uint` arithmetic, in the one place it shows up as a
    // label rather than an operand; the `#define IDX_*` constants stay spelled exactly as
    // upstream spells them.
    //
    // T-0120: this DID compile under glslangValidator, which is why T-0097's port and
    // kb/luxcore-rng-and-random-sampler-port-glsl-es-3-00.md both record it as confirmed
    // fine. ANGLE/SwiftShader, which is what actually runs in the browser, rejects it:
    // "'case' : case label type does not match switch init-expression type". glslang
    // passing is not evidence that a real driver will.
    switch (index) {
        case uint(IDX_SCREEN_X):
            return state.sample0;
        case uint(IDX_SCREEN_Y):
            return state.sample1;
        default:
            return Rnd_FloatValue(state.seed);
    }
}

// -----------------------------------------------------------------------------
// RandomSampler_NextSample.
// Ported from: include/slg/samplers/sampler_random_funcs.cl, lines 170-184,
// which upstream forwards, unchanged, straight to RandomSampler_InitNewSample
// (the bucket-index/passOffset bookkeeping RandomSampler_InitNewSample does
// internally is exactly the part T-0098 cut). Cross-checked against
// RandomSampler::NextSample, src/slg/samplers/random.cpp lines 191-216, whose
// only non-film-splat action is likewise a call to InitNewSample().
// -----------------------------------------------------------------------------
OPENCL_FORCE_INLINE void RandomSampler_NextSample(inout RandomSamplerState state,
        float pixelX, float pixelY) {
    RandomSampler_InitNewSample(state, pixelX, pixelY);
}

// -----------------------------------------------------------------------------
// Sampler_Init / Sampler_GetSample / Sampler_NextSample: this port's own thin
// entry points, NOT a transliteration (see file header, point 2 for why
// `seed` is a plain uint here rather than a thread index). They exist because
// the RANDOM-sampler-specific names above (`RandomSampler_*`) are what a
// future SOBOL or METROPOLIS port would sit alongside; since this ticket only
// delivers RANDOM (T-0099), the "dispatch" is just a direct call, but the
// generic names are kept stable for whatever wires this file into the
// integrator.
// -----------------------------------------------------------------------------
OPENCL_FORCE_INLINE void Sampler_Init(uint seed, float pixelX, float pixelY,
        inout RandomSamplerState state) {
    Rnd_Init(seed, state.seed);
    RandomSampler_InitNewSample(state, pixelX, pixelY);
}

OPENCL_FORCE_INLINE float Sampler_GetSample(inout RandomSamplerState state,
        const uint index) {
    return RandomSampler_GetSample(state, index);
}

OPENCL_FORCE_INLINE void Sampler_NextSample(inout RandomSamplerState state,
        float pixelX, float pixelY) {
    RandomSampler_NextSample(state, pixelX, pixelY);
}

#endif // LUX_SAMPLER_GLSL
