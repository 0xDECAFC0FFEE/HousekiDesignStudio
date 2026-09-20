// -----------------------------------------------------------------------------
// OpenCL -> GLSL ES 3.00 compatibility prelude for the LuxCore port.
//
// LuxCore keeps an OpenCL implementation of its leaf maths alongside the C++ one
// (include/slg/**/*.cl, include/luxrays/**/*.cl). Those kernels are the basis for
// this project's shader-side port. This file exists so a ported function body can
// stay a *literal* transliteration of the kernel it came from: same names, same
// expressions, same order, so any future `diff` against upstream is meaningful.
//
// Add to this file only if a define is genuinely shared. A define needed by one
// ported file belongs in that file, wrapped in #ifndef, so two files can define
// the same helper without colliding when they are concatenated.
//
// This file is not itself ported code and carries no LuxCore copyright.
// -----------------------------------------------------------------------------

#ifndef LUX_PRELUDE_GLSL
#define LUX_PRELUDE_GLSL

// --- vector types ------------------------------------------------------------
#define float2 vec2
#define float3 vec3
#define float4 vec4
#define int2   ivec2
#define int3   ivec3
#define int4   ivec4
#define uint2  uvec2
#define uint3  uvec3
#define uint4  uvec4

// --- address-space and kernel qualifiers, which GLSL has no concept of --------
#define __global
#define __local
#define __constant
#define __private
#define OCL_GLOBAL
#define OCL_CONSTANT

// --- scalar builtins that differ only in name --------------------------------
#define fabs(x)      abs(x)
#define fmax(a, b)   max(a, b)
#define fmin(a, b)   min(a, b)
// NOT defined: fmod. OpenCL's fmod truncates toward zero and keeps the sign of the
// dividend; GLSL's mod() is floored and keeps the sign of the divisor. They agree
// only when both operands are positive. Port each fmod call site by hand and say in
// a comment which behaviour the caller relies on.
#define rsqrt(x)     inversesqrt(x)

// OpenCL's native_* are precision-relaxed variants of the same functions. GLSL ES
// has no equivalent, so they map to the exact ones; results may differ from
// LuxCore in the last bits, which is the intended and documented divergence.
#define native_sqrt(x)       sqrt(x)
#define native_recip(x)      (1.0 / (x))
#define native_divide(a, b)  ((a) / (b))
#define native_sin(x)        sin(x)
#define native_cos(x)        cos(x)
#define native_tan(x)        tan(x)
#define native_exp(x)        exp(x)
#define native_log(x)        log(x)
#define native_powr(a, b)    pow(a, b)

// --- constants ---------------------------------------------------------------
#ifndef M_PI_F
#define M_PI_F       3.14159265358979323846
#endif
#define M_1_PI_F     0.31830988618379067154
#define M_2_PI_F     0.63661977236758134308
#define M_PI_2_F     1.57079632679489661923
#define M_PI_4_F     0.78539816339744830961

// GLSL ES 3.00 has no INFINITY literal. 1e38 is just inside finite float range;
// division by zero is undefined in GLSL ES, so never produce infinity that way.
#define INFINITY     3.402823466e+38

// Verbatim from reference/LuxCore/include/luxrays/core/epsilon_types.cl:21-23.
// DEFAULT_EPSILON_MIN read 1e-9 here until 2026-09-17: a value invented when this
// prelude was written rather than read from upstream, and wrong by four orders of
// magnitude. It feeds MachineEpsilon, which sets how far a bounce ray is nudged off
// the surface, so too small a value is self-intersection acne. Caught by the
// integrator port (T-0109). Read the constant; do not guess it.
#define DEFAULT_EPSILON_MIN     1e-5
#define DEFAULT_EPSILON_MAX     1e-1
#define DEFAULT_EPSILON_STATIC  1e-5

// --- float suffix ------------------------------------------------------------
// OpenCL C writes `1.0f`. Write literals bare (`1.0`) in ported code: that is valid
// in every GLSL dialect, so it cannot become a portability problem later. This is
// the one systematic, deliberate textual departure from the upstream bodies.

float Sqr(const float v) { return v * v; }

#endif // LUX_PRELUDE_GLSL
