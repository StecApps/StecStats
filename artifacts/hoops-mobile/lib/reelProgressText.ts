export type ReelProgress = {
  progressStage?: 'proxy' | 'clips' | 'finalizing' | 'ready' | null;
  progressCompleted?: number | null;
  progressTotal?: number | null;
};

export function reelProgressText(progress: ReelProgress): string {
  const completed = progress.progressCompleted;
  const total = progress.progressTotal;
  if (progress.progressStage === 'proxy' && completed != null && total != null) {
    return `Preparing source video · ${completed} of ${total} chunks`;
  }
  if (progress.progressStage === 'clips' && completed != null && total != null) {
    return `Building reel · ${completed} of ${total} clips`;
  }
  if (progress.progressStage === 'finalizing') return 'Finalizing video';
  return 'Waiting for server progress';
}