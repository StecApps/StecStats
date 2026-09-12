import { BoundedFrameQueue } from '../src/boundedFrameQueue';

describe('BoundedFrameQueue', () => {
  it('drops the oldest item at its fixed capacity', () => {
    const queue = new BoundedFrameQueue<number>(3);

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    queue.enqueue(4);

    expect(queue.size).toBe(3);
    expect(queue.dropped).toBe(1);
    expect(queue.dequeue()).toBe(2);
    expect(queue.dequeue()).toBe(3);
    expect(queue.dequeue()).toBe(4);
  });

  it('rejects an unbounded or invalid capacity', () => {
    expect(() => new BoundedFrameQueue(0)).toThrow(RangeError);
    expect(() => new BoundedFrameQueue(1.5)).toThrow(RangeError);
  });
});