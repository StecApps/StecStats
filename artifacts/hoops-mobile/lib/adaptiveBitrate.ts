/**
 * adaptiveBitrate.ts
 *
 * Pure state-machine helpers for the 3-rung adaptive bitrate ladder used in
 * createPeerForViewer. Extracted from scorekeeper.tsx so the hysteresis logic
 * can be unit-tested without a live RTCPeerConnection.
 *
 * Ladder (index = rung, lower index = higher quality):
 *   0 → 2 500 000 bps  (full quality, gym wifi nominal)
 *   1 → 1 200 000 bps  (mid quality, moderate congestion)
 *   2 →   600 000 bps  (low quality, heavy loss / high RTT)
 *
 * Step-down trigger : 2 consecutive "bad" polls (RTT > 400 ms OR fractionLost > 5 %)
 * Step-up   trigger : 4 consecutive "clean" polls (both metrics below threshold)
 * Bad resets good streak and vice-versa to prevent oscillation.
 */

export const BITRATE_LADDER = [2_500_000, 1_200_000, 600_000] as const;

/** Thresholds that classify a poll as "bad" network conditions. */
export const RTT_THRESHOLD_S = 0.4;      // 400 ms
export const LOSS_THRESHOLD  = 0.05;     // 5 %

/** Number of consecutive bad polls required before stepping down one rung. */
export const BAD_POLLS_TO_STEP_DOWN = 2;

/** Number of consecutive clean polls required before stepping up one rung. */
export const GOOD_POLLS_TO_STEP_UP = 4;

export interface BitrateState {
  /** Current index into BITRATE_LADDER (0 = highest quality). */
  rung: number;
  badPollStreak: number;
  goodPollStreak: number;
}

export function initialBitrateState(): BitrateState {
  return { rung: 0, badPollStreak: 0, goodPollStreak: 0 };
}

export interface PollMetrics {
  /** Round-trip time in seconds (from remote-inbound-rtp report). */
  rtt: number;
  /** Fraction of packets lost in [0, 1] (from remote-inbound-rtp report). */
  fractionLost: number;
}

export interface NextBitrateResult {
  state: BitrateState;
  /** True when the rung index changed and setParameters() should be called. */
  rungChanged: boolean;
}

/**
 * Pure transition function: given the current hysteresis state and one poll's
 * network metrics, return the next state and whether the rung changed.
 *
 * This function has NO side-effects — it does not touch RTCPeerConnection.
 */
export function nextBitrateState(
  state: BitrateState,
  { rtt, fractionLost }: PollMetrics,
): NextBitrateResult {
  const isBad = rtt > RTT_THRESHOLD_S || fractionLost > LOSS_THRESHOLD;

  let { rung, badPollStreak, goodPollStreak } = state;

  if (isBad) {
    goodPollStreak = 0;
    badPollStreak += 1;
  } else {
    badPollStreak = 0;
    goodPollStreak += 1;
  }

  let newRung = rung;
  if (badPollStreak >= BAD_POLLS_TO_STEP_DOWN && rung < BITRATE_LADDER.length - 1) {
    newRung = rung + 1;
    badPollStreak = 0;
  } else if (goodPollStreak >= GOOD_POLLS_TO_STEP_UP && rung > 0) {
    newRung = rung - 1;
    goodPollStreak = 0;
  }

  return {
    state: { rung: newRung, badPollStreak, goodPollStreak },
    rungChanged: newRung !== rung,
  };
}
