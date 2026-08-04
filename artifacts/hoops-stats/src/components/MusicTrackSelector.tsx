import { useRef, useState, useEffect } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Music, Play, Square, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// ── static track catalogue ──────────────────────────────────────────────────
// hasPreview mirrors which MP3 assets are present in api-server/src/assets/music/
// Exported so other modules (e.g. record.tsx) can derive labels from this
// single source of truth instead of maintaining a parallel list.
export const MUSIC_TRACKS = [
  { id: "energetic",  label: "Energetic",  description: "High-energy uptempo",       hasPreview: true  },
  { id: "upbeat",     label: "Upbeat",     description: "Fun, positive groove",       hasPreview: true  },
  { id: "dynamic",    label: "Dynamic",    description: "Driving, powerful beat",     hasPreview: true  },
  { id: "cinematic",  label: "Cinematic",  description: "Epic orchestral triumph",    hasPreview: false },
  { id: "oldschool",  label: "Old School", description: "Classic boom bap hip-hop",   hasPreview: false },
  { id: "lofi",       label: "Lo-Fi",      description: "Chill, mellow backdrop",     hasPreview: false },
] as const;

// Internal alias so the rest of the file keeps the short name
const TRACKS = MUSIC_TRACKS;

// ── module-level audio singleton ─────────────────────────────────────────────
// One Audio instance shared across every MusicTrackSelector on the page so
// that tapping Play on one selector automatically stops any other.
let sharedAudio: HTMLAudioElement | null = null;
let sharedAudioTrackId: string | null = null;
const previewListeners: Set<(trackId: string | null) => void> = new Set();

function notifyPreviewListeners(trackId: string | null) {
  previewListeners.forEach((fn) => fn(trackId));
}

function stopPreview() {
  if (sharedAudio) {
    sharedAudio.pause();
    sharedAudio.src = "";
  }
  sharedAudio = null;
  sharedAudioTrackId = null;
  notifyPreviewListeners(null);
}

function startPreview(trackId: string) {
  stopPreview();
  const audio = new Audio(`/api/music/tracks/${trackId}/preview`);
  sharedAudio = audio;
  sharedAudioTrackId = trackId;

  // Stop after 30 s
  const PREVIEW_SECS = 30;
  audio.addEventListener("timeupdate", () => {
    if (audio.currentTime >= PREVIEW_SECS) {
      stopPreview();
    }
  });
  audio.addEventListener("ended", () => stopPreview());
  audio.addEventListener("error", () => stopPreview());

  audio.play().catch(() => stopPreview());
  notifyPreviewListeners(trackId);
}

function togglePreview(trackId: string) {
  if (sharedAudioTrackId === trackId) {
    stopPreview();
  } else {
    startPreview(trackId);
  }
}

// ── component ─────────────────────────────────────────────────────────────────

interface MusicTrackSelectorProps {
  value: string | null;
  onChange: (value: string | null) => void;
  className?: string;
}

export default function MusicTrackSelector({ value, onChange, className }: MusicTrackSelectorProps) {
  const [open, setOpen] = useState(false);
  // Track which id is currently previewing (kept in sync with the global singleton)
  const [previewingId, setPreviewingId] = useState<string | null>(sharedAudioTrackId);

  useEffect(() => {
    const listener = (id: string | null) => setPreviewingId(id);
    previewListeners.add(listener);
    return () => {
      previewListeners.delete(listener);
    };
  }, []);

  // Stop preview when the popover closes
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) stopPreview();
  }

  const selectedTrack = TRACKS.find((t) => t.id === value);
  const triggerLabel = selectedTrack ? selectedTrack.label : "No music";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("h-7 gap-1 px-2 text-xs font-normal", className)}
          type="button"
        >
          <Music className="w-3 h-3 shrink-0" />
          <span className="truncate max-w-[80px]">{triggerLabel}</span>
          <ChevronDown className="w-3 h-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-56 p-1" align="start">
        {/* No music */}
        <button
          type="button"
          onClick={() => { onChange(null); setOpen(false); }}
          className={cn(
            "flex items-center gap-2 w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent transition-colors",
            value === null && "font-medium text-foreground",
            value !== null && "text-muted-foreground",
          )}
        >
          <span className={cn("w-2 h-2 rounded-full border border-muted-foreground/40 shrink-0", value === null && "bg-primary border-primary")} />
          <span>No music</span>
        </button>

        {TRACKS.map((track) => (
          <div key={track.id} className="flex items-center gap-1 rounded-sm hover:bg-accent transition-colors group">
            {/* Row — selecting the track */}
            <button
              type="button"
              onClick={() => { onChange(track.id); setOpen(false); }}
              className="flex items-center gap-2 flex-1 min-w-0 px-2 py-1.5 text-sm text-left"
            >
              <span
                className={cn(
                  "w-2 h-2 rounded-full border border-muted-foreground/40 shrink-0",
                  value === track.id && "bg-primary border-primary",
                )}
              />
              <div className="min-w-0">
                <span className={cn("block leading-none", value === track.id ? "font-medium text-foreground" : "text-muted-foreground")}>
                  {track.label}
                </span>
                <span className="block text-[10px] text-muted-foreground/70 leading-none mt-0.5 truncate">
                  {track.description}
                </span>
              </div>
            </button>

            {/* Preview button — always visible so touch devices can tap it */}
            {track.hasPreview ? (
              <button
                type="button"
                title={previewingId === track.id ? "Stop preview" : "Preview 30 s"}
                onClick={(e) => { e.stopPropagation(); togglePreview(track.id); }}
                className={cn(
                  "shrink-0 mr-1 p-1 rounded transition-colors",
                  previewingId === track.id
                    ? "text-primary hover:text-primary/80"
                    : "text-muted-foreground/40 hover:text-foreground",
                )}
              >
                {previewingId === track.id
                  ? <Square className="w-3 h-3 fill-current" />
                  : <Play className="w-3 h-3 fill-current" />}
              </button>
            ) : (
              <span className="w-5 mr-1 shrink-0" />
            )}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
