import { ObjectDetector, FilesetResolver } from "@mediapipe/tasks-vision";

const WASM_PATH =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/latest/efficientdet_lite0.tflite";

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
): { x: number; y: number } | null {
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
  };
}

export function disposeObjectDetector() {
  _detector?.close();
  _detector = null;
  _loadPromise = null;
}
