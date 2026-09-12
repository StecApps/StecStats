import { reelProgressText } from '@/lib/reelProgressText';

describe('reelProgressText', () => {
  it('reports durable source-chunk progress', () => {
    expect(reelProgressText({
      progressStage: 'proxy',
      progressCompleted: 2,
      progressTotal: 6,
    })).toBe('Preparing source video · 2 of 6 chunks');
  });

  it('reports completed clip progress', () => {
    expect(reelProgressText({
      progressStage: 'clips',
      progressCompleted: 4,
      progressTotal: 9,
    })).toBe('Building reel · 4 of 9 clips');
  });

  it('does not invent progress when the server has not reported any', () => {
    expect(reelProgressText({
      progressStage: 'proxy',
      progressCompleted: null,
      progressTotal: null,
    })).toBe('Waiting for server progress');
  });
});