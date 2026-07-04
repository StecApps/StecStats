export interface RawStatLine {
  ftMade: number;
  ftAttempted: number;
  twoMade: number;
  twoAttempted: number;
  threeMade: number;
  threeAttempted: number;
  assists: number;
  rebounds: number;
  steals: number;
  turnovers: number;
  blocks: number;
}

export function computePoints(stat: RawStatLine): number {
  return stat.ftMade * 1 + stat.twoMade * 2 + stat.threeMade * 3;
}

export function safeDiv(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return numerator / denominator;
}
