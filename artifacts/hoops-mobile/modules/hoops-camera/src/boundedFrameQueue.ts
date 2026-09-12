/**
 * Small, deterministic bounded queue used by tests and future native-frame
 * coordination. A capture pipeline must drop frames rather than grow memory
 * without limit. Recording remains the priority; this queue is not used as a
 * recording buffer.
 */
export class BoundedFrameQueue<T> {
  private readonly values: T[] = [];
  private droppedCount = 0;

  public constructor(private readonly capacity: number = 3) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('BoundedFrameQueue capacity must be a positive integer.');
    }
  }

  public enqueue(value: T): void {
    if (this.values.length >= this.capacity) {
      this.values.shift();
      this.droppedCount += 1;
    }
    this.values.push(value);
  }

  public dequeue(): T | undefined {
    return this.values.shift();
  }

  public get size(): number {
    return this.values.length;
  }

  public get dropped(): number {
    return this.droppedCount;
  }

  public clear(): void {
    this.values.length = 0;
  }
}