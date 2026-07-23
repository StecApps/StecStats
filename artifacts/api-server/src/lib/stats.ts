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
  goals?: number;
  shots?: number;
  shotsOffTarget?: number;
  saves?: number;
  yellowCards?: number;
  redCards?: number;
}

export function computePoints(stat: RawStatLine): number {
  return stat.ftMade * 1 + stat.twoMade * 2 + stat.threeMade * 3;
}

export function computeGoals(stat: RawStatLine): number {
  return stat.goals ?? 0;
}

export function safeDiv(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return numerator / denominator;
}
