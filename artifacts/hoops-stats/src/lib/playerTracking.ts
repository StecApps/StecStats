import { ObjectDetector, PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const WASM_PATH =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/latest/efficientdet_lite0.tflite";
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";

let _detector: ObjectDetector | null = null;
let _loadPromise: Promise<ObjectDetector> | null = null;

export async function getObjectDetector(): Promise<ObjectDetector> {
  if (_detector) return _detector;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
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
  })();

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

  _poseLoadPromise = (async () => {
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
    _poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: POSE_MODEL_URL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    return _poseLandmarker;
  })();

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

  // In MediaPipe normalized coords, y=0 is top of frame.
  // "Arm raised" = wrist clearly above shoulder (lower y) AND elbow also elevated.
  const WRIST_RAISE = 0.07;
  const rightArmRaised = rWrist.y < rShoulder.y - WRIST_RAISE && rElbow.y < rShoulder.y + 0.04;
  const leftArmRaised = lWrist.y < lShoulder.y - WRIST_RAISE && lElbow.y < lShoulder.y + 0.04;

  return rightArmRaised || leftArmRaised;
}

export function disposePoseLandmarker() {
  _poseLandmarker?.close();
  _poseLandmarker = null;
  _poseLoadPromise = null;
}
