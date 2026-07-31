/**
 * Adaptive live-stream quality controller.
 *
 * The broadcaster's uplink at a gym is the weakest link in the pipeline:
 * a fixed high bitrate freezes the stream whenever the network dips. This
 * controller watches real WebRTC connection stats and walks the encoder up
 * and down a quality ladder so the live picture softens instead of freezing.
 *
 * The local recording is completely unaffected — it captures the canvas at
 * full quality on an independent pipeline (MediaRecorder), so game film
 * stays crisp no matter how rough the live network was.
 *
 * Design notes:
 * - Degradation preference is "maintain-framerate": for basketball, smooth
 *   motion beats sharpness. (The previous fixed setting was
 *   "maintain-resolution", which collapses fps under pressure — that IS the
 *   freeze users see.)
 * - Steps DOWN fast (two bad samples ≈ 6 s) and UP slowly (~21 s of healthy
 *   stats), one rung at a time, with a short cooldown after each change so
 *   we never react to stats measured before the change took effect.
 * - One shared level for all viewers: the uplink is shared, so if any
 *   viewer's connection shows bandwidth trouble the whole encode steps down.
 */

export interface AdaptiveLevel {
  /** Position in the ladder; 0 = full quality. */
  index: number;
  /** Short human label shown in the broadcaster badge. */
  label: string;
  /** Encoder bitrate cap in bits/second. */
  maxBitrate: number;
  /** Divisor applied to the source resolution (1 = native). */
  scaleDown: number;
}

export const QUALITY_LADDER: readonly AdaptiveLevel[] = [
  { index: 0, label: "Full HD", maxBitrate: 6_000_000, scaleDown: 1 },
  { index: 1, label: "High", maxBitrate: 3_500_000, scaleDown: 1 },
  { index: 2, label: "Balanced", maxBitrate: 2_000_000, scaleDown: 1.5 },
  { index: 3, label: "Steady", maxBitrate: 1_200_000, scaleDown: 2 },
  { index: 4, label: "Data saver", maxBitrate: 700_000, scaleDown: 2 },
];

const TICK_MS = 3_000;
/** Consecutive bad ticks before stepping down (1 ≈ 3 s). */
const BAD_TICKS_TO_STEP_DOWN = 1;
/** Consecutive good ticks before stepping up (7 ≈ 21 s). */
const GOOD_TICKS_TO_STEP_UP = 7;
/**
 * Starting quality index. Gym uplinks rarely sustain the top rung (6 Mbps),
 * so begin at "Balanced" (2 Mbps) and let the controller ramp up after ~21 s
 * of healthy stats. This prevents the opening freeze while the encoder is
 * still learning the available bandwidth.
 */
const INITIAL_LEVEL_IDX = 2;
/** Ticks to ignore after a level change (stats lag the encoder). */
const COOLDOWN_TICKS = 2;

const LOSS_BAD = 0.05; // >5% packet loss reported by a viewer
const LOSS_GOOD = 0.02;
const RTT_BAD_SEC = 0.8;
const RTT_GOOD_SEC = 0.4;

interface TickHealth {
  sampled: boolean; // at least one connected peer produced stats
  bad: boolean;
  good: boolean;
}

export class AdaptiveQualityController {
  private levelIdx = INITIAL_LEVEL_IDX;
  private badStreak = 0;
  private goodStreak = 0;
  private cooldown = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;

  constructor(
    private readonly getPeers: () => Map<string, RTCPeerConnection>,
    private readonly onLevelChange?: (level: AdaptiveLevel) => void,
  ) {}

  get currentLevel(): AdaptiveLevel {
    return QUALITY_LADDER[this.levelIdx];
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Apply the current level to a peer connection. Must be called AFTER the
   * offer/answer exchange completes — setParameters silently no-ops before
   * negotiation populates the encodings.
   */
  applyToPeer(pc: RTCPeerConnection): void {
    pc.getSenders().forEach((sender) => {
      if (sender.track?.kind !== "video") return;
      this.applyToSender(sender);
    });
  }

  private applyToSender(sender: RTCRtpSender): void {
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      const level = QUALITY_LADDER[this.levelIdx];
      params.encodings[0].maxBitrate = level.maxBitrate;
      params.encodings[0].scaleResolutionDownBy = level.scaleDown;
      // Smooth motion over sharpness — softening is invisible at gym-stream
      // viewing sizes, but frozen frames are not.
      (params.encodings[0] as { degradationPreference?: string }).degradationPreference =
        "maintain-framerate";
      (params as { degradationPreference?: string }).degradationPreference =
        "maintain-framerate";
      sender.setParameters(params).catch(() => {
        // Some browsers (older iOS Safari) reject scaleResolutionDownBy and
        // fail the WHOLE call. Retry with the bitrate cap alone — that's the
        // part that matters most for congestion relief.
        try {
          const fallback = sender.getParameters();
          if (!fallback.encodings?.length) return;
          fallback.encodings[0].maxBitrate = level.maxBitrate;
          sender.setParameters(fallback).catch(() => {});
        } catch {
          /* give up quietly — stream keeps running at previous settings */
        }
      });
    } catch {
      /* best-effort — older browsers may reject individual fields */
    }
  }

  private applyToAllPeers(): void {
    this.getPeers().forEach((pc) => this.applyToPeer(pc));
  }

  private setLevel(idx: number): void {
    const clamped = Math.max(0, Math.min(QUALITY_LADDER.length - 1, idx));
    if (clamped === this.levelIdx) return;
    this.levelIdx = clamped;
    this.badStreak = 0;
    this.goodStreak = 0;
    this.cooldown = COOLDOWN_TICKS;
    this.applyToAllPeers();
    this.onLevelChange?.(QUALITY_LADDER[this.levelIdx]);
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const health = await this.sampleHealth();
      if (!health.sampled) return; // no connected viewers — nothing to adapt

      if (this.cooldown > 0) {
        this.cooldown -= 1;
        return;
      }

      if (health.bad) {
        this.badStreak += 1;
        this.goodStreak = 0;
        if (this.badStreak >= BAD_TICKS_TO_STEP_DOWN) {
          this.setLevel(this.levelIdx + 1);
        }
      } else if (health.good) {
        this.goodStreak += 1;
        this.badStreak = 0;
        if (this.goodStreak >= GOOD_TICKS_TO_STEP_UP) {
          this.setLevel(this.levelIdx - 1);
        }
      } else {
        // Middling — hold position, decay streaks.
        this.badStreak = 0;
        this.goodStreak = 0;
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  /** Worst-case health across every connected viewer this tick. */
  private async sampleHealth(): Promise<TickHealth> {
    const peers = Array.from(this.getPeers().values()).filter(
      (pc) => pc.connectionState === "connected",
    );
    if (peers.length === 0) return { sampled: false, bad: false, good: false };

    let sampled = false;
    let anyBad = false;
    let allGood = true;

    for (const pc of peers) {
      let stats: RTCStatsReport;
      try {
        stats = await pc.getStats();
      } catch {
        continue;
      }

      let bandwidthLimited = false;
      let fractionLost = 0;
      let rtt = -1;

      stats.forEach((report) => {
        const r = report as unknown as Record<string, unknown>;
        if (r.type === "outbound-rtp" && r.kind === "video") {
          sampled = true;
          if (r.qualityLimitationReason === "bandwidth") bandwidthLimited = true;
        } else if (r.type === "remote-inbound-rtp" && r.kind === "video") {
          if (typeof r.fractionLost === "number") {
            fractionLost = Math.max(fractionLost, r.fractionLost);
          }
          if (typeof r.roundTripTime === "number") {
            rtt = Math.max(rtt, r.roundTripTime);
          }
        }
      });

      const bad =
        bandwidthLimited || fractionLost > LOSS_BAD || (rtt >= 0 && rtt > RTT_BAD_SEC);
      const good =
        !bandwidthLimited &&
        fractionLost < LOSS_GOOD &&
        (rtt < 0 || rtt < RTT_GOOD_SEC);

      if (bad) anyBad = true;
      if (!good) allGood = false;
    }

    return { sampled, bad: anyBad, good: sampled && allGood && !anyBad };
  }
}
