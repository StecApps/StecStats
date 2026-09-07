export interface ProxyChunkBuildPlan {
  requiredChunkCount: number;
  firstMissing: number;
}

/**
 * Targeted reel builds keep one chunk of headroom beyond the final nominal
 * chunk so segments that cross a keyframe-shifted boundary remain complete.
 * Missing chunks after that boundary must never start unrelated encoding.
 */
export function planProxyChunkBuild(
  existFlags: boolean[],
  maxChunkNeeded?: number,
): ProxyChunkBuildPlan {
  const requiredChunkCount =
    maxChunkNeeded == null
      ? existFlags.length
      : Math.min(existFlags.length, Math.max(1, maxChunkNeeded + 2));
  const firstMissing = existFlags
    .slice(0, requiredChunkCount)
    .findIndex((exists) => !exists);
  return { requiredChunkCount, firstMissing };
}