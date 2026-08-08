import { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import { Loader2, AlertCircle, Film } from "lucide-react";

interface PublicHighlight {
  teamName: string;
  opponent: string;
  date: string;
  result: "W" | "L";
  teamScore: number;
  opponentScore: number;
  videoUrl: string;
}

type Status = "loading" | "not-found" | "unavailable" | "error" | "ok";

function injectOGTags(h: PublicHighlight) {
  const result = h.result === "W" ? "Win" : "Loss";
  const score = `${h.teamScore}–${h.opponentScore}`;
  const dateStr = new Date(h.date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const title = `${h.teamName} Highlight Reel vs ${h.opponent} · ${score} ${result} | StecStats`;
  const description = `${dateStr} · Watch the ${h.teamName} ${score} ${result.toLowerCase()} game highlight reel vs ${h.opponent} on StecStats.`;

  document.title = title;

  const url = window.location.href;

  const setMeta = (key: string, content: string, attr = "property") => {
    let el = document.querySelector(`meta[${attr}="${key}"]`) as HTMLMetaElement | null;
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute(attr, key);
      document.head.appendChild(el);
    }
    el.content = content;
  };

  setMeta("og:title", title);
  setMeta("og:description", description);
  setMeta("og:url", url);
  setMeta("og:type", "video.other");
  setMeta("og:site_name", "StecStats");
  setMeta("twitter:card", "player", "name");
  setMeta("twitter:title", title, "name");
  setMeta("twitter:description", description, "name");
}

export default function HighlightPublic() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const [status, setStatus] = useState<Status>("loading");
  const [highlight, setHighlight] = useState<PublicHighlight | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!shareToken) { setStatus("not-found"); return; }
    fetch(`/api/games/public/${shareToken}/highlight`)
      .then((res) => {
        if (res.status === 404) {
          return res.json().then((d) => {
            setStatus(d?.error === "Highlight reel not available" ? "unavailable" : "not-found");
            return null;
          });
        }
        if (!res.ok) { setStatus("error"); return null; }
        return res.json() as Promise<PublicHighlight>;
      })
      .then((data) => {
        if (!data) return;
        setHighlight(data);
        setStatus("ok");
        injectOGTags(data);
      })
      .catch(() => setStatus("error"));

    return () => { document.title = "StecStats"; };
  }, [shareToken]);

  const dateLabel = highlight
    ? new Date(highlight.date).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border/60 bg-card/60">
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="StecStats" className="h-8 w-auto object-contain" />
        </div>
        <a href="/" className="text-xs font-semibold text-primary hover:text-primary/80 transition-colors">
          Open App →
        </a>
      </header>

      <main className="flex-1 flex flex-col items-center px-4 py-6 max-w-2xl mx-auto w-full">
        {status === "loading" && (
          <div className="flex-1 flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}

        {status === "not-found" && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 py-20 text-center">
            <AlertCircle className="w-10 h-10 text-muted-foreground" />
            <p className="text-foreground font-semibold text-lg">Highlight not found</p>
            <p className="text-muted-foreground text-sm max-w-xs">
              This link may have been revoked or may not exist.
            </p>
          </div>
        )}

        {status === "unavailable" && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 py-20 text-center">
            <Film className="w-10 h-10 text-muted-foreground" />
            <p className="text-foreground font-semibold text-lg">Highlight reel not ready yet</p>
            <p className="text-muted-foreground text-sm max-w-xs">
              The coach hasn't generated a highlight reel for this game yet.
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 py-20 text-center">
            <AlertCircle className="w-10 h-10 text-destructive" />
            <p className="text-foreground font-semibold text-lg">Something went wrong</p>
            <p className="text-muted-foreground text-sm">Please try again in a moment.</p>
          </div>
        )}

        {status === "ok" && highlight && (
          <>
            {/* Game header */}
            <div className="w-full rounded-2xl border border-primary/50 bg-card overflow-hidden relative mb-4">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary to-transparent" />
              <div
                className="absolute inset-0 pointer-events-none"
                style={{ background: "radial-gradient(ellipse 80% 60% at 50% 0%, hsl(var(--primary)/0.14), transparent 70%)" }}
              />
              <div className="relative flex flex-col items-center px-6 py-5 gap-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-primary flex items-center gap-1.5">
                  <Film className="w-3 h-3" /> Highlight Reel
                </p>
                {/* Teams */}
                <div className="flex items-center gap-3 w-full justify-center mt-1">
                  <span className="text-xl font-display font-bold uppercase text-foreground text-right flex-1 truncate">
                    {highlight.teamName}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono font-bold px-2">vs</span>
                  <span className="text-xl font-display font-bold uppercase text-muted-foreground text-left flex-1 truncate">
                    {highlight.opponent}
                  </span>
                </div>
                {/* Score */}
                <div className="flex items-center gap-3">
                  <span className="text-4xl font-display font-bold text-primary tabular-nums">
                    {highlight.teamScore}
                  </span>
                  <span className="text-xl text-muted-foreground font-mono">–</span>
                  <span className="text-4xl font-display font-bold text-muted-foreground tabular-nums">
                    {highlight.opponentScore}
                  </span>
                </div>
                {/* Result badge + date */}
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-[11px] font-bold px-3 py-1 rounded-full font-mono uppercase tracking-widest ${
                    highlight.result === "W"
                      ? "bg-green-500/15 text-green-400 border border-green-500/30"
                      : "bg-red-500/15 text-red-400 border border-red-500/30"
                  }`}>
                    {highlight.result === "W" ? "Win" : "Loss"}
                  </span>
                  <span className="text-[11px] text-muted-foreground font-mono">{dateLabel}</span>
                </div>
              </div>
            </div>

            {/* Video player */}
            <div className="w-full rounded-xl overflow-hidden bg-black mb-4 shadow-2xl">
              <video
                ref={videoRef}
                src={highlight.videoUrl}
                controls
                autoPlay
                playsInline
                className="w-full max-h-[70vh] object-contain"
                onError={() => setStatus("error")}
              />
            </div>

            {/* Footer */}
            <p className="text-[11px] text-muted-foreground mt-2 text-center">
              Stats & highlights powered by{" "}
              <a href="/" className="text-primary hover:underline">StecStats</a>
            </p>
          </>
        )}
      </main>
    </div>
  );
}
