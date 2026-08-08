import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { Loader2, AlertCircle } from "lucide-react";

interface PublicGameStat {
  playerName: string;
  points: number;
  assists: number;
  rebounds: number;
  steals: number;
  blocks: number;
  turnovers: number;
  ftMade: number;
  ftAttempted: number;
  twoMade: number;
  twoAttempted: number;
  threeMade: number;
  threeAttempted: number;
}

interface PublicGame {
  teamName: string;
  opponent: string;
  date: string;
  result: "W" | "L";
  teamScore: number;
  opponentScore: number;
  stats: PublicGameStat[];
}

type Status = "loading" | "not-found" | "error" | "ok";

function pct(made: number, attempted: number): string {
  if (attempted === 0) return "—";
  return `${Math.round((made / attempted) * 100)}%`;
}

function StatCell({ value }: { value: string | number }) {
  return (
    <td className="text-right px-2 py-2 text-xs font-mono text-muted-foreground tabular-nums">
      {value}
    </td>
  );
}

function injectOGTags(game: PublicGame) {
  const result = game.result === "W" ? "Win" : "Loss";
  const score = `${game.teamScore}–${game.opponentScore}`;
  const dateStr = new Date(game.date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const title = `${game.teamName} vs ${game.opponent} · ${score} ${result} | StecStats`;
  const description =
    `${dateStr} · ${game.teamName} ${score} ${game.opponent}. ` +
    game.stats
      .slice(0, 3)
      .map((s) => `${s.playerName} ${s.points}pts`)
      .join(", ");

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
  setMeta("og:type", "article");
  setMeta("og:site_name", "StecStats");
  setMeta("twitter:card", "summary", "name");
  setMeta("twitter:title", title, "name");
  setMeta("twitter:description", description, "name");
}

export default function GamePublic() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const [status, setStatus] = useState<Status>("loading");
  const [game, setGame] = useState<PublicGame | null>(null);

  useEffect(() => {
    if (!shareToken) { setStatus("not-found"); return; }
    fetch(`/api/games/public/${shareToken}`)
      .then((res) => {
        if (res.status === 404) { setStatus("not-found"); return null; }
        if (!res.ok) { setStatus("error"); return null; }
        return res.json() as Promise<PublicGame>;
      })
      .then((data) => {
        if (!data) return;
        setGame(data);
        setStatus("ok");
        injectOGTags(data);
      })
      .catch(() => setStatus("error"));

    return () => { document.title = "StecStats"; };
  }, [shareToken]);

  const dateLabel = game
    ? new Date(game.date).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";

  const fgMadeTotal = game ? game.stats.reduce((s, p) => s + p.twoMade + p.threeMade, 0) : 0;
  const fgAttTotal  = game ? game.stats.reduce((s, p) => s + p.twoAttempted + p.threeAttempted, 0) : 0;

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
            <p className="text-foreground font-semibold text-lg">Game not found</p>
            <p className="text-muted-foreground text-sm max-w-xs">
              This link may have been revoked or may not exist.
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

        {status === "ok" && game && (
          <>
            {/* Hero */}
            <div className="w-full rounded-2xl border border-primary/50 bg-card overflow-hidden relative mb-4">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary to-transparent" />
              <div
                className="absolute inset-0 pointer-events-none"
                style={{ background: "radial-gradient(ellipse 80% 60% at 50% 0%, hsl(var(--primary)/0.14), transparent 70%)" }}
              />
              <div className="relative flex flex-col items-center px-6 py-7 gap-2">
                {/* Teams */}
                <div className="flex items-center gap-3 w-full justify-center">
                  <span className="text-xl font-display font-bold uppercase text-foreground text-right flex-1 truncate">
                    {game.teamName}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono font-bold px-2">vs</span>
                  <span className="text-xl font-display font-bold uppercase text-muted-foreground text-left flex-1 truncate">
                    {game.opponent}
                  </span>
                </div>

                {/* Score */}
                <div className="flex items-center gap-3">
                  <span className="text-5xl font-display font-bold text-primary tabular-nums">
                    {game.teamScore}
                  </span>
                  <span className="text-2xl text-muted-foreground font-mono">–</span>
                  <span className="text-5xl font-display font-bold text-muted-foreground tabular-nums">
                    {game.opponentScore}
                  </span>
                </div>

                {/* Result badge + date */}
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-[11px] font-bold px-3 py-1 rounded-full font-mono uppercase tracking-widest ${
                    game.result === "W"
                      ? "bg-green-500/15 text-green-400 border border-green-500/30"
                      : "bg-red-500/15 text-red-400 border border-red-500/30"
                  }`}>
                    {game.result === "W" ? "Win" : "Loss"}
                  </span>
                  <span className="text-[11px] text-muted-foreground font-mono">{dateLabel}</span>
                </div>

                {/* Team FG summary */}
                {fgAttTotal > 0 && (
                  <div className="text-[11px] text-muted-foreground font-mono mt-1">
                    Team FG {fgMadeTotal}/{fgAttTotal} · {pct(fgMadeTotal, fgAttTotal)}
                  </div>
                )}
              </div>
            </div>

            {/* Box score table */}
            {game.stats.length > 0 && (
              <div className="w-full rounded-xl border border-border bg-card overflow-hidden mb-4">
                <div className="px-4 py-3 border-b border-border/60">
                  <h2 className="text-xs font-display font-bold uppercase tracking-widest text-muted-foreground">
                    Box Score
                  </h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px]">
                    <thead>
                      <tr className="border-b border-border/40">
                        <th className="text-left px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-36">
                          Player
                        </th>
                        <th className="text-right px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-primary">PTS</th>
                        <th className="text-right px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">REB</th>
                        <th className="text-right px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">AST</th>
                        <th className="text-right px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">STL</th>
                        <th className="text-right px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">BLK</th>
                        <th className="text-right px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">TO</th>
                        <th className="text-right px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">FG</th>
                        <th className="text-right px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">3P</th>
                        <th className="text-right px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">FT</th>
                      </tr>
                    </thead>
                    <tbody>
                      {game.stats.map((s, i) => {
                        const fgM = s.twoMade + s.threeMade;
                        const fgA = s.twoAttempted + s.threeAttempted;
                        return (
                          <tr key={i} className="border-b border-border/20 last:border-0 hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-2 text-sm font-medium text-foreground truncate max-w-[9rem]">
                              {s.playerName}
                            </td>
                            <td className="text-right px-2 py-2 text-sm font-bold text-primary tabular-nums">
                              {s.points}
                            </td>
                            <StatCell value={s.rebounds} />
                            <StatCell value={s.assists} />
                            <StatCell value={s.steals} />
                            <StatCell value={s.blocks} />
                            <StatCell value={s.turnovers} />
                            <StatCell value={pct(fgM, fgA)} />
                            <StatCell value={pct(s.threeMade, s.threeAttempted)} />
                            <StatCell value={pct(s.ftMade, s.ftAttempted)} />
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Footer */}
            <p className="text-[11px] text-muted-foreground mt-4 text-center">
              Stats powered by{" "}
              <a href="/" className="text-primary hover:underline">StecStats</a>
            </p>
          </>
        )}
      </main>
    </div>
  );
}
