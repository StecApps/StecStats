import { useEffect, useRef, useState, useCallback, RefObject } from "react";
import { Play, Filter } from "lucide-react";

interface FilmRoomEvent {
  playerId: number;
  statField: string;
  delta: number;
  videoTimestampMs: number | null;
}

interface FilmRoomPlayer {
  id: number;
  name: string;
}

interface FilmRoomProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  events: FilmRoomEvent[];
  players: FilmRoomPlayer[];
  videoOffsetMs?: number;
  /** True length of the stored video file in ms (server-probed). Used to
   *  flag stats that happened after the recording stopped and as a duration
   *  fallback for live-recorded WebM where video.duration is Infinity. */
  videoDurationMs?: number | null;
  /** Recording-clock ms where the second half begins, for repaired two-half
   *  videos whose halftime gap was removed when stitching. */
  videoHalf2StartMs?: number | null;
  /** Length of the removed halftime gap in ms. Second-half event timestamps
   *  must subtract this to map onto the stitched video timeline. */
  videoHalftimeGapMs?: number | null;
}

const STAT_LABELS: Record<string, string> = {
  ftMade: "FT Made", ftAttempted: "FT Miss",
  twoMade: "2PT Made", twoAttempted: "2PT Miss",
  threeMade: "3PT Made", threeAttempted: "3PT Miss",
  assists: "Assist", rebounds: "Rebound",
  steals: "Steal", turnovers: "Turnover", blocks: "Block",
};

const CATEGORIES = [
  { key: "all",      label: "All",      color: "#9ca3af", fields: [] as string[] },
  { key: "made",     label: "Made",     color: "#22c55e", fields: ["twoMade", "threeMade", "ftMade"] },
  { key: "missed",   label: "Missed",   color: "#ef4444", fields: ["twoAttempted", "threeAttempted", "ftAttempted"] },
  { key: "assist",   label: "Assists",  color: "#3b82f6", fields: ["assists"] },
  { key: "rebound",  label: "Rebounds", color: "#06b6d4", fields: ["rebounds"] },
  { key: "steal",    label: "Steals",   color: "#a855f7", fields: ["steals"] },
  { key: "block",    label: "Blocks",   color: "#6366f1", fields: ["blocks"] },
  { key: "turnover", label: "TOs",      color: "#f97316", fields: ["turnovers"] },
] as const;

function getEventColor(statField: string): string {
  for (const cat of CATEGORIES) {
    if (cat.fields.includes(statField as never)) return cat.color;
  }
  return "#9ca3af";
}

function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function FilmRoom({ videoRef, events, players, videoOffsetMs = 0, videoDurationMs = null, videoHalf2StartMs = null, videoHalftimeGapMs = null }: FilmRoomProps) {
  const [mediaDuration, setMediaDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeFilter, setActiveFilter] = useState("all");
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Live-recorded WebM reports duration = Infinity — treat that as unknown.
    const readDuration = () => {
      const d = video.duration;
      setMediaDuration(Number.isFinite(d) && d > 0 ? d : 0);
    };
    const onTime = () => setCurrentTime(video.currentTime);
    video.addEventListener("loadedmetadata", readDuration);
    video.addEventListener("durationchange", readDuration);
    video.addEventListener("timeupdate", onTime);
    if (video.readyState >= 1) readDuration();
    return () => {
      video.removeEventListener("loadedmetadata", readDuration);
      video.removeEventListener("durationchange", readDuration);
      video.removeEventListener("timeupdate", onTime);
    };
  }, [videoRef]);

  // Prefer the browser-reported duration; fall back to the server-probed one.
  const duration = mediaDuration > 0
    ? mediaDuration
    : (videoDurationMs != null && videoDurationMs > 0 ? videoDurationMs / 1000 : 0);

  // The end of the actual footage, in video-time seconds. Prefer the
  // server-probed value (authoritative even when the browser can't tell).
  const filmEndSec = videoDurationMs != null && videoDurationMs > 0
    ? videoDurationMs / 1000
    : (mediaDuration > 0 ? mediaDuration : null);

  // Convert an event's recording-clock timestamp to a position on the video
  // timeline. Mirrors the server's buildSegments math: for repaired two-half
  // videos the stitched file has the halftime gap removed, so second-half
  // events must subtract that gap on top of the start offset.
  const toVideoSec = useCallback((videoTimestampMs: number): number => {
    const gapAdj =
      videoHalf2StartMs != null && videoHalftimeGapMs != null && videoTimestampMs >= videoHalf2StartMs
        ? videoHalftimeGapMs
        : 0;
    return (videoTimestampMs - videoOffsetMs - gapAdj) / 1000;
  }, [videoOffsetMs, videoHalf2StartMs, videoHalftimeGapMs]);

  const isOffFilm = useCallback((ev: FilmRoomEvent): boolean => {
    if (filmEndSec == null || ev.videoTimestampMs == null) return false;
    return toVideoSec(ev.videoTimestampMs) >= filmEndSec;
  }, [filmEndSec, toVideoSec]);

  const validEvents = events
    .map((ev, origIdx) => ({ ...ev, origIdx }))
    .filter(ev => ev.videoTimestampMs != null && toVideoSec(ev.videoTimestampMs) >= 0)
    .sort((a, b) => (a.videoTimestampMs! - b.videoTimestampMs!));

  const offFilmCount = validEvents.filter(isOffFilm).length;

  const filteredEvents = activeFilter === "all"
    ? validEvents
    : validEvents.filter(ev => {
        const cat = CATEGORIES.find(c => c.key === activeFilter);
        return cat ? (cat.fields as readonly string[]).includes(ev.statField) : true;
      });

  const seekTo = useCallback((ev: FilmRoomEvent) => {
    const video = videoRef.current;
    if (!video || ev.videoTimestampMs == null) return;
    if (isOffFilm(ev)) return; // no footage exists for this moment
    const sec = Math.max(0, toVideoSec(ev.videoTimestampMs) - 8);
    video.currentTime = sec;
    video.play().catch(() => {});
  }, [videoRef, toVideoSec, isOffFilm]);

  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = pct * duration;
  }, [videoRef, duration]);

  const currentEventIdx = filteredEvents.findLastIndex(
    ev => ev.videoTimestampMs != null && toVideoSec(ev.videoTimestampMs) <= currentTime + 8
  );

  useEffect(() => {
    if (activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [currentEventIdx]);

  const playPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  if (validEvents.length === 0) return null;

  return (
    <div className="mt-4 border border-border/60 rounded-xl overflow-hidden bg-card/30">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40 bg-card/60">
        <Play className="w-4 h-4 text-primary" />
        <span className="font-semibold text-sm">Film Room</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {offFilmCount > 0
            ? `${validEvents.length - offFilmCount} of ${validEvents.length} events on film`
            : `${validEvents.length} events`}
        </span>
      </div>

      {/* Missing-footage notice */}
      {offFilmCount > 0 && (
        <div className="px-4 py-2 border-b border-border/30 bg-amber-500/10 text-amber-400 text-xs">
          The recording ended before the game did — {offFilmCount} {offFilmCount === 1 ? "stat was" : "stats were"} logged
          after the video stopped and {offFilmCount === 1 ? "isn't" : "aren't"} on film.
        </div>
      )}

      {/* Timeline scrubber */}
      <div className="px-4 py-3 border-b border-border/30 bg-card/20">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1.5">
          <span>{fmtSec(currentTime)}</span>
          <span className="flex-1" />
          <span>{fmtSec(duration)}</span>
        </div>

        {/* Timeline bar */}
        <div
          className="relative h-7 rounded-md cursor-pointer select-none"
          style={{ background: "#1a1a1a" }}
          onClick={handleTimelineClick}
        >
          {/* Playback fill */}
          <div
            className="absolute inset-y-0 left-0 rounded-md"
            style={{ width: `${playPct}%`, background: "rgba(249,115,22,0.18)" }}
          />

          {/* Category-colored markers */}
          {validEvents.map((ev, i) => {
            const sec = toVideoSec(ev.videoTimestampMs!);
            const pct = duration > 0 ? (sec / duration) * 100 : 0;
            if (pct < 0 || pct > 100) return null;
            const color = getEventColor(ev.statField);
            const isHovered = hoveredIdx === i;
            return (
              <div
                key={i}
                className="absolute top-0 bottom-0 w-1 rounded-sm transition-all"
                style={{
                  left: `${pct}%`,
                  transform: "translateX(-50%)",
                  background: color,
                  opacity: isHovered ? 1 : 0.7,
                  zIndex: isHovered ? 10 : 1,
                  width: isHovered ? "6px" : "3px",
                }}
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
                onClick={(e) => { e.stopPropagation(); seekTo(ev); }}
                title={`${players.find(p => p.id === ev.playerId)?.name ?? "Player"} – ${STAT_LABELS[ev.statField] ?? ev.statField} @ ${fmtSec(sec)}`}
              />
            );
          })}

          {/* Playhead */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-primary"
            style={{ left: `${playPct}%`, transform: "translateX(-50%)", zIndex: 20 }}
          />
        </div>

        {/* Color legend */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
          {CATEGORIES.slice(1).map(cat => {
            const count = validEvents.filter(ev => (cat.fields as readonly string[]).includes(ev.statField)).length;
            if (count === 0) return null;
            return (
              <div key={cat.key} className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ background: cat.color }} />
                <span className="text-xs text-muted-foreground">{cat.label} <span className="text-foreground/60">({count})</span></span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Filter chips + event list */}
      <div className="max-h-72 overflow-y-auto" ref={listRef}>
        {/* Sticky filter row */}
        <div className="sticky top-0 z-10 bg-card/90 backdrop-blur-sm border-b border-border/30 px-3 py-2 flex items-center gap-1.5 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          {CATEGORIES.map(cat => {
            const count = cat.key === "all"
              ? validEvents.length
              : validEvents.filter(ev => (cat.fields as readonly string[]).includes(ev.statField)).length;
            if (count === 0 && cat.key !== "all") return null;
            const isActive = activeFilter === cat.key;
            return (
              <button
                key={cat.key}
                type="button"
                onClick={() => setActiveFilter(cat.key)}
                className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                  isActive
                    ? "text-white border-transparent"
                    : "text-muted-foreground border-border/60 hover:text-foreground"
                }`}
                style={isActive ? { background: cat.color, borderColor: cat.color } : {}}
              >
                {cat.label} <span className="opacity-70">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Event rows */}
        {filteredEvents.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">No events for this filter.</div>
        ) : (
          filteredEvents.map((ev, i) => {
            const player = players.find(p => p.id === ev.playerId);
            const sec = toVideoSec(ev.videoTimestampMs!);
            const offFilm = isOffFilm(ev);
            const isActive = !offFilm && i === currentEventIdx;
            const color = getEventColor(ev.statField);
            return (
              <button
                key={`${ev.origIdx}-${i}`}
                ref={isActive ? (el) => { activeRowRef.current = el; } : undefined}
                type="button"
                onClick={() => seekTo(ev)}
                disabled={offFilm}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors border-b border-border/20 last:border-0 ${
                  offFilm
                    ? "opacity-45 cursor-not-allowed"
                    : isActive
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                }`}
              >
                {/* Color pip */}
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: offFilm ? "#6b7280" : color }} />

                {/* Timestamp */}
                <span className="font-mono text-xs w-10 shrink-0 text-foreground/60">{fmtSec(sec)}</span>

                {/* Player + stat */}
                <span className="flex-1 truncate">
                  <span className={`font-medium ${isActive ? "text-foreground" : ""}`}>
                    {player?.name ?? "Player"}
                  </span>
                  <span className="mx-1 opacity-40">—</span>
                  <span>{STAT_LABELS[ev.statField] ?? ev.statField}</span>
                </span>

                {/* Off-film badge / jump icon */}
                {offFilm ? (
                  <span className="text-[10px] uppercase tracking-wide text-amber-400/80 shrink-0">Not on film</span>
                ) : (
                  <Play className={`w-3 h-3 shrink-0 transition-opacity ${isActive ? "opacity-100 text-primary" : "opacity-0 group-hover:opacity-60"}`} />
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
