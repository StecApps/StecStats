import { ObjectDetector, PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const WASM_PATH =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/latest/efficientdet_lite0.tflite";
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";

const MODEL_LOAD_TIMEOUT_MS = 20_000;

/**
 * Races a promise against a timeout. The underlying model-loading fetches
 * have no built-in timeout, so on flaky/captive-portal networks (e.g.
 * airport wifi) a stalled request can hang forever with no thrown error —
 * this turns that silent hang into a rejection callers can catch and let
 * the user retry.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

let _detector: ObjectDetector | null = null;
let _loadPromise: Promise<ObjectDetector> | null = null;

export async function getObjectDetector(): Promise<ObjectDetector> {
  if (_detector) return _detector;
  if (_loadPromise) return _loadPromise;

  _loadPromise = withTimeout((async () => {
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
    _detector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: "GPU",
      },
      scoreThreshold: 0.4,
      categoryAllowlist: ["person"],
      runningMode: "VIDEO",
    });
    return _detector;
  })(), MODEL_LOAD_TIMEOUT_MS, "Object detector load");

  try {
    return await _loadPromise;
  } catch (err) {
    _loadPromise = null;
    throw err;
  }
}

export function detectPersonCenter(
  det: ObjectDetector,
  videoEl: HTMLVideoElement
): { x: number; y: number; normHeight: number } | null {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (vw === 0 || vh === 0) return null;

  const results = det.detectForVideo(videoEl, performance.now());
  const persons = results.detections;
  if (persons.length === 0) return null;

  const biggest = persons.reduce((a, b) => {
    const aArea = (a.boundingBox?.width ?? 0) * (a.boundingBox?.height ?? 0);
    const bArea = (b.boundingBox?.width ?? 0) * (b.boundingBox?.height ?? 0);
    return aArea >= bArea ? a : b;
  });

  const bb = biggest.boundingBox;
  if (!bb) return null;

  return {
    x: (bb.originX + bb.width / 2) / vw,
    y: (bb.originY + bb.height / 2) / vh,
    normHeight: bb.height / vh,
  };
}

export interface PersonColor { r: number; g: number; b: number; }

let _colorCanvas: HTMLCanvasElement | null = null;
function getColorCanvas(): HTMLCanvasElement {
  if (!_colorCanvas) {
    _colorCanvas = document.createElement("canvas");
    _colorCanvas.width = 8;
    _colorCanvas.height = 8;
  }
  return _colorCanvas;
}

/**
 * Samples the average colour of a player's jersey/torso area from a detected
 * bounding box (the middle-upper portion, avoiding hair/face/shorts and
 * background bleed at the box edges). Used to disambiguate between
 * similar-sized players standing near each other, where position alone isn't
 * enough to tell them apart.
 */
function sampleTorsoColor(
  videoEl: HTMLVideoElement,
  bb: { originX: number; originY: number; width: number; height: number },
): PersonColor | null {
  try {
    const canvas = getColorCanvas();
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const sx = bb.originX + bb.width * 0.3;
    const sy = bb.originY + bb.height * 0.15;
    const sw = bb.width * 0.4;
    const sh = bb.height * 0.4;
    if (sw <= 0 || sh <= 0) return null;
    ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    if (n === 0) return null;
    return { r: r / n, g: g / n, b: b / n };
  } catch {
    return null;
  }
}

function colorDistance(a: PersonColor, b: PersonColor): number {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Exponential blend toward a freshly observed colour, to track gradual lighting
 * changes while staying resistant to a single bad match skewing the signature. */
export function blendColor(prev: PersonColor | null, next: PersonColor | null, alpha = 0.15): PersonColor | null {
  if (!next) return prev;
  if (!prev) return next;
  return {
    r: (1 - alpha) * prev.r + alpha * next.r,
    g: (1 - alpha) * prev.g + alpha * next.g,
    b: (1 - alpha) * prev.b + alpha * next.b,
  };
}

/**
 * Like detectPersonCenter but returns the person whose bounding-box centre is
 * closest to (targetX, targetY) in normalised video coords — used to keep the
 * camera locked on a specific player rather than always following the biggest
 * person in frame. When multiple detections are plausibly close to the last
 * known spot (e.g. two similar-sized players standing near each other),
 * `refColor` — the locked player's running jersey-colour signature — is used
 * to break the tie instead of picking whichever happens to be nearest.
 */
export function detectPersonNear(
  det: ObjectDetector,
  videoEl: HTMLVideoElement,
  targetX: number,
  targetY: number,
  maxDist?: number,
  refColor?: PersonColor | null,
): { x: number; y: number; normHeight: number; color: PersonColor | null } | null {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (vw === 0 || vh === 0) return null;

  const results = det.detectForVideo(videoEl, performance.now());
  const persons = results.detections;
  if (persons.length === 0) return null;

  type Candidate = {
    bb: { originX: number; originY: number; width: number; height: number };
    dist: number;
    color: PersonColor | null;
  };
  const candidates: Candidate[] = [];
  for (const p of persons) {
    const bb = p.boundingBox;
    if (!bb) continue;
    const cx = (bb.originX + bb.width / 2) / vw;
    const cy = (bb.originY + bb.height / 2) / vh;
    const dx = cx - targetX;
    const dy = cy - targetY;
    const dist = dx * dx + dy * dy;
    // Reject implausibly far matches — this prevents the tracker from snapping
    // onto a different (closer-to-stale-target) person when the locked player
    // is briefly occluded or leaves frame, instead of treating it as a miss
    // and letting the caller's re-acquisition logic run.
    if (maxDist !== undefined && dist > maxDist * maxDist) continue;
    candidates.push({ bb, dist, color: null });
  }
  if (candidates.length === 0) return null;

  let best: Candidate;
  if (candidates.length === 1) {
    best = candidates[0];
  } else if (refColor) {
    const radius = Math.max(maxDist ?? 0.16, 0.01);
    let bestScore = Infinity;
    best = candidates[0];
    for (const c of candidates) {
      c.color = sampleTorsoColor(videoEl, c.bb);
      const distNorm = Math.sqrt(c.dist) / radius;
      const colorNorm = c.color ? colorDistance(c.color, refColor) / 255 : 1;
      // Colour mismatch is weighted slightly higher than position — two
      // players standing shoulder-to-shoulder can be nearly equidistant, but
      // jersey colour reliably tells them apart.
      const score = distNorm + colorNorm * 1.2;
      if (score < bestScore) { bestScore = score; best = c; }
    }
  } else {
    best = candidates.reduce((a, b) => (a.dist <= b.dist ? a : b));
  }

  const color = best.color ?? sampleTorsoColor(videoEl, best.bb);
  return {
    x: (best.bb.originX + best.bb.width / 2) / vw,
    y: (best.bb.originY + best.bb.height / 2) / vh,
    normHeight: best.bb.height / vh,
    color,
  };
}

export function disposeObjectDetector() {
  _detector?.close();
  _detector = null;
  _loadPromise = null;
}

/**
 * Persistent state for `updateTracker` below. Deliberately mutated in place
 * by the caller's detection-tick loop (not re-created each tick) so velocity
 * carries over between ticks.
 */
export interface TrackerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  normHeight: number;
  color: PersonColor | null;
  missCount: number;
}

export function createTrackerState(
  x: number,
  y: number,
  normHeight: number,
  color: PersonColor | null,
): TrackerState {
  return { x, y, vx: 0, vy: 0, normHeight, color, missCount: 0 };
}

export interface TrackResult {
  x: number;
  y: number;
  normHeight: number;
  /** False when this tick had no confident fresh detection and the position is coasting on predicted motion instead. */
  matched: boolean;
  /** True once the coast budget is exhausted — caller should treat the lock as lost (hold framing / prompt re-lock) rather than keep guessing. */
  lost: boolean;
}

// Gate candidates against the PREDICTED position (last position + velocity *
// dt), not the last raw observation, so a player who is genuinely moving
// doesn't need an ever-widening radius to stay "found." The radius here is
// intentionally much tighter than the old position-only gate (which grew up
// to 0.32 — nearly a third of the frame — and would happily accept a
// completely different, merely-nearby player once widened).
const TRACK_RADIUS_BASE = 0.10;
const TRACK_RADIUS_GROWTH = 0.02;
const TRACK_RADIUS_MAX = 0.18;

// Reject candidates whose bounding-box height differs too much from the
// locked player's last known height — a same-spot detection that's suddenly
// much bigger/smaller is more likely a different person (or a partial/false
// detection) than the same player changing size within one ~333ms tick.
const TRACK_HEIGHT_TOLERANCE = 0.35;

// Colour is now a tie-breaker, not the primary identity signal — 8x8
// downsampled average RGB from a 3fps sample can never reliably separate two
// teammates in matching jerseys. Position/motion continuity does the heavy
// lifting; colour only nudges the decision when candidates are otherwise close.
const TRACK_COLOR_WEIGHT = 0.5;

// If the best and second-best candidates score too close together, guessing
// is more likely to be wrong than right — treat the tick as ambiguous (a
// miss) instead of confidently locking onto a coin flip.
const TRACK_MIN_SCORE_MARGIN = 0.15;

// How many consecutive ticks (~333ms each, so ~2.7s total) to coast on
// decaying predicted velocity through an occlusion/miss before giving up and
// reporting the lock as lost, rather than keep expanding the search radius
// until it accepts the wrong player.
const TRACK_MAX_COAST_TICKS = 8;
const TRACK_VELOCITY_DECAY = 0.8;

// Sanity ceiling (of ~441 max possible Euclidean RGB distance) beyond which a
// matched candidate's colour is too different from the running signature to
// trust — the position/motion gate can still accept the match (it's the
// player, just under different lighting/motion blur), but we won't blend a
// clearly-wrong sample into the long-lived colour signature, which is what
// previously let one bad frame permanently corrupt future re-identification.
const TRACK_COLOR_SANITY_MAX = 90;

/**
 * Advances the locked-player tracker by one detection tick. Unlike
 * `detectPersonNear`, this owns persistent velocity state so it can predict
 * where the player should be (rather than assuming they're stationary since
 * the last tick), coast smoothly through brief occlusion/misses instead of
 * widening the acceptance radius until it finds ANY nearby person, and
 * requires a confident margin over the next-best candidate before accepting
 * a match. The caller is expected to feed the returned `x`/`y`/`normHeight`
 * into its own frame-rate-independent smoothing (e.g. in a rAF draw loop) —
 * this function does not do any visual smoothing itself, only identity/motion
 * tracking.
 */
/**
 * The region of the raw video frame that is currently visible on the canvas
 * (after crop + zoom). Any person whose centre falls outside this window is
 * not on screen and cannot be the player the user is following — excluding
 * them prevents the tracker from snapping onto a coach/spectator who is
 * physically near the player but outside the zoomed view.
 */
export interface TrackViewport {
  cx: number;   // normalised raw-video X of canvas centre
  cy: number;   // normalised raw-video Y of canvas centre
  zoom: number; // current canvas zoom (1 = no zoom)
}

export function updateTracker(
  det: ObjectDetector,
  videoEl: HTMLVideoElement,
  state: TrackerState,
  dtSeconds: number,
  viewport?: TrackViewport,
): TrackResult | null {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (vw === 0 || vh === 0) return null;

  const dt = Math.max(0.05, Math.min(1, dtSeconds));
  const predX = state.x + state.vx * dt;
  const predY = state.y + state.vy * dt;

  const handleMiss = (): TrackResult => {
    state.missCount += 1;
    if (state.missCount > TRACK_MAX_COAST_TICKS) {
      state.vx = 0;
      state.vy = 0;
      return { x: state.x, y: state.y, normHeight: state.normHeight, matched: false, lost: true };
    }
    // Coast on decaying velocity — keeps reading as "still following, just
    // briefly blind" rather than snapping to whatever's nearest once found.
    state.vx *= TRACK_VELOCITY_DECAY;
    state.vy *= TRACK_VELOCITY_DECAY;
    state.x = predX;
    state.y = predY;
    return { x: state.x, y: state.y, normHeight: state.normHeight, matched: false, lost: false };
  };

  const results = det.detectForVideo(videoEl, performance.now());
  const persons = results.detections;
  if (persons.length === 0) return handleMiss();

  // Scale the search radius to the player's known size. When the player is
  // small in the raw frame (zoomed-out wide-court shot, normHeight ~0.03–0.05),
  // a fixed 10% radius covers far more of the frame than the spacing between
  // nearby players and coaches — shrinking it proportionally to the player's
  // bounding-box height keeps the acceptance window just large enough to
  // catch genuine fast-sprinting motion while rejecting bystanders.
  const sizeRadius = state.normHeight > 0
    ? state.normHeight * 1.5
    : TRACK_RADIUS_BASE;
  const radius = Math.min(
    TRACK_RADIUS_MAX,
    Math.max(sizeRadius, TRACK_RADIUS_BASE * 0.5) + state.missCount * TRACK_RADIUS_GROWTH,
  );

  // Pre-compute viewport edges once (only meaningful when zoom > 1).
  const vpActive = viewport && viewport.zoom > 1.2;
  const vpLeft   = vpActive ? viewport.cx - 0.5 / viewport.zoom : 0;
  const vpRight  = vpActive ? viewport.cx + 0.5 / viewport.zoom : 1;
  const vpTop    = vpActive ? viewport.cy - 0.5 / viewport.zoom : 0;
  const vpBottom = vpActive ? viewport.cy + 0.5 / viewport.zoom : 1;

  type Candidate = {
    bb: { originX: number; originY: number; width: number; height: number };
    cx: number;
    cy: number;
    normHeight: number;
    dist: number;
    color: PersonColor | null;
  };
  const candidates: Candidate[] = [];
  for (const p of persons) {
    const bb = p.boundingBox;
    if (!bb) continue;
    const cx = (bb.originX + bb.width / 2) / vw;
    const cy = (bb.originY + bb.height / 2) / vh;
    const normHeight = bb.height / vh;
    // Viewport gate: when the canvas is zoomed in (zoom > 1.2), anyone whose
    // centre is outside the visible crop window is definitionally off-screen
    // and cannot be the tracked player — reject them before distance/colour
    // scoring so a coach standing just outside the frame edge never steals
    // the lock from the player who is in frame.
    if (vpActive && (cx < vpLeft || cx > vpRight || cy < vpTop || cy > vpBottom)) continue;
    const dist = Math.hypot(cx - predX, cy - predY);
    if (dist > radius) continue;
    if (state.normHeight > 0) {
      const ratio = normHeight / state.normHeight;
      if (ratio < 1 - TRACK_HEIGHT_TOLERANCE || ratio > 1 + TRACK_HEIGHT_TOLERANCE) continue;
    }
    candidates.push({ bb, cx, cy, normHeight, dist, color: null });
  }
  if (candidates.length === 0) return handleMiss();

  let best: Candidate = candidates[0];
  let bestScore = candidates[0].dist / radius;
  let secondScore = Infinity;
  if (candidates.length > 1) {
    bestScore = Infinity;
    for (const c of candidates) {
      c.color = sampleTorsoColor(videoEl, c.bb);
      const distNorm = c.dist / radius;
      const colorNorm = state.color && c.color ? colorDistance(c.color, state.color) / 255 : 0.5;
      const score = distNorm + colorNorm * TRACK_COLOR_WEIGHT;
      if (score < bestScore) {
        secondScore = bestScore;
        bestScore = score;
        best = c;
      } else if (score < secondScore) {
        secondScore = score;
      }
    }
    if (secondScore - bestScore < TRACK_MIN_SCORE_MARGIN) {
      // Too close to call — don't guess between two plausible players.
      return handleMiss();
    }
  }

  const color = best.color ?? sampleTorsoColor(videoEl, best.bb);
  const colorDist = state.color && color ? colorDistance(color, state.color) : null;

  const vx = (best.cx - state.x) / dt;
  const vy = (best.cy - state.y) / dt;
  // EMA the velocity estimate itself — a single tick's positional noise
  // shouldn't fully overwrite the motion model used to predict next tick's
  // search position.
  state.vx = state.vx * 0.5 + vx * 0.5;
  state.vy = state.vy * 0.5 + vy * 0.5;
  state.x = best.cx;
  state.y = best.cy;
  state.normHeight = best.normHeight;
  state.missCount = 0;
  if (color && (colorDist === null || colorDist < TRACK_COLOR_SANITY_MAX)) {
    state.color = blendColor(state.color, color);
  }

  return { x: state.x, y: state.y, normHeight: state.normHeight, matched: true, lost: false };
}

let _poseLandmarker: PoseLandmarker | null = null;
let _poseLoadPromise: Promise<PoseLandmarker> | null = null;

export async function getPoseLandmarker(): Promise<PoseLandmarker> {
  if (_poseLandmarker) return _poseLandmarker;
  if (_poseLoadPromise) return _poseLoadPromise;

  _poseLoadPromise = withTimeout((async () => {
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
    // CPU delegate (not GPU): the auto-follow ObjectDetector already holds a GPU
    // delegate context, and running two GPU-delegated tasks-vision models at once
    // silently fails detectForVideo() calls on one or both of them (no thrown
    // error surfaces to the UI — shot detection just stops firing). Shot
    // detection only samples once/second, so CPU is plenty fast here and avoids
    // the contention entirely.
    _poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: POSE_MODEL_URL,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    return _poseLandmarker;
  })(), MODEL_LOAD_TIMEOUT_MS, "Pose landmarker load");

  try {
    return await _poseLoadPromise;
  } catch (err) {
    _poseLoadPromise = null;
    throw err;
  }
}

// Minimum per-landmark visibility score (MediaPipe's own confidence that a
// given joint is actually present/visible at its reported coordinates, 0-1)
// required before trusting that joint for the raise heuristic below.
const MIN_LANDMARK_VISIBILITY = 0.6;

// How aligned the hip->shoulder vector must be with the assumed "up" axis
// (dot product of unit vectors) before we even consider evaluating an arm
// raise. 0.5 ~= torso within ~60 degrees of upright. This is what stops the
// heuristic from firing on someone lying down, sitting reclined, etc., where
// "wrist above shoulder" in raw frame coordinates no longer means "arm raised
// relative to the body."
const MIN_TORSO_UPRIGHTNESS = 0.5;

export function detectShotPose(
  landmarker: PoseLandmarker,
  videoEl: HTMLVideoElement
): boolean {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (vw === 0 || vh === 0) return false;

  const results = landmarker.detectForVideo(videoEl, performance.now());
  if (!results.landmarks || results.landmarks.length === 0) return false;

  const lm = results.landmarks[0];
  const lShoulder = lm[11];
  const rShoulder = lm[12];
  const lElbow = lm[13];
  const rElbow = lm[14];
  const lWrist = lm[15];
  const rWrist = lm[16];
  const lHip = lm[23];
  const rHip = lm[24];

  if (!lShoulder || !rShoulder || !lElbow || !rElbow || !lWrist || !rWrist || !lHip || !rHip) {
    return false;
  }

  // The lite pose model still returns 33 landmarks even when it isn't
  // actually looking at a person (e.g. the camera panned off the subject
  // onto furniture/background clutter during auto-follow) -- overall pose
  // presence can clear the model's default 0.5 threshold on a plausible-ish
  // blob while individual joints are still near-zero confidence. Reject the
  // frame outright if any of the joints we depend on aren't trustworthy,
  // rather than letting noisy coordinates satisfy the raise geometry below.
  const joints = [lShoulder, rShoulder, lElbow, rElbow, lWrist, rWrist, lHip, rHip];
  if (joints.some(j => (j.visibility ?? 0) < MIN_LANDMARK_VISIBILITY)) return false;

  // The raise heuristic below only makes sense for someone in a roughly
  // upright stance (standing, jumping, driving to the hoop) -- it compares
  // wrist position to shoulder position along the device's physical "up"
  // axis, which silently breaks down for anyone lying/reclining in frame
  // (e.g. resting on a bed): normal resting arm positions near the head can
  // register as "wrist above shoulder" even though nothing basketball-like
  // is happening. Guard against this by requiring the hip->shoulder vector
  // to actually point toward the assumed "up" direction before proceeding.
  const shoulderMidX = (lShoulder.x + rShoulder.x) / 2;
  const shoulderMidY = (lShoulder.y + rShoulder.y) / 2;
  const hipMidX = (lHip.x + rHip.x) / 2;
  const hipMidY = (lHip.y + rHip.y) / 2;
  const torsoX = shoulderMidX - hipMidX;
  const torsoY = shoulderMidY - hipMidY;
  const torsoLen = Math.hypot(torsoX, torsoY);
  if (torsoLen < 1e-4) return false;

  // The pose landmarker always runs on the raw camera video element, which iOS
  // reports in portrait orientation (videoWidth < videoHeight) regardless of
  // how the device is physically held.  In portrait raw coordinates, y=0 is
  // the top of the frame.  In landscape mode, however, the physical "up"
  // direction maps to the portrait x-axis, so we must check x-displacement
  // rather than y-displacement for arm raises.
  const deviceIsLandscape = window.innerWidth > window.innerHeight;

  if (deviceIsLandscape) {
    // In landscape mode the camera still delivers portrait-oriented pixels, so
    // physical "up" maps to the portrait x-axis.  We must determine WHICH
    // x-direction is "up" from the orientation API — checking both directions
    // simultaneously caused too many false positives.
    //   screen.orientation.angle 90  = landscape-left  → up = portrait +x (right)
    //   screen.orientation.angle 270 = landscape-right → up = portrait -x (left)
    //   window.orientation -90 = landscape-left  → up = +x
    //   window.orientation  90 = landscape-right → up = -x
    let upIsPortraitRight = true;
    if (typeof screen !== "undefined" && screen.orientation?.angle != null) {
      upIsPortraitRight = screen.orientation.angle !== 270;
    } else if (typeof (window as any).orientation === "number") {
      upIsPortraitRight = (window as any).orientation !== 90;
    }

    // Up = portrait +x or -x depending on orientation; check the torso is
    // actually aligned with that axis (not lying across the frame) before
    // trusting the raise geometry below.
    const upDotTorso = upIsPortraitRight ? torsoX / torsoLen : -torsoX / torsoLen;
    if (upDotTorso < MIN_TORSO_UPRIGHTNESS) return false;

    // Use a higher threshold for the x-axis — casual sideways movement is more
    // common than raising an arm vertically, so we need a bigger margin.
    const LANDSCAPE_RAISE = 0.12;

    if (upIsPortraitRight) {
      // Physical "up" = portrait right (+x). Arm raised = wrist clearly to the
      // right of the shoulder AND elbow at or past shoulder level.
      const rightArmRaised = rWrist.x > rShoulder.x + LANDSCAPE_RAISE && rElbow.x > rShoulder.x;
      const leftArmRaised  = lWrist.x > lShoulder.x + LANDSCAPE_RAISE && lElbow.x > lShoulder.x;
      return rightArmRaised || leftArmRaised;
    } else {
      // Physical "up" = portrait left (-x).
      const rightArmRaised = rWrist.x < rShoulder.x - LANDSCAPE_RAISE && rElbow.x < rShoulder.x;
      const leftArmRaised  = lWrist.x < lShoulder.x - LANDSCAPE_RAISE && lElbow.x < lShoulder.x;
      return rightArmRaised || leftArmRaised;
    }
  }

  // Portrait mode: up = -y. Same torso-alignment guard as the landscape branch.
  const upDotTorsoPortrait = -torsoY / torsoLen;
  if (upDotTorsoPortrait < MIN_TORSO_UPRIGHTNESS) return false;

  // Portrait mode: y=0 is top; "arm raised" = wrist clearly above shoulder.
  const RAISE = 0.07;
  const rightArmRaised = rWrist.y < rShoulder.y - RAISE && rElbow.y < rShoulder.y + 0.04;
  const leftArmRaised  = lWrist.y < lShoulder.y - RAISE && lElbow.y < lShoulder.y + 0.04;
  return rightArmRaised || leftArmRaised;
}

export function disposePoseLandmarker() {
  _poseLandmarker?.close();
  _poseLandmarker = null;
  _poseLoadPromise = null;
}
