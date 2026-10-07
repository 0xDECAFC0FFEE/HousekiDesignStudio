// The rock's outline in a camera frame, from the frame and the camera's pose over the board
// (T-0325, part of the phone's vision pipeline T-0322; types.js has the hand-offs).
//
//   const finder = createOutlineFinder(canvasOrGl, spec);       // once
//   const outline = finder.find(videoFrame, pose);              // per frame -> RockOutline
//   finder.dispose();
//
// HOW. The HousekiScanner desktop pipeline's Step 3 (src/houseki/pipeline/segment.py), cut down to
// one frame and moved to the GPU: knowing where the camera is, predict what the bare board would
// look like in the frame, and call rock whatever the frame shows that a shadowed, slightly
// misregistered board cannot explain. Per frame:
//
// 1. a crop around the rock's bound: a cylinder standing on the board at the centre target (live
//    there is no carved bound), projected through the pose, grown by a margin and resampled to
//    N x N (256 by default) whatever the frame's resolution;
// 2. on the GPU (outline_shaders.js): each crop pixel's ray meets the board; the board's printed
//    reflectance (board_texture.js) is sampled there, blurred by the lens's defocus at that depth,
//    and put through a tone curve; a local photometric fit I ~ a + b P is made on the board
//    outside the bound and on board inside it that shows the printed pattern; luminance residuals
//    allowing shadows, misregistration and a focus slack, and chroma residuals, are measured; one
//    readback carries them, the frame and the prediction to the CPU;
// 3. on the CPU (outline_mask.js): the residuals' noise is calibrated on a band just outside the
//    bound, z-scores over threshold make the evidence, the components touching the centre target
//    are kept, closed and filled, the outline is moved to the half-rock line
//    (segment.refine_outline), and the largest component's outline is traced and mapped back to
//    the frame's pixels.
//
// ADDED to the desktop's method, each because a single frame with a live bound needed it (the
// shaders' comments have the measurements): the pattern-seen board inside the bound joining the
// photometric fit (a live bound is a coarse cylinder, far wider than the desktop's carved one), the
// tone curve on the print's greys, the focus slack (no per-frame defocus fit), and an optional
// Lucas-Kanade registration of the prediction for rough poses (registerIterations, off by default).
//
// WHAT IT LEAVES OUT from the desktop, and why: everything that needs many views (the board
// anomaly learned across views, the carve's fill and cut, the soft masks) or the video's
// neighbouring frames (the motion cue, step3v2.py); and the per-frame defocus fit (a thin-lens
// model with a default lens constant instead, see `kappaPerF` below: the fit's blur stack and
// correlation windows would cost more than the rest of a frame). The kb article
// phone-rock-outline-from-the-predicted-board has the measurements.
//
// GL STATE. find() uses its own programs, textures and framebuffers and leaves the framebuffer
// binding at null, the viewport changed, and blending, depth and scissor tests off. A context shared
// with other drawing must set its own state again afterwards.

import { renderBoardTexture } from './board_texture.js';
import {
  cameraCentre,
  convexEdges,
  cropAround,
  cylinderPoints,
  projectHull,
  rasterConvex,
  toCamera,
} from './outline_geometry.js';
import {
  FLOOR_CHROMA,
  FLOOR_LUM,
  decodeResiduals,
  evidenceMap,
  largestComponent,
  fillHoles,
  keepCore,
  maskFromEvidence,
  refineOutline,
  noiseModel,
  outlineSupport,
  polygonArea,
  traceOutline,
} from './outline_mask.js';
import {
  BLUR_FS,
  BOX_H_FS,
  BOX_V_FS,
  COPY_FS,
  FULLSCREEN_VS,
  LK_SUM_FS,
  MOMENTS_FS,
  REDUCE4_FS,
  REGISTER_FS,
  PACK_FS,
  PATTERN_FS,
  PREDICT_FS,
  REDUCE_FS,
  RESIDUAL_FS,
  SOLVE_FS,
} from './outline_shaders.js';

/**
 * The finder's options. Lengths in mm are physical; "px" ones are full-resolution pixels at a
 * 1080-pixel short side and scale with the frame (the desktop's convention, its kb article
 * pixel-constants-follow-the-frame-s-short-side).
 */
export const OUTLINE_DEFAULTS = Object.freeze({
  /** Crop side in pixels (a multiple of 16): the resolution the outline is found at. */
  cropSize: 256,
  /** The rock's bound: a cylinder on the board, centred on the target unless given. */
  boundRadiusMm: 16,
  boundHeightMm: 24,
  boundCentreMm: null,
  /** Board kept around the projected bound (segment.CROP_MARGIN_MM is 3). */
  cropMarginMm: 4,
  /** Noise calibration band just outside the bound (segment.BAND_MM). */
  bandMm: 2,
  /** The core a rock must touch: the target's footprint within the bound less coreInsetMm (the
   * desktop's CORE_ERODE_MM), or a disc of coreRadiusMm when the board has no target area. */
  coreInsetMm: 2.5,
  coreRadiusMm: 5,
  /** Board texture density, texels per mm. */
  texturePpm: 10,
  /** Photometric fields: local regression windows (segment.FIELD_NEAR_MM; the far window
   * defaults to max(6 mm, 0.65 x the bound's radius) so it still bridges a bound that is wider
   * than the desktop's carved one). */
  fieldNearMm: 1.5,
  fieldFarMm: null,
  /** Board inside the bound joins the fit where it shows the printed pattern (outline_shaders
   * MOMENTS_FS): local NCC of frame and prediction (segment.DEFOCUS_MIN_NCC) and the prediction's
   * least spread there (0..1; bound.PATTERN_STD_MIN is 15 grey levels). */
  insideNccMin: 0.8,
  insidePatternStd: 0.08,
  /** Shadows (segment.SHADOW_WINDOW_MM, L_MIN, L_MAX, DARK_INK_LEVEL). */
  shadowWindowMm: 2.5,
  lMin: 0.35,
  lMax: 1.1,
  darkInkLevel: 0.45,
  /** Registration slack (segment.SLACK_PX); at least one crop pixel. */
  slackPx: 1.5,
  /** Defocus, sigma(z) = sqrt(s0^2 + kappa^2 (1/z - 1/z_focus)^2) px. s0 is the in-focus blur;
   * kappa the lens constant (px mm), by default kappaPerF x the focal length in pixels: the
   * desktop fitted kappa = 0.74-0.95 f on three phone captures (a thin lens has kappa = A f / 4
   * for an aperture A, ~3.4 mm on a phone's main camera). The camera focuses on the rock: z_focus
   * is the depth of the bound's centre focusHeightMm above the board. */
  s0Px: 0.8,
  kappa: null,
  kappaPerF: 0.85,
  focusHeightMm: 5,
  /** The camera's response to the print: code = (k + (1 - k) reflectance)^(1/gamma), k the ink's
   * reflectance relative to paper (make_board's INK_REFLECTANCE, measured 0.065-0.072 on the
   * reference prints) and gamma about sRGB's. toneGamma 1 compares print levels directly, as the
   * desktop does. */
  inkReflectance: 0.07,
  toneGamma: 2.2,
  /** Registration of the prediction onto the frame (outline_shaders LK_SUM_FS): Lucas-Kanade
   * steps of an affine displacement field fitted on the board outside the bound (0 turns it off),
   * a Cauchy weight's scale (grey level, 0..1) and the largest step per coefficient (crop px).
   * Off by default: each step costs about as much GPU time as the rest of a frame (2-3 ms on an
   * M1 Pro at 256 px), and with desktop-quality poses it gains nothing (real frames: mean IoU
   * 0.946 without, 0.942 with two steps); with a pose 0.3 degrees and 5% in focal length off,
   * two steps took a 20-degree synthetic view from 0.947 to 0.962. Turn it on for rough poses. */
  registerIterations: 0,
  registerHuber: 0.08,
  registerMaxStepPx: 3,
  /** Residual smoothing before the threshold (segment.SMOOTH_PX), full-resolution px at 1080p. */
  smoothPx: 1.5,
  /** Mask clean-up (segment.CLOSE_MM; the speck opening of 1.5 px). */
  closeMm: 0.3,
  openPx: 1.5,
  /** Smaller rocks are not reported (an empty board's noise stays under this). */
  minAreaMm2: 6,
  /** Outline refinement to the half-rock line (segment.refine_outline: REFINE_BAND_PX,
   * REFINE_MIN_CONTRAST grey levels, REFINE_SMOOTH_PX). */
  refine: true,
  refineBandPx: 6,
  refineMinContrast: 12,
  refineSmoothPx: 1,
  /** Keep the crop's intermediate maps on finder.lastDebug. */
  debug: false,
});

/** The desktop's tuning resolution: pixel constants scale with the short side over this. */
const REF_SHORT_SIDE = 1080;

function isGl(target) {
  return typeof WebGL2RenderingContext !== 'undefined' && target instanceof WebGL2RenderingContext;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`outline shader failed to compile: ${log}`);
  }

  return shader;
}

function program(gl, fs) {
  const p = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, vs);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(f);

  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`outline program failed to link: ${gl.getProgramInfoLog(p)}`);
  }

  const locations = new Map();
  return {
    handle: p,
    loc(name) {
      if (!locations.has(name)) {
        locations.set(name, gl.getUniformLocation(p, name));
      }

      return locations.get(name);
    },
  };
}

/**
 * Creates a rock outline finder.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas|WebGL2RenderingContext} glOrCanvas  a WebGL2 context
 *        to run in, or a canvas to create one on (the canvas is not drawn to)
 * @param {object} spec  the board's spec (board_frame.js BOARD_SPECS, houseki.board.v1)
 * @param {Partial<typeof OUTLINE_DEFAULTS>} [options]
 * @returns {{ find: (source: TexImageSource | {data: Uint8Array, width: number, height: number},
 *                    pose: import('./types.js').CameraPose, overrides?: object)
 *                    => import('./types.js').RockOutline,
 *             dispose: () => void, lastDebug: object|null, options: object }}
 */
export function createOutlineFinder(glOrCanvas, spec, options = {}) {
  const opts = { ...OUTLINE_DEFAULTS, ...options };
  const N = opts.cropSize;

  if (N % 16 !== 0 || N < 32) {
    throw new Error(`cropSize must be a multiple of 16 (at least 32), not ${N}`);
  }

  const gl = isGl(glOrCanvas)
    ? glOrCanvas
    : glOrCanvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });

  if (!gl) {
    throw new Error('WebGL2 is not available');
  }

  if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
    throw new Error('the outline needs half-float render targets (EXT_color_buffer_float or _half_float)');
  }

  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');

  const programs = {
    predict: program(gl, PREDICT_FS),
    moments: program(gl, MOMENTS_FS),
    pattern: program(gl, PATTERN_FS),
    blur: program(gl, BLUR_FS),
    reduce: program(gl, REDUCE_FS),
    solve: program(gl, SOLVE_FS),
    boxH: program(gl, BOX_H_FS),
    boxV: program(gl, BOX_V_FS),
    residual: program(gl, RESIDUAL_FS),
    pack: program(gl, PACK_FS),
    lkSum: program(gl, LK_SUM_FS),
    reduce4: program(gl, REDUCE4_FS),
    register: program(gl, REGISTER_FS),
    copy: program(gl, COPY_FS),
  };

  const vao = gl.createVertexArray();
  const textures = [];
  const framebuffers = [];

  function texture(w, h, internal, format, type, filter = gl.NEAREST) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    textures.push(t);
    return t;
  }

  const rgba8 = (w, h) => texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  const rgba16 = (w, h, filter) => texture(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, filter);

  /** A render target over the given textures (several: multiple render targets). */
  function target(list, w, h) {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    list.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`outline framebuffer incomplete (${status})`);
    }

    framebuffers.push(fb);
    return { fb, w, h, buffers: list.map((_, i) => gl.COLOR_ATTACHMENT0 + i) };
  }

  // The board's texture, mipmapped and anisotropically filtered (outline_shaders PREDICT_FS).
  const board = renderBoardTexture(spec, { ppm: opts.texturePpm, linear: true });
  const boardTex = gl.createTexture();
  textures.push(boardTex);
  gl.bindTexture(gl.TEXTURE_2D, boardTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, board.width, board.height, 0, gl.RED, gl.UNSIGNED_BYTE, board.data);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  if (aniso) {
    const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, max));
  }

  // The frame, re-uploaded and mipmapped every find().
  const frameTex = gl.createTexture();
  textures.push(frameTex);
  gl.bindTexture(gl.TEXTURE_2D, frameTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Crop-resolution targets.
  const cropFrame = rgba8(N, N);
  const cropBoard = rgba16(N, N);
  const tPredict = target([cropFrame, cropBoard], N, N);
  const model = rgba16(N, N);
  const sharpModel = rgba16(N, N);
  const model8 = rgba8(N, N);
  const tSolve = target([model, sharpModel, model8], N, N);
  const sums = rgba16(N, N);
  const tBoxH = target([sums], N, N);
  const shadowL = rgba16(N, N);
  const tBoxV = target([shadowL], N, N);
  const residual = rgba16(N, N);
  const tResidual = target([residual], N, N);
  // The readback: residuals, the frame and the prediction side by side (3N x N), so one
  // readPixels (the one that waits for the GPU) carries everything the CPU needs.
  const packed = rgba8(3 * N, N);
  const tPack = target([packed], 3 * N, N);
  const packedBytes = new Uint8Array(3 * N * N * 4);

  // Moments at a quarter of the crop's resolution: raw, blur scratch, near and far windows.
  const Q = N / 4;
  const triple = (filter) => [rgba16(Q, Q, filter), rgba16(Q, Q, filter), rgba16(Q, Q, filter)];
  const momentsRaw = triple();
  const momentsTmp = triple();
  const momentsNear = triple(gl.LINEAR);
  const momentsFar = triple(gl.LINEAR);
  const tMoments = target(momentsRaw, Q, Q);
  const pattern = [rgba16(Q, Q), rgba16(Q, Q)];
  const tPattern = target(pattern, Q, Q);
  const tTmp = target(momentsTmp, Q, Q);
  const tNear = target(momentsNear, Q, Q);
  const tFar = target(momentsFar, Q, Q);

  // The crop-wide moments, by repeated block means down to one texel.
  const reduceChain = [];

  for (let size = Q; size > 1; ) {
    const next = Math.ceil(size / 4);
    const texs = [rgba16(next, next), rgba16(next, next), rgba16(next, next)];
    reduceChain.push({ from: size, to: next, texs, target: target(texs, next, next) });
    size = next;
  }

  // Registration: the affine field (2 x 1, ping-ponged) and the Lucas-Kanade sums (7 textures in
  // two groups, a quarter of the crop's resolution, reduced to one texel). Full floats where the
  // context can render them: the sums are differences of products.
  const floatTargets = !!gl.getExtension('EXT_color_buffer_float');
  const sumTex = (w, h) =>
    floatTargets ? texture(w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT) : rgba16(w, h);
  const warp = [sumTex(2, 1), sumTex(2, 1)];
  const tWarp = [target([warp[0]], 2, 1), target([warp[1]], 2, 1)];
  const lkRaw = [
    [sumTex(Q, Q), sumTex(Q, Q), sumTex(Q, Q), sumTex(Q, Q)],
    [sumTex(Q, Q), sumTex(Q, Q), sumTex(Q, Q), sumTex(Q, Q)],
  ];
  const tLk = [target(lkRaw[0], Q, Q), target(lkRaw[1], Q, Q)];
  const lkChain = [[], []];

  for (const part of [0, 1]) {
    for (let size = Q; size > 1; ) {
      const next = Math.ceil(size / 4);
      const texs = [sumTex(next, next), sumTex(next, next), sumTex(next, next), sumTex(next, next)];
      lkChain[part].push({ from: size, to: next, texs, target: target(texs, next, next) });
      size = next;
    }
  }

  let lastWarp = 0;
  const readback = new Uint8Array(N * N * 4);
  const frameBytes = new Uint8Array(N * N * 4);
  const modelBytes = new Uint8Array(N * N * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  function bindTextures(prog, named) {
    let unit = 0;

    for (const [name, tex] of Object.entries(named)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(prog.loc(name), unit);
      unit += 1;
    }
  }

  function draw(prog, tgt, named, setUniforms, viewport = [0, 0, tgt.w, tgt.h]) {
    gl.useProgram(prog.handle);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fb);
    gl.drawBuffers(tgt.buffers);
    gl.viewport(...viewport);
    bindTextures(prog, named);

    if (setUniforms) {
      setUniforms(prog);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function blurMoments(to, sigma) {
    const radius = Math.min(64, Math.max(0, Math.ceil(3 * sigma)));
    const s = Math.max(sigma, 1e-3);
    const pass = (src, dst, dir) =>
      draw(programs.blur, dst, { uIn0: src[0], uIn1: src[1], uIn2: src[2] }, (p) => {
        gl.uniform2i(p.loc('uDir'), dir[0], dir[1]);
        gl.uniform1f(p.loc('uSigma'), s);
        gl.uniform1i(p.loc('uRadius'), radius);
        gl.uniform2i(p.loc('uSize'), Q, Q);
      });
    pass(momentsRaw, tTmp, [1, 0]);
    pass(momentsTmp, to, [0, 1]);
  }

  /** The intermediate crop maps, as float arrays (debugging only: four more readbacks). */
  function readMaps() {
    const read = (tgt, attachment, floats) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fb);
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
      const out = floats ? new Float32Array(N * N * 4) : new Uint8Array(N * N * 4);
      gl.readPixels(0, 0, N, N, gl.RGBA, floats ? gl.FLOAT : gl.UNSIGNED_BYTE, out);
      return out;
    };
    const maps = {
      frame: read(tPredict, 0, false),
      board: read(tPredict, 1, true),
      model: read(tSolve, 0, true),
      shadow: read(tBoxV, 0, true),
      residual: read(tResidual, 0, true),
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, tWarp[lastWarp].fb);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const wv = new Float32Array(8);
    gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, wv);
    maps.warp = Array.from(wv);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return maps;
  }

  function upload(source) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    if (source && source.data && !(typeof ImageData !== 'undefined' && source instanceof ImageData)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, source.width, source.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.data);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }

    gl.generateMipmap(gl.TEXTURE_2D);
  }

  const finder = {
    options: opts,
    lastDebug: null,
    board,
    gl,

    /**
     * The rock's outline in one frame.
     *
     * @param source  the frame: anything texImage2D takes (video, VideoFrame, ImageBitmap,
     *                ImageData, canvas), or { data: RGBA bytes, width, height }. It must show the
     *                same field of view as pose.intrinsics (any resolution).
     * @param pose    the camera's pose for this frame (pose.js's CameraPose)
     * @param overrides  per-frame option overrides, e.g. { boundCentreMm, boundRadiusMm }
     */
    find(source, pose, overrides = {}) {
      const t0 = performance.now();
      const o = { ...opts, ...overrides };
      const intr = pose.intrinsics;
      const W = intr.width;
      const H = intr.height;
      const s = Math.min(W, H) / REF_SHORT_SIDE;
      const frameInfo = pose.frame ?? { width: W, height: H, timeMs: 0 };
      const empty = (flags, extra = {}) => ({
        frame: frameInfo,
        contour: [],
        box: { x: 0, y: 0, width: 0, height: 0 },
        areaPx: 0,
        confidence: 0,
        elapsedMs: performance.now() - t0,
        flags,
        ...extra,
      });

      // The bound, its projection and the crop.
      const centre = o.boundCentreMm ?? spec.target?.centre_mm ?? [0, 0];
      const R = o.boundRadiusMm;
      const Hb = o.boundHeightMm;
      const hull = projectHull(pose, cylinderPoints(centre, R, Hb));
      const focus = toCamera(pose, [centre[0], centre[1], o.focusHeightMm]);

      if (!hull || !(focus[2] > 0)) {
        return empty(['bound_not_in_front']);
      }

      const pxMmFull = intr.f / focus[2];
      const crop = cropAround(hull, o.cropMarginMm * pxMmFull);
      const d = crop.side / N;
      const pxMm = pxMmFull / d;
      const toCrop = ([x, y]) => [(x - crop.x) / d, (y - crop.y) / d];
      const hullCrop = hull.map(toCrop);

      if (crop.x + crop.side < 0 || crop.y + crop.side < 0 || crop.x > W || crop.y > H) {
        return empty(['bound_outside_frame'], { crop });
      }

      // The GPU half.
      const marks = { start: t0 };
      upload(source);
      marks.upload = performance.now();
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.bindVertexArray(vao);

      const kappa = o.kappa ?? o.kappaPerF * intr.f;
      const edges = convexEdges(hullCrop).slice(0, 64);
      const hullData = new Float32Array(64 * 3);
      edges.forEach((e, i) => hullData.set(e, 3 * i));
      const C = cameraCentre(pose);

      const farMm = o.fieldFarMm ?? Math.max(6, 0.65 * R);

      // The prediction and its photometric fit, under the registration field in warp[w].
      const predictAndFit = (w) => {
        draw(programs.predict, tPredict, { uFrame: frameTex, uBoard: boardTex, uWarp: warp[w] }, (p) => {
          gl.uniform1f(p.loc('uCropSize'), N);
          gl.uniform2f(p.loc('uCropOrigin'), crop.x, crop.y);
          gl.uniform1f(p.loc('uCropScale'), d);
          gl.uniform2f(p.loc('uFrameSize'), W, H);
          gl.uniform1f(p.loc('uF'), intr.f);
          gl.uniform2f(p.loc('uC'), intr.cx, intr.cy);
          gl.uniform1f(p.loc('uK1'), intr.k1 ?? 0);
          // R is row-major; uploaded as column-major it is R^T, the camera-to-board rotation.
          gl.uniformMatrix3fv(p.loc('uRt'), false, new Float32Array(pose.R));
          gl.uniform3f(p.loc('uCam'), C[0], C[1], C[2]);
          gl.uniform2f(p.loc('uBoardOrigin'), board.originMm[0], board.originMm[1]);
          gl.uniform1f(p.loc('uBoardPpm'), board.ppm);
          gl.uniform2f(p.loc('uBoardTexSize'), board.width, board.height);
          gl.uniform3f(p.loc('uDefocus'), o.s0Px * s, kappa, 1 / focus[2]);
          gl.uniform2f(p.loc('uTone'), o.inkReflectance, o.toneGamma);
          gl.uniform3fv(p.loc('uHull'), hullData);
          gl.uniform1i(p.loc('uHullCount'), edges.length);
        });

        draw(programs.pattern, tPattern, { uFrameCrop: cropFrame, uBoardCrop: cropBoard });
        const momentInputs = { uFrameCrop: cropFrame, uBoardCrop: cropBoard, uPat0: pattern[0], uPat1: pattern[1] };
        draw(programs.moments, tMoments, momentInputs, (p) => {
          gl.uniform1f(p.loc('uNccMin'), o.insideNccMin);
          gl.uniform1f(p.loc('uPatternStd'), o.insidePatternStd);
        });
        blurMoments(tNear, (o.fieldNearMm * pxMm) / 4);
        blurMoments(tFar, (farMm * pxMm) / 4);

        let src = momentsRaw;
        for (const step of reduceChain) {
          draw(programs.reduce, step.target, { uIn0: src[0], uIn1: src[1], uIn2: src[2] }, (p) => {
            gl.uniform2i(p.loc('uSize'), step.from, step.from);
            gl.uniform1i(p.loc('uFactor'), 4);
          });
          src = step.texs;
        }

        const solveInputs = {
          uBoardCrop: cropBoard,
          uNear0: momentsNear[0],
          uNear1: momentsNear[1],
          uNear2: momentsNear[2],
          uFar0: momentsFar[0],
          uFar1: momentsFar[1],
          uFar2: momentsFar[2],
          uGlob0: src[0],
          uGlob1: src[1],
          uGlob2: src[2],
        };
        draw(programs.solve, tSolve, solveInputs, (p) => gl.uniform1f(p.loc('uCropSize'), N));
      };

      // Registration: start from no correction, then Lucas-Kanade steps on the affine field,
      // each followed by a new prediction and fit (all on the GPU, no readback).
      gl.bindFramebuffer(gl.FRAMEBUFFER, tWarp[0].fb);
      gl.drawBuffers(tWarp[0].buffers);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      let w = 0;
      predictAndFit(w);

      for (let it = 0; it < o.registerIterations; it += 1) {
        for (const part of [0, 1]) {
          draw(programs.lkSum, tLk[part], { uFrameCrop: cropFrame, uModel: model, uBoardCrop: cropBoard }, (p) => {
            gl.uniform1i(p.loc('uSize'), N);
            gl.uniform1i(p.loc('uPart'), part);
            gl.uniform1f(p.loc('uHuber'), o.registerHuber);
          });
          let srcs = lkRaw[part];
          for (const step of lkChain[part]) {
            draw(programs.reduce4, step.target, { uIn0: srcs[0], uIn1: srcs[1], uIn2: srcs[2], uIn3: srcs[3] }, (p) => {
              gl.uniform2i(p.loc('uSize'), step.from, step.from);
              gl.uniform1i(p.loc('uFactor'), 4);
            });
            srcs = step.texs;
          }
        }
        const s0 = lkChain[0][lkChain[0].length - 1].texs;
        const s1 = lkChain[1][lkChain[1].length - 1].texs;
        draw(programs.register, tWarp[1 - w], { uS0: s0[0], uS1: s0[1], uS2: s0[2], uS3: s0[3], uS4: s1[0], uS5: s1[1], uS6: s1[2], uOld: warp[w] }, (p) => {
          gl.uniform1f(p.loc('uMaxStep'), o.registerMaxStepPx);
        });
        w = 1 - w;
        predictAndFit(w);
      }

      lastWarp = w;

      const shadowK = Math.round(o.shadowWindowMm * pxMm) | 1;
      const shadowR = Math.min(64, (shadowK - 1) / 2);
      draw(programs.boxH, tBoxH, { uFrameCrop: cropFrame, uModel: model }, (p) => {
        gl.uniform1i(p.loc('uRadius'), shadowR);
        gl.uniform1i(p.loc('uSize'), N);
      });
      draw(programs.boxV, tBoxV, { uSums: sums }, (p) => {
        gl.uniform1i(p.loc('uRadius'), shadowR);
        gl.uniform1i(p.loc('uSize'), N);
        gl.uniform2f(p.loc('uLRange'), o.lMin, o.lMax);
      });

      const slack = Math.min(4, Math.max(1, (o.slackPx * s) / d));
      const residualInputs = { uFrameCrop: cropFrame, uBoardCrop: cropBoard, uModel: model, uSharp: sharpModel, uL: shadowL };
      draw(programs.residual, tResidual, residualInputs, (p) => {
        gl.uniform1i(p.loc('uShift'), Math.floor(shadowK / 2));
        gl.uniform1f(p.loc('uSlack'), slack);
        gl.uniform1i(p.loc('uSize'), N);
        gl.uniform1f(p.loc('uLMin'), o.lMin);
        gl.uniform1f(p.loc('uDarkInk'), o.darkInkLevel);
      });
      draw(programs.pack, tPack, { uRes: residual }, (p) => {
        gl.uniform1i(p.loc('uSize'), N);
        gl.uniform1f(p.loc('uSmooth'), (o.smoothPx * s) / d);
      }, [0, 0, N, N]);

      if (o.refine) {
        draw(programs.copy, tPack, { uIn: cropFrame }, (p) => gl.uniform1i(p.loc('uOffset'), N), [N, 0, N, N]);
        draw(programs.copy, tPack, { uIn: model8 }, (p) => gl.uniform1i(p.loc('uOffset'), 2 * N), [2 * N, 0, N, N]);
      }

      if (o.gpuOnly) {
        // Timing only (time_outline.py): the GPU work queued, nothing read back.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindVertexArray(null);
        return null;
      }

      gl.readBuffer(gl.COLOR_ATTACHMENT0);

      if (o.refine) {
        gl.readPixels(0, 0, 3 * N, N, gl.RGBA, gl.UNSIGNED_BYTE, packedBytes);
        const row = 4 * N;

        for (let y = 0; y < N; y += 1) {
          const base = 3 * row * y;
          readback.set(packedBytes.subarray(base, base + row), row * y);
          frameBytes.set(packedBytes.subarray(base + row, base + 2 * row), row * y);
          modelBytes.set(packedBytes.subarray(base + 2 * row, base + 3 * row), row * y);
        }
      } else {
        gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, readback);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindVertexArray(null);
      const tGpu = performance.now();
      marks.gpu = tGpu;

      // The CPU half.
      const res = decodeResiduals(readback, N);
      const inb = rasterConvex(hullCrop, N);
      const outerHull = projectHull(pose, cylinderPoints(centre, R + o.bandMm, Hb + o.bandMm));
      const band = outerHull ? rasterConvex(outerHull.map(toCrop), N) : new Uint8Array(N * N);

      for (let k = 0; k < band.length; k += 1) {
        band[k] = band[k] && !inb[k] && res.valid[k] ? 1 : 0;
      }

      marks.zones = performance.now();
      const lumModel = noiseModel(res.lum, res.grad, res.level, band, FLOOR_LUM);
      const chromaModel = noiseModel(res.chroma, res.grad, res.level, band, FLOOR_CHROMA);
      marks.noise = performance.now();
      const E = evidenceMap(res, lumModel, chromaModel);
      marks.evidence = performance.now();

      const coreHull = projectHull(pose, corePoints(spec, centre, R, o));
      const core = coreHull ? rasterConvex(coreHull.map(toCrop), N) : new Uint8Array(N * N);
      const closePx = Math.round(o.closeMm * pxMm);
      const openPx = Math.round((o.openPx * s) / d);
      const coarse = maskFromEvidence(E, N, core, { closePx, openPx });
      const { raw } = coarse;
      let mask = coarse.mask;
      let refined = 0;

      marks.mask = performance.now();

      if (o.refine && mask.some((v) => v)) {
        const r = refineOutline(mask, frameBytes, modelBytes, res.valid, N, {
          bandPx: (o.refineBandPx * s) / d,
          minContrast: o.refineMinContrast,
          smoothPx: (o.refineSmoothPx * s) / d,
        });
        mask = keepCore(fillHoles(r.mask, N), N, core);
        refined = r.changed;
      }

      marks.refine = performance.now();
      const largest = largestComponent(mask, N);
      const tCpu = performance.now();
      marks.largest = tCpu;

      const debug = o.debug
        ? { crop, d, pxMm, slack, shadowK, kappa, lumModel, chromaModel, residuals: res, E, raw, mask, core, inb, band,
            coarse: coarse.mask, refined,
            gpuMs: tGpu - t0, cpuMs: tCpu - tGpu, marks, maps: o.debugMaps ? readMaps() : null }
        : null;
      finder.lastDebug = debug;

      const flags = [];

      if (!core.some((v) => v)) {
        flags.push('core_not_in_crop');
      }

      if (!largest || largest.area < o.minAreaMm2 * pxMm * pxMm) {
        return empty(flags.concat(['no_rock']), { crop });
      }

      const touches = touchesEdge(largest.mask, N);

      if (touches) {
        flags.push('touches_crop_edge');
      }

      const contourCrop = traceOutline(largest.mask, N);
      const contour = contourCrop.map(([x, y]) => [crop.x + x * d, crop.y + y * d]);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;

      for (const [x, y] of contour) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }

      return {
        frame: frameInfo,
        contour,
        box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
        areaPx: Math.abs(polygonArea(contour)),
        confidence: outlineSupport(largest.mask, raw, N),
        elapsedMs: performance.now() - t0,
        flags,
        crop,
      };
    },

    dispose() {
      for (const t of textures) gl.deleteTexture(t);
      for (const f of framebuffers) gl.deleteFramebuffer(f);
      for (const p of Object.values(programs)) gl.deleteProgram(p.handle);
      gl.deleteVertexArray(vao);
      textures.length = 0;
      framebuffers.length = 0;
    },
  };

  return finder;
}

/**
 * The board points whose projection is the core a rock must touch: the target's footprint on the
 * board (a rock placed on the target covers part of it in every view, since its base stands
 * there), clipped to the bound's base less the inset; or a disc of coreRadiusMm when the board has
 * no target area (the plain and strip boards).
 */
function corePoints(spec, centre, boundRadius, o) {
  const t = spec.target ?? {};
  const [xa, xb] = t.x_range_mm ?? [0, 0];
  const [ya, yb] = t.y_range_mm ?? [0, 0];
  const n = 48;
  const points = [];

  if (xb - xa > 0 && yb - ya > 0) {
    const r = Math.max(o.coreRadiusMm, boundRadius - o.coreInsetMm);

    for (let k = 0; k < n; k += 1) {
      const a = (2 * Math.PI * k) / n;
      const X = Math.min(xb, Math.max(xa, centre[0] + r * Math.cos(a)));
      const Y = Math.min(yb, Math.max(ya, centre[1] + r * Math.sin(a)));
      points.push([X, Y, 0]);
    }
  } else {
    for (let k = 0; k < n; k += 1) {
      const a = (2 * Math.PI * k) / n;
      points.push([centre[0] + o.coreRadiusMm * Math.cos(a), centre[1] + o.coreRadiusMm * Math.sin(a), 0]);
    }
  }

  return points;
}

function touchesEdge(mask, size) {
  for (let i = 0; i < size; i += 1) {
    if (mask[i] || mask[(size - 1) * size + i] || mask[i * size] || mask[i * size + size - 1]) {
      return true;
    }
  }

  return false;
}
