// Synthetic camera frames of a rock on the printed board, with their exact silhouettes, for the
// rock outline's harness test (T-0325, tests/harness/test_vision_outline.py). Test-only.
//
// A small WebGL2 ray tracer, independent of the outline finder's own model of the board:
//
// - the board: the printed sheet's reflectance (board_texture.js's linear texture at 20 texels per
//   mm, sampled bilinearly with no mipmaps; the supersampling below does the filtering) on z = 0,
//   printed with ink reflectance 0.07 (the scanner's measured ink / paper ratio) and lit by a
//   directional light plus ambient, with a smooth illumination gradient across the sheet;
// - the rock: a convex polyhedron (planes tangent to an ellipsoid, cut flat by the board), either
//   opaque (Lambert), or clear and tinted (refracted in and out, index 1.6, absorption by path
//   length, a Fresnel reflection of a grey sky), standing on the target. It casts a shadow from
//   the directional light, softened by jittering the light over a small disc;
// - the camera: pinhole with radial distortion k1 (the pose agent's model), a thin lens of
//   aperture A focused at a given depth (true depth of field, from aperture samples), lens
//   vignetting, a power-law tone curve (gamma 2.2), 8-bit output with Gaussian noise.
//
// Every pixel averages `samples` rays, jittered over the pixel and the aperture. The alpha
// channel holds the truth: the share of 4 x 4 pinhole rays over the pixel that hit the rock (0..255).

import { renderBoardTexture } from '../../../src/web/src/lib/vision/board_texture.js';

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uBoard;
uniform vec2 uBoardOrigin;
uniform float uBoardPpm;
uniform vec2 uBoardSize;
uniform vec2 uSize;
uniform float uF;
uniform vec2 uC;
uniform float uK1;
uniform mat3 uRt;
uniform vec3 uCam;
uniform float uAperture;
uniform float uFocus;
uniform int uSamples;
uniform vec4 uPlanes[32];
uniform int uPlaneCount;
uniform int uRockKind;      // 0 none, 1 opaque, 2 clear tinted
uniform vec3 uRockColour;   // opaque albedo (linear) or tint per 10 mm (transmittance)
uniform vec3 uLight;        // direction towards the light
uniform float uLightSpread; // radius of the light's disc (radians)
uniform float uAmbient;
uniform vec3 uGradient;     // illumination: 1 + g.x (X - g.z) / 100 + g.y (Y - ...) handled below
uniform vec2 uGradCentre;
uniform float uVignette;
uniform float uExposure;
uniform float uNoise;
uniform int uSeed;
out vec4 outColour;

uint hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float rnd(inout uint s) { s = hash(s); return float(s) / 4294967296.0; }

vec2 undistortN(vec2 xd) {
  vec2 x = xd;
  for (int i = 0; i < 8; i++) x = xd / (1.0 + uK1 * dot(x, x));
  return x;
}

// Ray against the convex rock: entry and exit distances and plane indices; tIn > tOut on a miss.
void rock(vec3 o, vec3 d, out float tIn, out float tOut, out int pIn, out int pOut) {
  tIn = -1e9; tOut = 1e9; pIn = -1; pOut = -1;
  for (int k = 0; k < 32; k++) {
    if (k >= uPlaneCount) break;
    vec3 n = uPlanes[k].xyz;
    float h = uPlanes[k].w;
    float dn = dot(d, n);
    float dist = h - dot(o, n);
    if (abs(dn) < 1e-9) {
      if (dist < 0.0) { tIn = 1e9; tOut = -1e9; return; }
      continue;
    }
    float t = dist / dn;
    if (dn < 0.0) { if (t > tIn) { tIn = t; pIn = k; } }
    else { if (t < tOut) { tOut = t; pOut = k; } }
  }
}

bool hitsRock(vec3 o, vec3 d, out float t, out int plane) {
  float tIn, tOut; int pIn, pOut;
  if (uRockKind == 0) return false;
  rock(o, d, tIn, tOut, pIn, pOut);
  if (tIn <= tOut && tOut > 1e-4) {
    t = max(tIn, 0.0);
    plane = pIn;
    return tIn > 1e-4;
  }
  return false;
}

float illumination(vec2 XY) {
  return 1.0 + uGradient.x * (XY.x - uGradCentre.x) / 100.0 + uGradient.y * (XY.y - uGradCentre.y) / 100.0;
}

// Radiance of the board at a point (no rock in the way of the eye).
vec3 boardRadiance(vec2 XY, inout uint seed) {
  vec2 uv = vec2((XY.y - uBoardOrigin.y) * uBoardPpm / uBoardSize.x, (XY.x - uBoardOrigin.x) * uBoardPpm / uBoardSize.y);
  float x = textureLod(uBoard, uv, 0.0).r;   // reflectance, 0 ink .. 1 paper (linear texture)
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) x = 0.6;  // the table
  float rho = 0.07 + 0.93 * x;
  // The light, jittered over its disc: a soft shadow.
  vec3 l = uLight;
  vec3 a = normalize(cross(l, vec3(0.3, 0.5, 0.8)));
  vec3 b = cross(l, a);
  float r1 = rnd(seed), r2 = rnd(seed);
  l = normalize(l + uLightSpread * sqrt(r1) * (cos(6.2831853 * r2) * a + sin(6.2831853 * r2) * b));
  float t; int pl;
  float lit = hitsRock(vec3(XY, 0.0) + vec3(0.0, 0.0, 1e-3), l, t, pl) ? 0.0 : 1.0;
  float E = illumination(XY) * (uAmbient + (1.0 - uAmbient) * lit * max(l.z, 0.0));
  return vec3(rho * E);
}

vec3 sky(vec3 d) { return vec3(0.55 + 0.25 * d.z); }

vec3 trace(vec3 o, vec3 d, inout uint seed) {
  float t; int pl;
  if (hitsRock(o, d, t, pl)) {
    vec3 p = o + t * d;
    vec3 n = uPlanes[pl].xyz;
    if (uRockKind == 1) {
      float lam = max(dot(n, uLight), 0.0);
      return uRockColour * (uAmbient + (1.0 - uAmbient) * lam) * illumination(p.xy);
    }
    // Clear tinted: Fresnel reflection of the sky, refraction through the rock.
    float eta = 1.0 / 1.6;
    float c = -dot(d, n);
    float F = 0.04 + 0.96 * pow(1.0 - c, 5.0);
    vec3 refl = sky(reflect(d, n));
    vec3 dir = refract(d, n, eta);
    vec3 pos = p;
    vec3 trans = vec3(1.0);
    for (int bounce = 0; bounce < 4; bounce++) {
      float tIn, tOut; int pIn, pOut;
      rock(pos + dir * 1e-3, dir, tIn, tOut, pIn, pOut);
      float len = max(tOut, 0.0) + 1e-3;
      trans *= pow(uRockColour, vec3(len / 10.0));
      pos = pos + dir * len;
      if (pOut < 0) break;
      vec3 nOut = uPlanes[pOut].xyz;
      if (nOut.z < -0.99) {
        // The base: the board under the rock, seen through it.
        return F * refl + (1.0 - F) * trans * boardRadiance(pos.xy, seed);
      }
      vec3 out_ = refract(dir, -nOut, 1.6);
      if (dot(out_, out_) < 1e-6) {
        dir = reflect(dir, -nOut);
        continue;
      }
      dir = out_;
      // Out of the rock: on to the board (or the sky).
      if (dir.z < -1e-4) {
        float tb = -pos.z / dir.z;
        return F * refl + (1.0 - F) * trans * boardRadiance(pos.xy + tb * dir.xy, seed);
      }
      return F * refl + (1.0 - F) * trans * sky(dir);
    }
    return F * refl;
  }
  if (d.z >= -1e-6) return sky(d);
  float tb = -o.z / d.z;
  return boardRadiance(o.xy + tb * d.xy, seed);
}

void main() {
  vec2 pix = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);   // image coordinates, y down
  uint seed = hash(uint(gl_FragCoord.x) * 7919u + uint(gl_FragCoord.y) * 104729u + uint(uSeed) * 15485863u);
  vec3 acc = vec3(0.0);
  int n = uSamples;
  int side = int(sqrt(float(n)));
  for (int s = 0; s < 256; s++) {
    if (s >= n) break;
    vec2 jitter = (vec2(float(s % side), float(s / side)) + vec2(rnd(seed), rnd(seed))) / float(side);
    vec2 q = pix - 0.5 + jitter;
    vec2 xn = undistortN((q - uC) / uF);
    vec3 pf = vec3(xn, 1.0) * uFocus;                       // on the focus plane, camera frame
    float r = 0.5 * uAperture * sqrt(rnd(seed));
    float a = 6.2831853 * rnd(seed);
    vec3 lens = vec3(r * cos(a), r * sin(a), 0.0);
    vec3 dirCam = normalize(pf - lens);
    vec3 o = uCam + uRt * lens;
    vec3 d = normalize(uRt * dirCam);
    acc += trace(o, d, seed);
  }
  vec3 rad = acc / float(n);
  vec2 rn = (pix - uC) / uF;
  rad *= 1.0 - uVignette * dot(rn, rn);

  // Truth: 4 x 4 pinhole rays.
  float cover = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 q = pix - 0.5 + (vec2(float(i), float(j)) + 0.5) / 4.0;
      vec2 xn = undistortN((q - uC) / uF);
      vec3 d = normalize(uRt * vec3(xn, 1.0));
      float t; int pl;
      if (hitsRock(uCam, d, t, pl)) cover += 1.0 / 16.0;
    }
  }

  vec3 code = pow(clamp(uExposure * rad, 0.0, 1.0), vec3(1.0 / 2.2)) * 255.0;
  // Gaussian noise (Box-Muller), per channel.
  for (int c = 0; c < 3; c++) {
    float u1 = max(rnd(seed), 1e-7), u2 = rnd(seed);
    code[c] += uNoise * sqrt(-2.0 * log(u1)) * cos(6.2831853 * u2);
  }
  outColour = vec4(clamp(floor(code + 0.5), 0.0, 255.0) / 255.0, cover);
}`;

/**
 * Planes (n, h) with n . p <= h inside, of a convex rock: planes tangent to an ellipsoid of
 * semi-axes [a, b, c] centred at [X, Y, zc] and turned by `turnDeg` about Z, in `count` directions
 * spread over the sphere (a deterministic jitter makes the facets irregular), plus the board
 * (z >= 0).
 */
export function rockPlanes({ centre, axes, zc, turnDeg = 0, count = 18, seed = 1 }) {
  const [a, b, c] = axes;
  const th = (turnDeg * Math.PI) / 180;
  const planes = [[0, 0, -1, 0]];
  let s = seed * 9301 + 49297;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };

  for (let i = 0; i < count; i += 1) {
    const z = 1 - (2 * (i + 0.5)) / count + 0.15 * (rand() - 0.5);
    const phi = Math.PI * (1 + Math.sqrt(5)) * i + 0.6 * (rand() - 0.5);
    const rr = Math.sqrt(Math.max(0, 1 - z * z));
    // Normal in the rock's own frame, then turned about Z.
    const nl = [rr * Math.cos(phi), rr * Math.sin(phi), Math.max(-1, Math.min(1, z))];
    const len = Math.hypot(...nl);
    const n0 = nl.map((v) => v / len);
    const h = Math.sqrt((a * n0[0]) ** 2 + (b * n0[1]) ** 2 + (c * n0[2]) ** 2);
    const n = [n0[0] * Math.cos(th) - n0[1] * Math.sin(th), n0[0] * Math.sin(th) + n0[1] * Math.cos(th), n0[2]];
    const p = [centre[0], centre[1], zc];
    planes.push([n[0], n[1], n[2], h + n[0] * p[0] + n[1] * p[1] + n[2] * p[2]]);
  }

  return planes;
}

/**
 * A camera looking at `target` (board mm) from `distanceMm` away at an elevation and azimuth
 * (degrees; azimuth 0 looks from -X, towards +X), rolled about its axis by `rollDeg`. Returns
 * { R (row-major, board -> camera), t, center }, OpenCV's camera (x right, y down, z forward).
 */
export function lookAt(target, distanceMm, elevationDeg, azimuthDeg, rollDeg = 0) {
  const e = (elevationDeg * Math.PI) / 180;
  const az = (azimuthDeg * Math.PI) / 180;
  const C = [
    target[0] - distanceMm * Math.cos(e) * Math.cos(az),
    target[1] - distanceMm * Math.cos(e) * Math.sin(az),
    target[2] + distanceMm * Math.sin(e),
  ];
  const norm = (v) => {
    const l = Math.hypot(...v);
    return v.map((x) => x / l);
  };
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const z = norm([target[0] - C[0], target[1] - C[1], target[2] - C[2]]);
  let x = norm(cross(z, [0, 0, 1]));
  let y = cross(z, x);
  const r = (rollDeg * Math.PI) / 180;
  const xr = x.map((v, i) => Math.cos(r) * v + Math.sin(r) * y[i]);
  const yr = y.map((v, i) => -Math.sin(r) * x[i] + Math.cos(r) * v);
  x = xr;
  y = yr;
  const R = [...x, ...y, ...z];
  const t = [
    -(x[0] * C[0] + x[1] * C[1] + x[2] * C[2]),
    -(y[0] * C[0] + y[1] * C[1] + y[2] * C[2]),
    -(z[0] * C[0] + z[1] * C[1] + z[2] * C[2]),
  ];
  return { R, t, center: C };
}

/** A synthetic frame renderer bound to one board spec. */
export function createSynth(spec) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });

  if (!gl) {
    throw new Error('no WebGL2');
  }

  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);

    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s));
    }

    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog));
  }

  const board = renderBoardTexture(spec, { ppm: 20, padMm: 5, linear: true });
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, board.width, board.height, 0, gl.RED, gl.UNSIGNED_BYTE, board.data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const vao = gl.createVertexArray();
  const loc = (n) => gl.getUniformLocation(prog, n);

  /**
   * Renders one frame. scene: { width, height, f, k1, pose: {R, t, center}, aperture (mm),
   * focusMm, samples, rock: null | { kind: 'opaque' | 'clear', colour: [r, g, b], planes },
   * light: [x, y, z] (towards the light), lightSpread, ambient, gradient: [gx, gy], vignette,
   * exposure, noise, seed }. Returns { rgba: Uint8Array (top row first; alpha = truth coverage),
   * width, height }.
   */
  function render(scene) {
    const { width, height } = scene;
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc('uBoard'), 0);
    gl.uniform2f(loc('uBoardOrigin'), board.originMm[0], board.originMm[1]);
    gl.uniform1f(loc('uBoardPpm'), board.ppm);
    gl.uniform2f(loc('uBoardSize'), board.width, board.height);
    gl.uniform2f(loc('uSize'), width, height);
    gl.uniform1f(loc('uF'), scene.f);
    gl.uniform2f(loc('uC'), width / 2, height / 2);
    gl.uniform1f(loc('uK1'), scene.k1 ?? 0);
    gl.uniformMatrix3fv(loc('uRt'), false, new Float32Array(scene.pose.R));
    gl.uniform3fv(loc('uCam'), new Float32Array(scene.pose.center));
    gl.uniform1f(loc('uAperture'), scene.aperture ?? 0);
    gl.uniform1f(loc('uFocus'), scene.focusMm);
    gl.uniform1i(loc('uSamples'), scene.samples ?? 36);
    const planes = scene.rock?.planes ?? [];
    const data = new Float32Array(32 * 4);
    planes.forEach((p, i) => data.set(p, 4 * i));
    gl.uniform4fv(loc('uPlanes'), data);
    gl.uniform1i(loc('uPlaneCount'), planes.length);
    gl.uniform1i(loc('uRockKind'), scene.rock ? (scene.rock.kind === 'clear' ? 2 : 1) : 0);
    gl.uniform3fv(loc('uRockColour'), new Float32Array(scene.rock?.colour ?? [1, 1, 1]));
    const l = scene.light ?? [0.3, -0.4, 0.87];
    const ll = Math.hypot(...l);
    gl.uniform3f(loc('uLight'), l[0] / ll, l[1] / ll, l[2] / ll);
    gl.uniform1f(loc('uLightSpread'), scene.lightSpread ?? 0.05);
    gl.uniform1f(loc('uAmbient'), scene.ambient ?? 0.45);
    gl.uniform3f(loc('uGradient'), ...(scene.gradient ?? [0.15, -0.1]), 0);
    gl.uniform2f(loc('uGradCentre'), ...(scene.gradCentre ?? [85, 115]));
    gl.uniform1f(loc('uVignette'), scene.vignette ?? 0.25);
    gl.uniform1f(loc('uExposure'), scene.exposure ?? 0.95);
    gl.uniform1f(loc('uNoise'), scene.noise ?? 1.5);
    gl.uniform1i(loc('uSeed'), scene.seed ?? 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const raw = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // readPixels returns the bottom row first; the shader drew image row y at gl y = H - 1 - y.
    const rgba = new Uint8Array(raw.length);
    const row = width * 4;

    for (let y = 0; y < height; y += 1) {
      rgba.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    }

    return { rgba, width, height };
  }

  return { render, board, gl };
}
