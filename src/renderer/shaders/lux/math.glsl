// -----------------------------------------------------------------------------
// Core maths and sampling, ported from LuxCore (https://github.com/LuxCoreRender/LuxCore),
// reference/LuxCore commit e9ced7e:
//
//   include/luxrays/core/geometry/frame_funcs.cl        Frame_SetFromZ, Frame_ToWorld,
//                                                        Frame_ToLocal, ToWorld, ToLocal
//   include/luxrays/core/geometry/vector_funcs.cl        CoordinateSystem, SphericalTheta,
//                                                        SphericalPhi
//   include/luxrays/core/utils_funcs.cl                  CosTheta, SinTheta2, SinTheta,
//                                                        CosPhi, SinPhi, SphericalDirection
//   include/luxrays/utils/mc_funcs.cl                    ConcentricSampleDisk,
//                                                        CosineSampleHemisphere,
//                                                        UniformSampleHemisphere,
//                                                        UniformSampleSphere,
//                                                        UniformSampleCone, UniformConePdf,
//                                                        PowerHeuristic
//   include/slg/materials/materialdefs_funcs_glass.cl    GlassMaterial_WaveLength2RGB
//
// Copyright 1998-2020 by authors (see reference/LuxCore/AUTHORS.txt)
// Portions Copyright 2026 Lucas Tong
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// This is a faithful port, not a verbatim copy: it is line-for-line the same maths,
// same names, same expression order as the .cl kernels above (see
// kb/clean-room-and-licensing-constraints.md / kb/luxcore-as-a-reference-oracle.md
// for why LuxCore is the one renderer this project may read and port). Where OpenCL C and
// GLSL ES genuinely differ as *languages* rather than in the maths, this file bridges the
// gap the same way src/shaders/lux/prelude.glsl does for float3/__global/native_*:
//
//   - OpenCL pointer out-parameters (`float3 *v`, `float *dx`) become GLSL `out`/`inout`
//     parameters, since GLSL has no pointers. `*v = x` becomes `v = x`.
//   - `__global Frame *frame` becomes a `Frame` struct passed by value (`inout` where the
//     original mutates it). GLSL has no address spaces, so there is no VLOAD3F/VSTORE3F
//     step; a plain struct member assignment already is the "_Private" (non-__global)
//     sibling these functions have upstream, which does the same thing without those macros.
//   - `atan2(y, x)` becomes GLSL's two-argument `atan(y, x)` (same argument order); GLSL
//     ES 3.00 has no function named atan2.
//   - A local `const float x = <expr>;` loses the `const` when `<expr>` is not a
//     compile-time constant (i.e. almost every one of them, since they read a parameter or
//     call a function). OpenCL C's `const` only means "this copy is read-only"; GLSL ES
//     3.00 requires a const-qualified variable's initializer to itself be a constant
//     expression (glslangValidator: "'non-constant initializer' : not supported with this
//     profile: es"), which none of these are. Dropping `const` changes nothing about the
//     value computed or whether the port reassigns it -- none of these ported bodies ever
//     do -- it only stops asserting a guarantee GLSL ES won't let this file make. Function
//     *parameters* keep `const`; that use compiles fine and is unaffected.
//   - Upstream mixes bare integer literals (`440`, `645`, `420`, `700`) with `.f`-suffixed
//     float literals in the same expressions in GlassMaterial_WaveLength2RGB, because
//     OpenCL C (like C99) silently promotes int to float. GLSL ES 3.00 has no implicit
//     int->float conversion, so `440 - 380.f` would not compile as `440 - 380.0`; this port
//     spells every such literal `440.0` etc. The values are identical (440 promotes to
//     exactly 440.0, no precision loss) -- this is a syntax necessity, not a behaviour
//     change, and is called out again at the one function where it happens.
//   - Per the project's float-literal convention, every literal is written bare (`1.0`,
//     not `1.0f`); that is the one systematic textual departure from upstream's spelling.
//
// No logic is changed, tidied or fixed. Where upstream itself has an inconsistency (see
// GlassMaterial_WaveLength2RGB's mixed 645.f/645 below) it is preserved and noted, not fixed.
// -----------------------------------------------------------------------------

#ifndef LUX_MATH_GLSL
#define LUX_MATH_GLSL

// --- helpers this file needs that the prelude deliberately leaves out ---------
// (see prelude.glsl's own comment on why shared helpers go here, wrapped in #ifndef,
// rather than in the prelude: two sibling files are being written concurrently and a
// second, identical #define would break the concatenated shader, not a second identical
// function -- GLSL tolerates a redundant #define of the same token sequence, but not a
// redefinition of a function or struct, hence the guards below too.)

#ifndef MAKE_FLOAT3
#define MAKE_FLOAT3(x, y, z) float3(x, y, z)
#endif

#ifndef BLACK
#define BLACK MAKE_FLOAT3(0.0, 0.0, 0.0)
#endif

// GLSL ES 3.00 has no function named atan2; its two-argument atan(y, x) is the same
// function with the same argument order, so this is a rename, not a rewrite.
#ifndef atan2
#define atan2(y, x) atan(y, x)
#endif

// -----------------------------------------------------------------------------
// vector_funcs.cl
// -----------------------------------------------------------------------------

// vector_funcs.cl:30-41 (CoordinateSystem)
// Pointer out-params (float3 *v2, float3 *v3) become GLSL `out` params.
void CoordinateSystem(const float3 v1, out float3 v2, out float3 v3) {
	float len = sqrt(v1.x * v1.x + v1.y * v1.y);
	if (len < 1.e-5) { // it's pretty-much along z-axis
		v3.x = 1.0;
		v3.y = 0.0;
		v3.z = 0.0;
	} else {
		v3.x = -v1.y / len;
		v3.y = v1.x / len;
		v3.z = 0.0;
	}
	v2 = cross(v1, v3);
}

// vector_funcs.cl:21-23
float SphericalTheta(const float3 v) {
	return acos(clamp(v.z, -1.0, 1.0));
}

// vector_funcs.cl:25-28
float SphericalPhi(const float3 v) {
	float p = atan2(v.y, v.x);
	return (p < 0.0) ? p + 2.0 * M_PI_F : p;
}

// -----------------------------------------------------------------------------
// utils_funcs.cl
// -----------------------------------------------------------------------------

// utils_funcs.cl:101-103
float CosTheta(const float3 v) {
	return v.z;
}

// utils_funcs.cl:105-107
float SinTheta2(const float3 w) {
	return fmax(0.0, 1.0 - CosTheta(w) * CosTheta(w));
}

// utils_funcs.cl:109-111
float SinTheta(const float3 w) {
	return sqrt(SinTheta2(w));
}

// utils_funcs.cl:113-116
float CosPhi(const float3 w) {
	float sinTheta = SinTheta(w);
	return sinTheta > 0.0 ? clamp(w.x / sinTheta, -1.0, 1.0) : 1.0;
}

// utils_funcs.cl:118-121
float SinPhi(const float3 w) {
	float sinTheta = SinTheta(w);
	return sinTheta > 0.0 ? clamp(w.y / sinTheta, -1.0, 1.0) : 0.0;
}

// utils_funcs.cl:123-125
float3 SphericalDirection(float sintheta, float costheta, float phi) {
	return MAKE_FLOAT3(sintheta * cos(phi), sintheta * sin(phi), costheta);
}

// -----------------------------------------------------------------------------
// frame_funcs.cl
// -----------------------------------------------------------------------------

// frame.h's Frame class is X, Y, Z basis vectors; the __global Frame* the frame_funcs.cl
// kernels below take is that same layout in device memory. GLSL has no address spaces, so
// this ordinary struct is what a `Frame *`/`__global Frame *` parameter becomes, and
// Frame_SetFromZ takes it `inout` where upstream mutates through the pointer.
#ifndef LUX_FRAME_T
#define LUX_FRAME_T
struct Frame {
	float3 X;
	float3 Y;
	float3 Z;
};
#endif

// frame_funcs.cl:70-72
float3 ToWorld(const float3 X, const float3 Y, const float3 Z, const float3 v) {
	return X * v.x + Y * v.y + Z * v.z;
}

// frame_funcs.cl:74-76
float3 ToLocal(const float3 X, const float3 Y, const float3 Z, const float3 a) {
	return MAKE_FLOAT3(dot(a, X), dot(a, Y), dot(a, Z));
}

// frame_funcs.cl:45-52 (the __global Frame* overload; there is also a Frame_SetFromZ_Private
// taking a plain Frame*, whose body is identical apart from the VLOAD3F/VSTORE3F plumbing
// __global needs and GLSL doesn't -- see the struct comment above).
// VSTORE3F(X, &frame->X.x) writes X's three components starting at frame->X.x, i.e.
// frame->X = X; an inout struct parameter makes that assignment direct.
void Frame_SetFromZ(inout Frame frame, const float3 Z) {
	float3 X, Y;
	CoordinateSystem(Z, X, Y);

	frame.X = X;
	frame.Y = Y;
	frame.Z = Z;
}

// frame_funcs.cl:78-80
float3 Frame_ToWorld(const Frame frame, const float3 v) {
	return ToWorld(frame.X, frame.Y, frame.Z, v);
}

// frame_funcs.cl:89-91
float3 Frame_ToLocal(const Frame frame, const float3 v) {
	return ToLocal(frame.X, frame.Y, frame.Z, v);
}

// -----------------------------------------------------------------------------
// mc_funcs.cl
// -----------------------------------------------------------------------------

// mc_funcs.cl:94-133
// Pointer out-params (float *dx, float *dy) become GLSL `out` params.
void ConcentricSampleDisk(const float u0, const float u1, out float dx, out float dy) {
	float r, theta;
	// Map uniform random numbers to $[-1,1]^2$
	float sx = 2.0 * u0 - 1.0;
	float sy = 2.0 * u1 - 1.0;
	// Map square to $(r,\theta)$
	// Handle degeneracy at the origin
	if (sx == 0.0 && sy == 0.0) {
		dx = 0.0;
		dy = 0.0;
		return;
	}
	if (sx >= -sy) {
		if (sx > sy) {
			// Handle first region of disk
			r = sx;
			if (sy > 0.0)
				theta = sy / r;
			else
				theta = 8.0 + sy / r;
		} else {
			// Handle second region of disk
			r = sy;
			theta = 2.0 - sx / r;
		}
	} else {
		if (sx <= sy) {
			// Handle third region of disk
			r = -sx;
			theta = 4.0 - sy / r;
		} else {
			// Handle fourth region of disk
			r = -sy;
			theta = 6.0 + sx / r;
		}
	}
	theta *= M_PI_F / 4.0;
	dx = r * cos(theta);
	dy = r * sin(theta);
}

// mc_funcs.cl:135-142
float3 CosineSampleHemisphere(const float u0, const float u1) {
	float x, y;
	ConcentricSampleDisk(u0, u1, x, y);

	float z = sqrt(fmax(0.0, 1.0 - x * x - y * y));

	return MAKE_FLOAT3(x, y, z);
}

// mc_funcs.cl:155-163
float3 UniformSampleHemisphere(const float u1, const float u2) {
	float z = u1;
	float r = sqrt(fmax(0.0, 1.0 - z*z));
	float phi = 2.0 * M_PI_F * u2;
	float x = r * cos(phi);
	float y = r * sin(phi);

	return MAKE_FLOAT3(x, y, z);
}

// mc_funcs.cl:165-173
float3 UniformSampleSphere(const float u1, const float u2) {
	float z = 1.0 - 2.0 * u1;
	float r = sqrt(fmax(0.0, 1.0 - z * z));
	float phi = 2.0 * M_PI_F * u2;
	float x = r * cos(phi);
	float y = r * sin(phi);

	return MAKE_FLOAT3(x, y, z);
}

// mc_funcs.cl:188-202
float3 UniformSampleCone(const float u0, const float u1, const float costhetamax,
	const float3 x, const float3 y, const float3 z) {
	float costheta = mix(1.0, costhetamax, u0);
	float u0x = (1.0 - costhetamax) * u0;
	float sintheta = sqrt(u0x * (2.0 - u0x));
	float phi = u1 * 2.0 * M_PI_F;

	float kx = cos(phi) * sintheta;
	float ky = sin(phi) * sintheta;
	float kz = costheta;

	return MAKE_FLOAT3(kx * x.x + ky * y.x + kz * z.x,
			kx * x.y + ky * y.y + kz * z.y,
			kx * x.z + ky * y.z + kz * z.z);
}

// mc_funcs.cl:204-206
float UniformConePdf(const float costhetamax) {
	return 1.0 / (2.0 * M_PI_F * (1.0 - costhetamax));
}

// mc_funcs.cl:208-213
float PowerHeuristic(const float fPdf, const float gPdf) {
	float f = fPdf;
	float g = gPdf;

	return (f * f) / (f * f + g * g);
}

// -----------------------------------------------------------------------------
// materialdefs_funcs_glass.cl
// -----------------------------------------------------------------------------

// materialdefs_funcs_glass.cl:62-106
// Upstream is inconsistent about `.f` suffixes within the same expressions -- e.g. the
// green channel's `645.f` divisor is spelled `.f`-suffixed once and bare (`645`) a few
// characters later on the same line, and the intensity-falloff branch compares against
// bare `420`/`700` while its neighbours use `380.f`/`420.f`. That is harmless in OpenCL C,
// which promotes int literals to float; it is preserved value-for-value here (440.0 is
// exactly 440, etc.), just spelled consistently with a literal `.0` throughout, because
// GLSL ES 3.00 has no such implicit conversion and `440 - 380.0` does not compile. This is
// the file-header's syntax-necessity bridge, not a fix to upstream's numbers.
float3 GlassMaterial_WaveLength2RGB(const float waveLength) {
	float r, g, b;
	if ((waveLength >= 380.0) && (waveLength < 440.0)) {
		r = -(waveLength - 440.0) / (440.0 - 380.0);
		g = 0.0;
		b = 1.0;
	} else if ((waveLength >= 440.0) && (waveLength < 490.0)) {
		r = 0.0;
		g = (waveLength - 440.0) / (490.0 - 440.0);
		b = 1.0;
	} else if ((waveLength >= 490.0) && (waveLength < 510.0)) {
		r = 0.0;
		g = 1.0;
		b = -(waveLength - 510.0) / (510.0 - 490.0);
	} else if ((waveLength >= 510.0) && (waveLength < 580.0)) {
		r = (waveLength - 510.0) / (580.0 - 510.0);
		g = 1.0;
		b = 0.0;
	} else if ((waveLength >= 580.0) && (waveLength < 645.0)) {
		r = 1.0;
		g = -(waveLength - 645.0) / (645.0 - 580.0);
		b = 0.0;
	} else if ((waveLength >= 645.0) && (waveLength < 780.0)) {
		r = 1.0;
		g = 0.0;
		b = 0.0;
	} else
		return BLACK;

	// The intensity fall off near the upper and lower limits
	float factor;
	if ((waveLength >= 380.0) && (waveLength < 420.0))
		factor = 0.3 + 0.7 * (waveLength - 380.0) / (420.0 - 380.0);
	else if ((waveLength >= 420.0) && (waveLength < 700.0))
		factor = 1.0;
	else
		factor = 0.3 + 0.7 * (780.0 - waveLength) / (780.0 - 700.0);

	float3 result = MAKE_FLOAT3(r, g, b) * factor;

	// To normalize the output
	float3 normFactor = MAKE_FLOAT3(1.0 / 0.5652729, 1.0 / 0.36875, 1.0 / 0.265375);

	return result * normFactor;
}

#endif // LUX_MATH_GLSL
