/**
 * Basketball seasons run roughly Aug 1 - Jul 31. Free-tier accounts are
 * limited to "current season only" data (see Task #18 spec); this derives
 * the start-of-season cutoff date used to filter games/stats server-side.
 *
 * There's no explicit `season` column on games -- seasons are derived from
 * game date, which is enough to satisfy the free-tier restriction without a
 * schema migration.
 */
export function getCurrentSeasonStartDate(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed; 7 = August
  const seasonStartYear = month >= 7 ? year : year - 1;
  return `${seasonStartYear}-08-01`;
}
