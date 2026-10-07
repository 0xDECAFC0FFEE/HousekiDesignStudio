// GLSL ES 3.00 shaders of the rock outline's GPU half (T-0325, outline.js runs them). Each is one
// full-screen pass over a small render target: the crop (N x N, 256 by default) or the moments'
// quarter-resolution grid. The method is the HousekiScanner desktop pipeline's Step 3
// (src/houseki/pipeline/segment.py); each shader names the function it ports.
//
// Units: colours and the board albedo are 0..1 here (the desktop's are 0..255); residuals and
// gradients leave in grey levels (0..255 scale) so the noise constants carry over unchanged.

/** The vertex shader of every pass: one triangle covering the viewport. */
export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

/**
 * Pass 1, the prediction (segment.board_points + predict_albedo + the defocus blend), per crop
 * pixel: the full-resolution pixel it stands for, its ray through the lens (k1 inverted by
 * fixed-point iteration), the board point the ray meets (z = 0) and its depth, and the board's
 * albedo there, sampled with the area the crop pixel covers on the board grown by the defocus blur
 * at that depth (thin lens, sigma(z) = sqrt(s0^2 + kappa^2 (1/z - 1/z_focus)^2) full-resolution
 * pixels), then put through a tone curve (uTone = ink reflectance, gamma). The desktop compares
 * the print's grey levels with the frame's directly; with the photometric fit being linear in P,
 * that mispredicts every printed grey that is neither ink nor paper (the target's rings read as
 * rock by ~20 grey levels on synthetic frames), and blurs in the wrong space. The blur is done by the board texture's mipmaps and anisotropic filtering: textureGrad
 * is given the crop pixel's footprint on the board (its Jacobian, by finite differences) scaled
 * by the blur, so an oblique view blurs anisotropically on the board, isotropically in the image.
 * A trilinear lookup over a footprint w blurs by about sigma = w / 2 (a box of w then a tent of w),
 * so w = sqrt(b^2 + (2 sigma / d)^2) crop pixels, b the pixel's own footprint.
 *
 * The frame is sampled with the same footprint (textureGrad on its mipmaps), so both sides of the
 * comparison are filtered alike.
 *
 * out0 (RGBA8): the frame's colour, a = 1 where the crop pixel is inside the frame.
 * out1 (RGBA16F): predicted albedo P (0 ink .. 1 paper, blurred), the same without the defocus,
 *                 board modelled (0/1: the ray meets the board inside the texture, and the frame
 *                 covers the pixel), inside the rock's bound (0/1).
 */
export const PREDICT_FS = `${HEADER}
uniform sampler2D uFrame;
uniform sampler2D uBoard;
uniform vec2 uCropOrigin;
uniform float uCropScale;
uniform vec2 uFrameSize;
uniform float uF;
uniform vec2 uC;
uniform float uK1;
uniform mat3 uRt;
uniform vec3 uCam;
uniform vec2 uBoardOrigin;
uniform float uBoardPpm;
uniform vec2 uBoardTexSize;
uniform vec3 uDefocus;
uniform vec2 uTone;
uniform sampler2D uWarp;
uniform float uCropSize;
uniform vec3 uHull[64];
uniform int uHullCount;
layout(location = 0) out vec4 outFrame;
layout(location = 1) out vec4 outBoard;

vec2 undistortN(vec2 xd) {
  vec2 x = xd;
  for (int i = 0; i < 6; i++) {
    x = xd / (1.0 + uK1 * dot(x, x));
  }
  return x;
}

// Board point (X, Y), depth, hit (1) or miss (0) for a full-resolution image point.
vec4 boardHit(vec2 q) {
  vec2 xn = undistortN((q - uC) / uF);
  vec3 d = uRt * vec3(xn, 1.0);
  float s = -uCam.z / d.z;
  if (!(s > 0.0)) {
    return vec4(0.0);
  }
  return vec4(uCam.xy + s * d.xy, s, 1.0);
}

float tone(float x) {
  float k0 = pow(uTone.x, 1.0 / uTone.y);
  return (pow(uTone.x + (1.0 - uTone.x) * x, 1.0 / uTone.y) - k0) / (1.0 - k0);
}

// Board point (mm) -> board texture coordinates: u along Y, v along X.
vec2 boardUV(vec2 XY) {
  return vec2((XY.y - uBoardOrigin.y) * uBoardPpm / uBoardTexSize.x,
              (XY.x - uBoardOrigin.x) * uBoardPpm / uBoardTexSize.y);
}

void main() {
  vec2 pc = gl_FragCoord.xy;
  vec2 q = uCropOrigin + pc * uCropScale;
  bool inFrame = all(greaterThanEqual(q, vec2(0.0))) && all(lessThan(q, uFrameSize));
  vec2 fuv = q / uFrameSize;
  vec4 I = textureGrad(uFrame, fuv, vec2(uCropScale / uFrameSize.x, 0.0), vec2(0.0, uCropScale / uFrameSize.y));
  outFrame = vec4(I.rgb, inFrame ? 1.0 : 0.0);

  // The registration correction (REGISTER_FS): the prediction for this crop pixel is the board
  // seen at the pixel moved by an affine field u(p), in crop pixels.
  vec3 basis = vec3(1.0, pc / uCropSize * 2.0 - 1.0);
  vec2 u = vec2(dot(texelFetch(uWarp, ivec2(0, 0), 0).xyz, basis), dot(texelFetch(uWarp, ivec2(1, 0), 0).xyz, basis));
  vec2 qb = q + u * uCropScale;
  vec4 h = boardHit(qb);
  vec4 hx = boardHit(qb + vec2(uCropScale, 0.0));
  vec4 hy = boardHit(qb + vec2(0.0, uCropScale));
  float P = 1.0;
  float sharp = 1.0;
  float modelled = 0.0;

  if (h.w > 0.0 && hx.w > 0.0 && hy.w > 0.0) {
    vec2 uv = boardUV(h.xy);
    vec2 dx = boardUV(hx.xy) - uv;
    vec2 dy = boardUV(hy.xy) - uv;
    float blur = uDefocus.y * (1.0 / h.z - uDefocus.z);
    float sigma = sqrt(uDefocus.x * uDefocus.x + blur * blur);
    float base = max(1.0, 1.0 / uCropScale);
    float w = sqrt(base * base + pow(2.0 * sigma / uCropScale, 2.0));
    // The texture is reflectance (linear light), blurred as light is; the camera's tone curve
    // comes after: P = ((k + (1 - k) x)^(1/g) - k^(1/g)) / (1 - k^(1/g)), 0 ink .. 1 paper.
    P = tone(textureGrad(uBoard, uv, dx * w, dy * w).r);
    // The same with no defocus (the pixel's own footprint only): the residuals accept anything
    // between the two (a focus slack: the lens model is a default, not a fit).
    sharp = tone(textureGrad(uBoard, uv, dx * base, dy * base).r);
    bool inTex = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
    modelled = (inTex && inFrame) ? 1.0 : 0.0;
  }

  float inside = 1.0;
  for (int k = 0; k < 64; k++) {
    if (k >= uHullCount) break;
    if (dot(uHull[k].xy, pc) + uHull[k].z < 0.0) {
      inside = 0.0;
      break;
    }
  }
  if (uHullCount < 3) inside = 0.0;

  outBoard = vec4(P, sharp, modelled, inside);
}
`;

/**
 * Pass 2a, the board's pattern seen (bound.pattern_seen, segment.defocus_samples): per 4 x 4 block,
 * the means of g, P, g^2, P^2 and g P (g the frame's grey level) and the share of modelled pixels,
 * from which MOMENTS_FS takes the local normalised cross-correlation of frame and prediction over
 * the 3 x 3 blocks around it.
 */
export const PATTERN_FS = `${HEADER}
uniform sampler2D uFrameCrop;
uniform sampler2D uBoardCrop;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;

void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 4;
  vec4 a = vec4(0.0);
  vec2 c = vec2(0.0);
  for (int k = 0; k < 16; k++) {
    ivec2 p = base + ivec2(k & 3, k >> 2);
    float g = dot(texelFetch(uFrameCrop, p, 0).rgb, vec3(1.0 / 3.0));
    vec4 b = texelFetch(uBoardCrop, p, 0);
    a += vec4(g, b.x, g * g, b.x * b.x);
    c += vec2(g * b.x, b.z);
  }
  out0 = a / 16.0;
  out1 = vec4(c / 16.0, 0.0, 0.0);
}
`;

/**
 * Pass 2b, the photometric fields' moments (segment.photometric_fields), on a grid 4 x coarser than
 * the crop: per 4 x 4 block, the means of w, wP, wP^2, wI and wIP (per channel). w = 1 on board
 * pixels outside the rock's bound, as on the desktop, and also on board pixels inside it whose
 * block shows the printed pattern: frame and prediction correlate (NCC >= uNccMin over the 3 x 3
 * blocks around, about 2.5 mm here) where the prediction has pattern (std >= uPatternStd). The
 * desktop's carved bound is the stone grown by 3 mm, so its far window bridges it; a live bound is
 * a coarse cylinder, which in a low view covers board 80 mm and more behind the rock, where the
 * fields would otherwise only be extrapolated (measured on a quartz frame at 16 degrees: board
 * residuals of 15-45 grey levels there, and the whole background read as rock).
 */
export const MOMENTS_FS = `${HEADER}
uniform sampler2D uFrameCrop;
uniform sampler2D uBoardCrop;
uniform sampler2D uPat0;
uniform sampler2D uPat1;
uniform float uNccMin;
uniform float uPatternStd;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
layout(location = 2) out vec4 out2;

void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  ivec2 qmax = textureSize(uPat0, 0) - 1;
  vec4 a = vec4(0.0);
  vec2 c = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 s = clamp(q + ivec2(i, j), ivec2(0), qmax);
      a += texelFetch(uPat0, s, 0);
      c += texelFetch(uPat1, s, 0).xy;
    }
  }
  a /= 9.0;
  c /= 9.0;
  float vg = a.z - a.x * a.x;
  float vp = a.w - a.y * a.y;
  float ncc = (c.x - a.x * a.y) / sqrt(max(vg * vp, 1e-12));
  float seen = (ncc >= uNccMin && vp >= uPatternStd * uPatternStd && c.y > 0.99) ? 1.0 : 0.0;

  ivec2 base = q * 4;
  vec3 S = vec3(0.0);
  vec3 T0 = vec3(0.0);
  vec3 T1 = vec3(0.0);
  for (int k = 0; k < 16; k++) {
    ivec2 p = base + ivec2(k & 3, k >> 2);
    vec4 f = texelFetch(uFrameCrop, p, 0);
    vec4 b = texelFetch(uBoardCrop, p, 0);
    float w = b.z * max(1.0 - b.w, seen);
    float P = b.x;
    S += w * vec3(1.0, P, P * P);
    T0 += w * f.rgb;
    T1 += w * f.rgb * P;
  }
  out0 = vec4(S / 16.0, 0.0);
  out1 = vec4(T0 / 16.0, 0.0);
  out2 = vec4(T1 / 16.0, 0.0);
}
`;

/** Separable Gaussian blur of the three moment textures along uDir (segment.gauss). */
export const BLUR_FS = `${HEADER}
uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform sampler2D uIn2;
uniform ivec2 uDir;
uniform float uSigma;
uniform int uRadius;
uniform ivec2 uSize;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
layout(location = 2) out vec4 out2;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a0 = vec4(0.0);
  vec4 a1 = vec4(0.0);
  vec4 a2 = vec4(0.0);
  float wsum = 0.0;
  for (int k = -64; k <= 64; k++) {
    if (k < -uRadius || k > uRadius) continue;
    ivec2 s = clamp(p + uDir * k, ivec2(0), uSize - 1);
    float w = exp(-0.5 * float(k * k) / (uSigma * uSigma));
    a0 += w * texelFetch(uIn0, s, 0);
    a1 += w * texelFetch(uIn1, s, 0);
    a2 += w * texelFetch(uIn2, s, 0);
    wsum += w;
  }
  out0 = a0 / wsum;
  out1 = a1 / wsum;
  out2 = a2 / wsum;
}
`;

/** Block mean of the three moment textures (down to the crop-wide moments). */
export const REDUCE_FS = `${HEADER}
uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform sampler2D uIn2;
uniform ivec2 uSize;
uniform int uFactor;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
layout(location = 2) out vec4 out2;

void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * uFactor;
  vec4 a0 = vec4(0.0);
  vec4 a1 = vec4(0.0);
  vec4 a2 = vec4(0.0);
  float n = 0.0;
  for (int j = 0; j < 8; j++) {
    if (j >= uFactor) break;
    for (int i = 0; i < 8; i++) {
      if (i >= uFactor) break;
      ivec2 s = base + ivec2(i, j);
      if (s.x >= uSize.x || s.y >= uSize.y) continue;
      a0 += texelFetch(uIn0, s, 0);
      a1 += texelFetch(uIn1, s, 0);
      a2 += texelFetch(uIn2, s, 0);
      n += 1.0;
    }
  }
  out0 = a0 / max(n, 1.0);
  out1 = a1 / max(n, 1.0);
  out2 = a2 / max(n, 1.0);
}
`;

/**
 * Pass 3, the photometric fields solved (segment.photometric_fields): per channel, I ~ a + b P by
 * Gaussian-weighted local regression on the board outside the bound, ridge-regularised towards the
 * crop-wide fit (a window inside one flat square cannot tell the contrast). Two scales: the near
 * window where at least 30% of it is board, blended into the far one, which bridges across the
 * bound. The desktop's ridge strengths (1e-3 S0 and 0.05 S0) get a small absolute floor here, so a
 * pixel far inside a large bound, where neither window sees board, falls back on the crop-wide fit
 * instead of dividing by a half-float zero.
 *
 * out0 (RGBA16F): the predicted board colour M = a + b P (rgb, 0..1), and the paper's level there
 * (mean over channels of a + b), which the contact-shadow test compares against.
 * out1 (RGBA16F): the grey level of the prediction without defocus (the focus slack's other end).
 * out2 (RGBA8): M again, for the CPU's outline refinement.
 */
export const SOLVE_FS = `${HEADER}
uniform sampler2D uBoardCrop;
uniform sampler2D uNear0;
uniform sampler2D uNear1;
uniform sampler2D uNear2;
uniform sampler2D uFar0;
uniform sampler2D uFar1;
uniform sampler2D uFar2;
uniform sampler2D uGlob0;
uniform sampler2D uGlob1;
uniform sampler2D uGlob2;
uniform float uCropSize;
layout(location = 0) out vec4 outColour;
layout(location = 1) out vec4 outSharp;
layout(location = 2) out vec4 outColour8;

vec2 fit(vec3 S, float T0, float T1, vec2 ab0) {
  float la = 1e-3 * S.x + 1e-4;
  float lb = 0.05 * S.x + 1e-4;
  float m00 = S.x + la;
  float m01 = S.y;
  float m11 = S.z + lb;
  float r0 = T0 + la * ab0.x;
  float r1 = T1 + lb * ab0.y;
  float det = m00 * m11 - m01 * m01;
  float b = (m00 * r1 - m01 * r0) / max(det, 1e-12);
  float a = (r0 - m01 * b) / m00;
  return vec2(a, b);
}

vec2 globalFit(vec3 S, float T0, float T1) {
  float det = S.x * S.z - S.y * S.y;
  if (S.x < 1e-6 || det < 1e-9) {
    return vec2(0.0, 1.0);
  }
  float b = (S.x * T1 - S.y * T0) / det;
  return vec2((T0 - S.y * b) / S.x, b);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 board = texelFetch(uBoardCrop, p, 0).xy;
  float P = board.x;
  vec2 uv = gl_FragCoord.xy / uCropSize;
  vec3 Sn = texture(uNear0, uv).xyz;
  vec3 Tn0 = texture(uNear1, uv).xyz;
  vec3 Tn1 = texture(uNear2, uv).xyz;
  vec3 Sf = texture(uFar0, uv).xyz;
  vec3 Tf0 = texture(uFar1, uv).xyz;
  vec3 Tf1 = texture(uFar2, uv).xyz;
  vec3 Sg = texelFetch(uGlob0, ivec2(0), 0).xyz;
  vec3 Tg0 = texelFetch(uGlob1, ivec2(0), 0).xyz;
  vec3 Tg1 = texelFetch(uGlob2, ivec2(0), 0).xyz;
  float supp = clamp(Sn.x / 0.3, 0.0, 1.0);
  vec3 M;
  float paper = 0.0;
  float sharp = 0.0;
  for (int c = 0; c < 3; c++) {
    vec2 ab0 = globalFit(Sg, Tg0[c], Tg1[c]);
    vec2 n = fit(Sn, Tn0[c], Tn1[c], ab0);
    vec2 f = fit(Sf, Tf0[c], Tf1[c], ab0);
    vec2 ab = supp * n + (1.0 - supp) * f;
    M[c] = ab.x + ab.y * P;
    paper += (ab.x + ab.y) / 3.0;
    sharp += (ab.x + ab.y * board.y) / 3.0;
  }
  outColour = vec4(M, paper);
  outSharp = vec4(sharp, 0.0, 0.0, 0.0);
  outColour8 = vec4(clamp(M, 0.0, 1.0), 1.0);
}
`;

/**
 * Pass 4, the shadow factor's window sums (segment.residuals: L = box(g My) / box(My^2) over a
 * SHADOW_WINDOW_MM window), as two separable box passes. Horizontal: the products from the frame
 * (g = grey) and the prediction (My = grey); vertical: the ratio, clamped to [L_MIN, L_MAX].
 */
export const BOX_H_FS = `${HEADER}
uniform sampler2D uFrameCrop;
uniform sampler2D uModel;
uniform int uRadius;
uniform int uSize;
out vec4 outSums;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 acc = vec2(0.0);
  for (int k = -64; k <= 64; k++) {
    if (k < -uRadius || k > uRadius) continue;
    ivec2 s = ivec2(clamp(p.x + k, 0, uSize - 1), p.y);
    float g = dot(texelFetch(uFrameCrop, s, 0).rgb, vec3(1.0 / 3.0));
    float my = dot(texelFetch(uModel, s, 0).rgb, vec3(1.0 / 3.0));
    acc += vec2(g * my, my * my);
  }
  outSums = vec4(acc / float(2 * uRadius + 1), 0.0, 0.0);
}
`;

export const BOX_V_FS = `${HEADER}
uniform sampler2D uSums;
uniform int uRadius;
uniform int uSize;
uniform vec2 uLRange;
out vec4 outL;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 acc = vec2(0.0);
  for (int k = -64; k <= 64; k++) {
    if (k < -uRadius || k > uRadius) continue;
    ivec2 s = ivec2(p.x, clamp(p.y + k, 0, uSize - 1));
    acc += texelFetch(uSums, s, 0).xy;
  }
  float L = acc.x / max(acc.y, 1e-8);
  outL = vec4(clamp(L, uLRange.x, uLRange.y), 0.0, 0.0, 0.0);
}
`;

/**
 * Pass 5, the residuals (segment.residuals), in grey levels:
 *
 * - luminance: how far the frame's grey level g lies outside [L lo, L hi], where lo and hi are the
 *   prediction's least and greatest grey level within the registration slack (grey erosion and
 *   dilation over a disk), taken over both the defocused prediction and the sharp one (a focus
 *   slack: the desktop fits the defocus per frame; here it is a default lens model, and a thin
 *   printed line, a ring or a dot, mispredicted by a fraction of a pixel of blur, otherwise reads
 *   as rock), and L the shadow factor of the best of the 9 windows around the pixel
 *   (the window centred on it and the 8 a half window away), so a pixel next to the outline is
 *   judged by a window on the board's side. Over predicted ink, any darkening down to L_MIN is
 *   accepted pixel by pixel (thin contact shadows; a rock over ink reads lighter than the ink). The
 *   desktop compares hi with 0.45 x the 99th percentile of the crop's predicted levels; here with
 *   0.45 x the paper's local level from the photometric fit, which needs no reduction and follows
 *   vignetting;
 * - chroma: the CIELAB (a, b) distance between the frame and the shaded prediction L M (sRGB code
 *   values in, as OpenCV's 8-bit conversion). The board is neutral, so blur and misregistration
 *   barely show in chroma, while a tinted rock does;
 * - the prediction's gradient (Sobel / 8 of its grey level), for the noise model's edge term.
 *
 * out (RGBA16F): (luminance residual, chroma residual, gradient, P where the board is modelled
 * else -1).
 */
export const RESIDUAL_FS = `${HEADER}
uniform sampler2D uFrameCrop;
uniform sampler2D uBoardCrop;
uniform sampler2D uModel;
uniform sampler2D uSharp;
uniform sampler2D uL;
uniform int uShift;
uniform float uSlack;
uniform int uSize;
uniform float uLMin;
uniform float uDarkInk;
out vec4 outRes;

float lin(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}

float labF(float t) {
  return t > 0.008856 ? pow(t, 1.0 / 3.0) : 7.787 * t + 16.0 / 116.0;
}

// CIELAB (a, b) of an sRGB colour (0..1), D65, OpenCV's matrix.
vec2 labAB(vec3 c) {
  vec3 l = vec3(lin(clamp(c.r, 0.0, 1.0)), lin(clamp(c.g, 0.0, 1.0)), lin(clamp(c.b, 0.0, 1.0)));
  float X = dot(vec3(0.412453, 0.357580, 0.180423), l) / 0.950456;
  float Y = dot(vec3(0.212671, 0.715160, 0.072169), l);
  float Z = dot(vec3(0.019334, 0.119193, 0.950227), l) / 1.088754;
  float fx = labF(X);
  float fy = labF(Y);
  float fz = labF(Z);
  return vec2(500.0 * (fx - fy), 200.0 * (fy - fz));
}

float greyModel(ivec2 s) {
  s = clamp(s, ivec2(0), ivec2(uSize - 1));
  return 255.0 * dot(texelFetch(uModel, s, 0).rgb, vec3(1.0 / 3.0));
}

float greySharp(ivec2 s) {
  s = clamp(s, ivec2(0), ivec2(uSize - 1));
  return 255.0 * texelFetch(uSharp, s, 0).x;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 b = texelFetch(uBoardCrop, p, 0);
  vec4 model = texelFetch(uModel, p, 0);
  vec3 I = texelFetch(uFrameCrop, p, 0).rgb;
  vec3 M = model.rgb;
  float g = 255.0 * dot(I, vec3(1.0 / 3.0));
  float paper = 255.0 * model.a;

  // Registration slack: the prediction's range within uSlack pixels.
  float lo = 1e9;
  float hi = -1e9;
  int r = int(ceil(uSlack));
  for (int dy = -4; dy <= 4; dy++) {
    if (dy < -r || dy > r) continue;
    for (int dx = -4; dx <= 4; dx++) {
      if (dx < -r || dx > r) continue;
      if (float(dx * dx + dy * dy) > uSlack * uSlack) continue;
      float v = greyModel(p + ivec2(dx, dy));
      float vs = greySharp(p + ivec2(dx, dy));
      lo = min(lo, min(v, vs));
      hi = max(hi, max(v, vs));
    }
  }

  // Shadow factor: the best of the 9 windows around the pixel.
  float best = 1e9;
  float Lused = 1.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 s = clamp(p - ivec2(i, j) * uShift, ivec2(0), ivec2(uSize - 1));
      float Ls = texelFetch(uL, s, 0).x;
      float rs = max(max(g - Ls * hi, Ls * lo - g), 0.0);
      if (rs < best) {
        best = rs;
        Lused = Ls;
      }
    }
  }

  bool darkOk = hi < uDarkInk * paper && g <= hi && g >= uLMin * lo;
  float rLum = darkOk ? 0.0 : best;

  vec2 abI = labAB(I);
  vec2 abM = labAB(clamp(Lused * M, 0.0, 1.0));
  float rChroma = length(abI - abM);

  float gx = (greyModel(p + ivec2(1, -1)) + 2.0 * greyModel(p + ivec2(1, 0)) + greyModel(p + ivec2(1, 1))
            - greyModel(p + ivec2(-1, -1)) - 2.0 * greyModel(p + ivec2(-1, 0)) - greyModel(p + ivec2(-1, 1))) / 8.0;
  float gy = (greyModel(p + ivec2(-1, 1)) + 2.0 * greyModel(p + ivec2(0, 1)) + greyModel(p + ivec2(1, 1))
            - greyModel(p + ivec2(-1, -1)) - 2.0 * greyModel(p + ivec2(0, -1)) - greyModel(p + ivec2(1, -1))) / 8.0;

  outRes = vec4(rLum, rChroma, sqrt(gx * gx + gy * gy), b.z > 0.5 ? b.x : -1.0);
}
`;

/**
 * Pass 6, smoothing and packing for the CPU (segment.frame_cues' SMOOTH_PX): the squared residuals
 * smoothed by a 3 x 3 Gaussian of sigma uSmooth crop pixels over modelled pixels (none under half a
 * pixel: resampling the frame to the crop already smooths it, and every pixel of smoothing grows
 * the outline outwards), then companded into bytes as q = 16 sqrt(r) (r = (q / 16)^2: a quarter of
 * a grey level near the noise floors, up to 254 at the top). Alpha holds the predicted albedo
 * (0..254), or 255 where the board is not modelled.
 */
export const PACK_FS = `${HEADER}
uniform sampler2D uRes;
uniform int uSize;
uniform float uSmooth;
out vec4 outPacked;

float compand(float r) {
  return clamp(floor(16.0 * sqrt(max(r, 0.0)) + 0.5), 0.0, 255.0) / 255.0;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uRes, p, 0);
  if (c.w < 0.0) {
    outPacked = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec2 acc = c.xy * c.xy;
  if (uSmooth >= 0.5) {
    acc = vec2(0.0);
    float wsum = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        ivec2 s = clamp(p + ivec2(i, j), ivec2(0), ivec2(uSize - 1));
        vec4 v = texelFetch(uRes, s, 0);
        if (v.w < 0.0) continue;
        float w = exp(-0.5 * float(i * i + j * j) / (uSmooth * uSmooth));
        acc += w * v.xy * v.xy;
        wsum += w;
      }
    }
    acc /= max(wsum, 1e-6);
  }
  outPacked = vec4(compand(sqrt(acc.x)), compand(sqrt(acc.y)), compand(c.z),
                   floor(clamp(c.w, 0.0, 1.0) * 254.0 + 0.5) / 255.0);
}
`;

/**
 * Registration, step 1: the normal equations of a Lucas-Kanade fit of an affine displacement field
 * u(p) = A [1, x, y] (x, y over the crop in -1..1) that best moves the prediction onto the frame,
 * on the board outside the bound: e = g - My ~ grad(My) . u, with a Cauchy weight on e so the
 * rock's shadow and other surprises do not pull. With J = [gx b, gy b], b = (1, x, y), the normal
 * matrix is made of the three gradient products (gx gx, gx gy, gy gy) times the six basis products
 * (1, x, y, xx, xy, yy), and the right-hand side of (gx e, gy e) times b: 25 sums, accumulated per
 * 4 x 4 block in fixed vectors (an indexed array of them spilled to memory on the Metal backend
 * and made this pass ten times slower), written over two passes of four outputs:
 *
 *   uPart 0: (xx b1, xx b2), (xy b1, xy b2), (yy b1, yy b2), split as four vec4s:
 *            out0 = (gxx 1, gxx x, gxx y, gxx xx), out1 = (gxx xy, gxx yy, gxy 1, gxy x),
 *            out2 = (gxy y, gxy xx, gxy xy, gxy yy), out3 = (gyy 1, gyy x, gyy y, gyy xx)
 *   uPart 1: out0 = (gyy xy, gyy yy, rx 1, rx x), out1 = (rx y, ry 1, ry x, ry y),
 *            out2 = (w, 0, 0, 0), out3 = 0
 *
 * Not in the desktop pipeline, whose poses come from a refined calibration and many corners: a
 * live pose (a guessed or table focal length, fewer corners) misregisters the far board in low
 * views by a few pixels, which no slack covers without also covering the rock's edges.
 */
export const LK_SUM_FS = `${HEADER}
uniform sampler2D uFrameCrop;
uniform sampler2D uModel;
uniform sampler2D uBoardCrop;
uniform int uSize;
uniform int uPart;
uniform float uHuber;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
layout(location = 2) out vec4 out2;
layout(location = 3) out vec4 out3;

float grey(ivec2 s) {
  s = clamp(s, ivec2(0), ivec2(uSize - 1));
  return dot(texelFetch(uModel, s, 0).rgb, vec3(1.0 / 3.0));
}

void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 4;
  vec3 xx1 = vec3(0.0), xx2 = vec3(0.0);
  vec3 xy1 = vec3(0.0), xy2 = vec3(0.0);
  vec3 yy1 = vec3(0.0), yy2 = vec3(0.0);
  vec3 rx = vec3(0.0), ry = vec3(0.0);
  float wsum = 0.0;
  for (int k = 0; k < 16; k++) {
    ivec2 p = base + ivec2(k & 3, k >> 2);
    vec4 b = texelFetch(uBoardCrop, p, 0);
    vec4 f = texelFetch(uFrameCrop, p, 0);
    float w = b.z * (1.0 - b.w) * f.a;
    float gx = (grey(p + ivec2(2, 0)) - grey(p - ivec2(2, 0))) / 4.0;
    float gy = (grey(p + ivec2(0, 2)) - grey(p - ivec2(0, 2))) / 4.0;
    float e = dot(f.rgb, vec3(1.0 / 3.0)) - grey(p);
    w /= 1.0 + (e / uHuber) * (e / uHuber);
    vec2 xy = (vec2(p) + 0.5) / float(uSize) * 2.0 - 1.0;
    vec3 b1 = vec3(1.0, xy.x, xy.y);
    vec3 b2 = vec3(xy.x * xy.x, xy.x * xy.y, xy.y * xy.y);
    xx1 += w * gx * gx * b1; xx2 += w * gx * gx * b2;
    xy1 += w * gx * gy * b1; xy2 += w * gx * gy * b2;
    yy1 += w * gy * gy * b1; yy2 += w * gy * gy * b2;
    rx += w * gx * e * b1;
    ry += w * gy * e * b1;
    wsum += w;
  }
  if (uPart == 0) {
    out0 = vec4(xx1, xx2.x) / 16.0;
    out1 = vec4(xx2.yz, xy1.xy) / 16.0;
    out2 = vec4(xy1.z, xy2) / 16.0;
    out3 = vec4(yy1, yy2.x) / 16.0;
  } else {
    out0 = vec4(yy2.yz, rx.xy) / 16.0;
    out1 = vec4(rx.z, ry) / 16.0;
    out2 = vec4(wsum / 16.0, 0.0, 0.0, 0.0);
    out3 = vec4(0.0);
  }
}
`;

/** Block mean of four textures (the registration sums down to one texel). */
export const REDUCE4_FS = `${HEADER}
uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform sampler2D uIn2;
uniform sampler2D uIn3;
uniform ivec2 uSize;
uniform int uFactor;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
layout(location = 2) out vec4 out2;
layout(location = 3) out vec4 out3;

void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * uFactor;
  vec4 a0 = vec4(0.0);
  vec4 a1 = vec4(0.0);
  vec4 a2 = vec4(0.0);
  vec4 a3 = vec4(0.0);
  float n = 0.0;
  for (int j = 0; j < 8; j++) {
    if (j >= uFactor) break;
    for (int i = 0; i < 8; i++) {
      if (i >= uFactor) break;
      ivec2 s = base + ivec2(i, j);
      if (s.x >= uSize.x || s.y >= uSize.y) continue;
      a0 += texelFetch(uIn0, s, 0);
      a1 += texelFetch(uIn1, s, 0);
      a2 += texelFetch(uIn2, s, 0);
      a3 += texelFetch(uIn3, s, 0);
      n += 1.0;
    }
  }
  out0 = a0 / max(n, 1.0);
  out1 = a1 / max(n, 1.0);
  out2 = a2 / max(n, 1.0);
  out3 = a3 / max(n, 1.0);
}
`;

/**
 * Registration, step 2: solve the 6 x 6 normal equations (lightly damped) and add the step to the
 * affine field, into a 2 x 1 target: texel 0 holds u's x row (a0, a1, a2), texel 1 its y row. The
 * step is clamped to uMaxStep crop pixels per coefficient; with too little board seen, no step.
 */
export const REGISTER_FS = `${HEADER}
uniform sampler2D uS0;
uniform sampler2D uS1;
uniform sampler2D uS2;
uniform sampler2D uS3;
uniform sampler2D uS4;
uniform sampler2D uS5;
uniform sampler2D uS6;
uniform sampler2D uOld;
uniform float uMaxStep;
out vec4 outRow;

// The 3 x 3 matrix of basis products sum(g b_p b_q) from (1, x, y) and (xx, xy, yy) sums.
mat3 basis(vec3 s1, vec3 s2) {
  return mat3(s1.x, s1.y, s1.z,
              s1.y, s2.x, s2.y,
              s1.z, s2.y, s2.z);
}

void main() {
  vec4 a0 = texelFetch(uS0, ivec2(0), 0);
  vec4 a1 = texelFetch(uS1, ivec2(0), 0);
  vec4 a2 = texelFetch(uS2, ivec2(0), 0);
  vec4 a3 = texelFetch(uS3, ivec2(0), 0);
  vec4 c0 = texelFetch(uS4, ivec2(0), 0);
  vec4 c1 = texelFetch(uS5, ivec2(0), 0);
  vec4 c2 = texelFetch(uS6, ivec2(0), 0);
  mat3 Hxx = basis(a0.xyz, vec3(a0.w, a1.xy));
  mat3 Hxy = basis(vec3(a1.zw, a2.x), a2.yzw);
  mat3 Hyy = basis(a3.xyz, vec3(a3.w, c0.xy));
  vec3 rx = vec3(c0.zw, c1.x);
  vec3 ry = c1.yzw;
  float wsum = c2.x;

  // The 6 x 7 augmented system [Hxx Hxy; Hxy Hyy | rx; ry], damped, by Gaussian elimination
  // with partial pivoting (a single pixel's work, so the indexed arrays cost nothing here).
  float A[42];
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
      A[i * 7 + j] = Hxx[i][j];
      A[i * 7 + j + 3] = Hxy[i][j];
      A[(i + 3) * 7 + j] = Hxy[j][i];
      A[(i + 3) * 7 + j + 3] = Hyy[i][j];
    }
    A[i * 7 + 6] = rx[i];
    A[(i + 3) * 7 + 6] = ry[i];
  }
  float trace = 0.0;
  for (int i = 0; i < 6; i++) trace += A[i * 7 + i];
  for (int i = 0; i < 6; i++) A[i * 7 + i] += 1e-3 * trace / 6.0 + 1e-9;
  for (int c = 0; c < 6; c++) {
    int piv = c;
    for (int r = 0; r < 6; r++) {
      if (r > c && abs(A[r * 7 + c]) > abs(A[piv * 7 + c])) piv = r;
    }
    for (int k = 0; k < 7; k++) {
      float t = A[c * 7 + k];
      A[c * 7 + k] = A[piv * 7 + k];
      A[piv * 7 + k] = t;
    }
    float d = A[c * 7 + c];
    if (abs(d) < 1e-20) d = 1e-20;
    for (int r = 0; r < 6; r++) {
      if (r == c) continue;
      float f = A[r * 7 + c] / d;
      for (int k = 0; k < 7; k++) A[r * 7 + k] -= f * A[c * 7 + k];
    }
  }
  bool ok = wsum > 0.02 && trace > 0.0;
  float x[6];
  for (int i = 0; i < 6; i++) {
    x[i] = ok ? clamp(A[i * 7 + 6] / A[i * 7 + i], -uMaxStep, uMaxStep) : 0.0;
  }
  int row = int(gl_FragCoord.x);
  vec4 old = texelFetch(uOld, ivec2(row, 0), 0);
  outRow = row == 0 ? vec4(old.xyz + vec3(x[0], x[1], x[2]), 0.0) : vec4(old.xyz + vec3(x[3], x[4], x[5]), 0.0);
}
`;

/** Copies a crop-sized texture into the readback target at a horizontal offset. */
export const COPY_FS = `${HEADER}
uniform sampler2D uIn;
uniform int uOffset;
out vec4 outColour;

void main() {
  outColour = texelFetch(uIn, ivec2(gl_FragCoord.xy) - ivec2(uOffset, 0), 0);
}
`;
