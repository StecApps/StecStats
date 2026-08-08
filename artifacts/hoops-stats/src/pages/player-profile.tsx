import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { Loader2, AlertCircle } from "lucide-react";

interface PublicPlayerProfile {
  playerName: string;
  photoObjectPath: string | null;
  games: number;
  wins: number;
  losses: number;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  ppg: number;
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
  topg: number;
  fgPct: number | null;
  threePct: number | null;
  ftPct: number | null;
  twoMade: number;
  twoAttempted: number;
  threeMade: number;
  threeAttempted: number;
  ftMade: number;
  ftAttempted: number;
}

function pctStr(val: number | null): string {
  if (val == null || val === 0) return "—";
  return `${(val * 100).toFixed(1)}%`;
}

function ArcGauge({ pct, label, made, attempted }: {
  pct: number | null; label: string; made?: number; attempted?: number;
}) {
  const SIZE = 120;
  const SW = 10;
  const r = (SIZE - SW) / 2;
  const circ = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(1, pct ?? 0)) * circ;
  const pctDisplay = pct != null && pct > 0 ? `${(pct * 100).toFixed(1)}%` : "—";

  return (
    <div className="flex flex-col items-center gap-2 flex-1">
      <div style={{ position: "relative", width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE}>
          <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
            <circle cx={SIZE / 2} cy={SIZE / 2} r={r}
              stroke="hsl(var(--border))" strokeWidth={SW} fill="none" />
            <circle cx={SIZE / 2} cy={SIZE / 2} r={r}
              stroke="hsl(var(--primary))" strokeWidth={SW} fill="none"
              strokeDasharray={`${filled} ${circ}`} strokeLinecap="round" />
          </g>
        </svg>
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          flexDirection: "column", alignItems: "center", justifyContent: "center",
        }}>
          <span className="text-xl font-bold text-foreground font-display">{pctDisplay}</span>
          {made != null && attempted != null && (
            <span className="text-[10px] text-muted-foreground">{made}/{attempted}</span>
          )}
        </div>
      </div>
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function StatBox({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex-1 rounded-2xl border border-border bg-card p-4 flex flex-col items-center gap-1">
      <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="text-4xl font-display font-bold text-primary leading-none">{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

function MiniStat({ label, value, total }: { label: string; value: string; total?: string }) {
  return (
    <div className="flex-1 rounded-xl border border-border bg-card px-4 py-3 flex flex-col items-center gap-0.5">
      <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="text-3xl font-display font-bold text-foreground leading-none">{value}</span>
      {total && <span className="text-[9px] text-muted-foreground">{total} TOT</span>}
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 mt-6 mb-3">
      <div className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
      <span className="text-xs font-bold uppercase tracking-[0.2em] text-foreground font-display">{title}</span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

export default function PlayerProfile() {
  const params = useParams<{ shareToken: string }>();
  const shareToken = params.shareToken;

  const [profile, setProfile] = useState<PublicPlayerProfile | null>(null);
  const [status, setStatus] = useState<"loading" | "not-found" | "error" | "ok">("loading");

  useEffect(() => {
    if (!shareToken) { setStatus("not-found"); return; }
    fetch(`/api/players/public/${shareToken}`)
      .then(async (res) => {
        if (res.status === 404) { setStatus("not-found"); return; }
        if (!res.ok) { setStatus("error"); return; }
        const data = await res.json();
        setProfile(data);
        setStatus("ok");
      })
      .catch(() => setStatus("error"));
  }, [shareToken]);

  const fgMade = (profile?.twoMade ?? 0) + (profile?.threeMade ?? 0);
  const fgAttempted = (profile?.twoAttempted ?? 0) + (profile?.threeAttempted ?? 0);

  // Inject OG / social-preview meta tags whenever the profile loads
  useEffect(() => {
    if (status !== "ok" || !profile) return;

    const title = `${profile.playerName} — Career Stats | StecStats`;
    const description =
      `${profile.ppg.toFixed(1)} PPG · ${profile.rpg.toFixed(1)} RPG · ` +
      `${profile.apg.toFixed(1)} APG over ${profile.games} game${profile.games === 1 ? "" : "s"}`;
    const url = window.location.href;

    document.title = title;

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
    setMeta("og:type", "profile");
    setMeta("og:site_name", "StecStats");
    setMeta("twitter:card", "summary", "name");
    setMeta("twitter:title", title, "name");
    setMeta("twitter:description", description, "name");

    return () => {
      document.title = "StecStats";
    };
  }, [status, profile]);

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border/60 bg-card/60">
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="StecStats" className="h-8 w-auto object-contain" />
        </div>
        <a
          href="/"
          className="text-xs font-semibold text-primary hover:text-primary/80 transition-colors"
        >
          Open App →
        </a>
      </header>

      <main className="flex-1 flex flex-col items-center px-4 py-6 max-w-xl mx-auto w-full">
        {status === "loading" && (
          <div className="flex-1 flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}

        {status === "not-found" && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 py-20 text-center">
            <AlertCircle className="w-10 h-10 text-muted-foreground" />
            <p className="text-foreground font-semibold text-lg">Profile not found</p>
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

        {status === "ok" && profile && (
          <>
            {/* Hero card */}
            <div className="w-full rounded-2xl border border-primary/50 bg-card overflow-hidden relative mb-4">
              {/* Orange top bar */}
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary to-transparent" />
              {/* Subtle glow */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{ background: "radial-gradient(ellipse 80% 60% at 50% 0%, hsl(var(--primary)/0.18), transparent 70%)" }}
              />

              <div className="relative flex flex-col items-center px-6 py-8 gap-3">
                {/* Avatar */}
                <div className="w-24 h-24 rounded-full border-2 border-primary bg-primary/10 flex items-center justify-center overflow-hidden mb-1">
                  <span
                    className="text-3xl font-display font-bold text-primary"
                    style={{ lineHeight: 1 }}
                  >
                    {profile.playerName.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
                  </span>
                </div>

                {/* Name */}
                <h1 className="text-4xl font-display font-bold uppercase tracking-wide text-foreground text-center leading-none">
                  {profile.playerName}
                </h1>

                {/* Career pill */}
                <div className="rounded-full border border-border bg-muted px-4 py-1">
                  <span className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">
                    Career Overview
                  </span>
                </div>
              </div>
            </div>

            {/* Top stats */}
            <div className="w-full flex gap-2 mb-2">
              <StatBox label="Points / GM" value={profile.ppg.toFixed(1)} sub={`${profile.points} total`} />
              <StatBox label="Games" value={String(profile.games)} sub={`${profile.wins}W · ${profile.losses}L`} />
            </div>
            <div className="w-full flex gap-2">
              <StatBox
                label="Win Rate"
                value={profile.games > 0 ? `${Math.round((profile.wins / profile.games) * 100)}%` : "—"}
                sub={`${profile.wins}–${profile.losses}`}
              />
              <StatBox label="Rebounds / GM" value={profile.rpg.toFixed(1)} sub={`${profile.rebounds} total`} />
            </div>

            {/* Shooting efficiency */}
            {(profile.fgPct != null || profile.threePct != null || profile.ftPct != null) && (
              <>
                <SectionHeader title="Shooting Efficiency" />
                <div className="w-full rounded-2xl border border-border bg-card p-5 flex items-center gap-4">
                  <ArcGauge
                    pct={fgAttempted > 0 ? fgMade / fgAttempted : null}
                    label="Field Goal"
                    made={fgMade}
                    attempted={fgAttempted}
                  />
                  <div className="w-px self-stretch bg-border" />
                  <ArcGauge
                    pct={profile.threeAttempted > 0 ? profile.threeMade / profile.threeAttempted : null}
                    label="3-Point"
                    made={profile.threeMade}
                    attempted={profile.threeAttempted}
                  />
                  <div className="w-px self-stretch bg-border" />
                  <ArcGauge
                    pct={profile.ftAttempted > 0 ? profile.ftMade / profile.ftAttempted : null}
                    label="Free Throw"
                    made={profile.ftMade}
                    attempted={profile.ftAttempted}
                  />
                </div>
              </>
            )}

            {/* Playmaking & Defense */}
            <SectionHeader title="Playmaking & Defense" />
            <div className="w-full flex gap-2 mb-2">
              <MiniStat label="Assists / GM" value={profile.apg.toFixed(1)} total={String(profile.assists)} />
              <MiniStat label="Steals / GM" value={profile.spg.toFixed(1)} total={String(profile.steals)} />
            </div>
            <div className="w-full flex gap-2">
              <MiniStat label="Blocks / GM" value={profile.bpg.toFixed(1)} total={String(profile.blocks)} />
              <MiniStat label="Turnovers / GM" value={profile.topg.toFixed(1)} total={String(profile.turnovers)} />
            </div>

            {/* Footer */}
            <p className="text-[11px] text-muted-foreground mt-8 text-center">
              Stats powered by{" "}
              <a href="/" className="text-primary hover:underline">StecStats</a>
            </p>
          </>
        )}
      </main>
    </div>
  );
}
