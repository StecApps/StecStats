export type SportId = "basketball" | "soccer";

export type StatCounters = {
  ftMade: number; ftAttempted: number;
  twoMade: number; twoAttempted: number;
  threeMade: number; threeAttempted: number;
  assists: number; rebounds: number; steals: number;
  turnovers: number; blocks: number;
  goals: number;
  shots: number;
  shotsOffTarget: number;
  saves: number;
  yellowCards: number;
  redCards: number;
};

export const EMPTY_STATS: StatCounters = {
  ftMade: 0, ftAttempted: 0,
  twoMade: 0, twoAttempted: 0,
  threeMade: 0, threeAttempted: 0,
  assists: 0, rebounds: 0, steals: 0, turnovers: 0, blocks: 0,
  goals: 0, shots: 0, shotsOffTarget: 0, saves: 0, yellowCards: 0, redCards: 0,
};

export interface QuickAction {
  label: string;
  sublabel?: string;
  field: keyof StatCounters;
  delta: 1 | -1;
  color: string;
  bg: string;
}

export interface SportProfile {
  id: SportId;
  name: string;
  scoreLabel: string;
  computeScore: (s: StatCounters) => number;
  quickActions: QuickAction[];
  primaryStats: { label: string; field: keyof StatCounters }[];
  scoringGroups: {
    label: string;
    madeField: keyof StatCounters;
    attemptedField: keyof StatCounters;
  }[];
  singleStats: { label: string; field: keyof StatCounters }[];
}

export const SPORT_EMOJI: Record<SportId, string> = {
  basketball: "🏀",
  soccer: "⚽",
};

export const BASKETBALL_PROFILE: SportProfile = {
  id: "basketball",
  name: "Basketball",
  scoreLabel: "PTS",
  computeScore: (s) => s.twoMade * 2 + s.threeMade * 3 + s.ftMade,
  quickActions: [
    { label: "2PT", sublabel: "Made",  field: "twoMade",       delta: 1, color: "#fff", bg: "#16a34a" },
    { label: "3PT", sublabel: "Made",  field: "threeMade",     delta: 1, color: "#fff", bg: "#15803d" },
    { label: "FT",  sublabel: "Made",  field: "ftMade",        delta: 1, color: "#fff", bg: "#166534" },
    { label: "2PT", sublabel: "Miss",  field: "twoAttempted",  delta: 1, color: "#fff", bg: "#b91c1c" },
    { label: "3PT", sublabel: "Miss",  field: "threeAttempted",delta: 1, color: "#fff", bg: "#991b1b" },
    { label: "FT",  sublabel: "Miss",  field: "ftAttempted",   delta: 1, color: "#fff", bg: "#7f1d1d" },
    { label: "AST", sublabel: undefined, field: "assists",     delta: 1, color: "#fff", bg: "#1d4ed8" },
    { label: "REB", sublabel: undefined, field: "rebounds",    delta: 1, color: "#fff", bg: "#0e7490" },
    { label: "TO",  sublabel: undefined, field: "turnovers",   delta: 1, color: "#fff", bg: "#c2410c" },
    { label: "STL", sublabel: undefined, field: "steals",      delta: 1, color: "#fff", bg: "#6d28d9" },
    { label: "BLK", sublabel: undefined, field: "blocks",      delta: 1, color: "#fff", bg: "#4338ca" },
  ],
  primaryStats: [
    { label: "REB", field: "rebounds" },
    { label: "AST", field: "assists" },
    { label: "STL", field: "steals" },
  ],
  scoringGroups: [
    { label: "2PT", madeField: "twoMade",   attemptedField: "twoAttempted" },
    { label: "3PT", madeField: "threeMade", attemptedField: "threeAttempted" },
    { label: "FT",  madeField: "ftMade",    attemptedField: "ftAttempted" },
  ],
  singleStats: [
    { label: "REB", field: "rebounds" },
    { label: "AST", field: "assists" },
    { label: "STL", field: "steals" },
    { label: "BLK", field: "blocks" },
    { label: "TO",  field: "turnovers" },
  ],
};

export const SOCCER_PROFILE: SportProfile = {
  id: "soccer",
  name: "Soccer",
  scoreLabel: "G",
  computeScore: (s) => s.goals,
  quickActions: [
    { label: "GOAL",  sublabel: undefined,   field: "goals",         delta: 1, color: "#fff", bg: "#16a34a" },
    { label: "SHOT",  sublabel: "On Target",  field: "shots",         delta: 1, color: "#fff", bg: "#ca8a04" },
    { label: "SHOT",  sublabel: "Off Target", field: "shotsOffTarget",delta: 1, color: "#fff", bg: "#b45309" },
    { label: "AST",   sublabel: undefined,    field: "assists",       delta: 1, color: "#fff", bg: "#1d4ed8" },
    { label: "SAVE",  sublabel: undefined,    field: "saves",         delta: 1, color: "#fff", bg: "#0e7490" },
    { label: "TO",    sublabel: undefined,    field: "turnovers",     delta: 1, color: "#fff", bg: "#c2410c" },
    { label: "YC",    sublabel: "Yellow",     field: "yellowCards",   delta: 1, color: "#000", bg: "#eab308" },
    { label: "RC",    sublabel: "Red",        field: "redCards",      delta: 1, color: "#fff", bg: "#dc2626" },
  ],
  primaryStats: [
    { label: "AST",  field: "assists" },
    { label: "SAVE", field: "saves" },
    { label: "SHT",  field: "shots" },
  ],
  scoringGroups: [
    { label: "SHOT", madeField: "shots", attemptedField: "shotsOffTarget" },
  ],
  singleStats: [
    { label: "GOAL", field: "goals" },
    { label: "AST",  field: "assists" },
    { label: "SAVE", field: "saves" },
    { label: "SHT",  field: "shots" },
    { label: "TO",   field: "turnovers" },
    { label: "YC",   field: "yellowCards" },
    { label: "RC",   field: "redCards" },
  ],
};

export const SPORT_PROFILES: Record<SportId, SportProfile> = {
  basketball: BASKETBALL_PROFILE,
  soccer: SOCCER_PROFILE,
};

export function getSportProfile(sport: string | null | undefined): SportProfile {
  if (sport === "soccer") return SOCCER_PROFILE;
  return BASKETBALL_PROFILE;
}
