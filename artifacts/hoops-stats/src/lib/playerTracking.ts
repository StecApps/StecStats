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

  if (!lShoulder || !rShoulder || !lElbow || !rElbow || !lWrist || !rWrist) return false;

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
