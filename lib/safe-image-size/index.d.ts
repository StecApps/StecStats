export interface ImageSize {
  width: number;
  height: number;
  type?: string;
  orientation?: number;
}

export type ImageSizeCallback = (error: Error | null, result?: ImageSize) => void;

declare function imageSize(
  input: Uint8Array | string,
  callback?: ImageSizeCallback,
): ImageSize | void;

export default imageSize;
export { imageSize };