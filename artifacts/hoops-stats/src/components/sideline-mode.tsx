import { useState, useEffect } from "react";
import { X, Undo2 } from "lucide-react";
import type { SportProfile, StatCounters } from "@/lib/sport-profiles";

interface Player { id: number; name: string; }

interface SidelineModeProps {
  players: Player[];
  stats: Record<number, StatCounters>;
  updateStat: (pid: number, field: keyof StatCounters, delta: number, timestampOffsetMs?: number) => void;
  teamName: string;
  opponent: string;
  teamScore: number;
  opponentScore: number;
  onClose: () => void;
  sportProfile: SportProfile;
}

export default function SidelineMode({
  players, stats, updateStat,
  teamName, opponent, teamScore, opponentScore,
  onClose, sportProfile,
}: SidelineModeProps) {
  const [activePid, setActivePid] = useState<number | null>(null);
  const [lastAction, setLastAction] = useState<{ pid: number; field: keyof StatCounters } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Close sheet on back gesture / escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (activePid !== null) setActivePid(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePid, onClose]);

  // Prevent body scroll while open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const SIDELINE_TIMESTAMP_OFFSET_MS = -10_000;

  const handleStat = (pid: number, field: keyof StatCounters, delta: number, label: string) => {
    updateStat(pid, field, delta, SIDELINE_TIMESTAMP_OFFSET_MS);
    setLastAction({ pid, field });
    setFlash(label);
    setTimeout(() => setFlash(null), 800);
    setActivePid(null);
  };

  const handleUndo = () => {
    if (!lastAction) return;
    updateStat(lastAction.pid, lastAction.field, -1);
    setLastAction(null);
  };

  const activePlayer = activePid !== null ? players.find(p => p.id === activePid) : null;
  const activeStats = activePid !== null ? (stats[activePid] || { ftMade:0, ftAttempted:0, twoMade:0, twoAttempted:0, threeMade:0, threeAttempted:0, assists:0, rebounds:0, steals:0, turnovers:0, blocks:0 }) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "#0a0807" }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
        {/* Score */}
        <div className="flex items-center gap-3">
          <div className="text-center">
            <div className="text-xs text-white/50 uppercase tracking-wider truncate max-w-[80px]">{teamName}</div>
            <div className="text-3xl font-black text-primary leading-none">{teamScore}</div>
          </div>
          <div className="text-white/30 text-2xl font-light">—</div>
          <div className="text-center">
            <div className="text-xs text-white/50 uppercase tracking-wider truncate max-w-[80px]">{opponent || "Opp"}</div>
            <div className="text-3xl font-black text-white/80 leading-none">{opponentScore}</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Undo */}
          <button
            type="button"
            disabled={!lastAction}
            onClick={handleUndo}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-white/20 text-white/60 disabled:opacity-30 active:bg-white/10"
          >
            <Undo2 className="w-4 h-4" />
            Undo
          </button>
          {/* Exit */}
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-white/20 text-white/60 active:bg-white/10"
          >
            <X className="w-4 h-4" />
            Exit
          </button>
        </div>
      </div>

      {/* Flash feedback */}
      {flash && (
        <div className="absolute inset-x-0 top-20 flex justify-center pointer-events-none z-50">
          <div className="bg-primary text-white font-bold text-sm px-4 py-1.5 rounded-full shadow-lg animate-bounce">
            ✓ {flash}
          </div>
        </div>
      )}

      {/* Player grid */}
      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-xs text-white/30 text-center uppercase tracking-widest mb-4">Tap a player to log a stat</p>
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${Math.min(players.length, 3)}, 1fr)` }}
        >
          {players.map(player => {
            const s = stats[player.id];
            const score = s ? sportProfile.computeScore(s) : 0;
            const isActive = activePid === player.id;
            return (
              <button
                key={player.id}
                type="button"
                onClick={() => setActivePid(isActive ? null : player.id)}
                className="flex flex-col items-center justify-center rounded-2xl py-5 px-3 active:scale-95 transition-transform select-none"
                style={{
                  background: isActive ? "#f97316" : "#1a1614",
                  border: `2px solid ${isActive ? "#f97316" : "#2a2421"}`,
                  minHeight: 100,
                }}
              >
                <div className="text-base font-bold text-white leading-tight text-center truncate w-full">{player.name}</div>
                <div className="mt-1.5 text-2xl font-black" style={{ color: isActive ? "#fff" : "#f97316" }}>{score}</div>
                <div className="text-xs" style={{ color: isActive ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.3)" }}>{sportProfile.scoreLabel.toLowerCase()}</div>
                {s && sportProfile.primaryStats.slice(0, 2).some(ps => (s[ps.field] as number) > 0) && (
                  <div className="mt-1 flex gap-2 text-xs" style={{ color: isActive ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.4)" }}>
                    {sportProfile.primaryStats.slice(0, 2).map(ps => (s[ps.field] as number) > 0 ? <span key={ps.field}>{s[ps.field] as number}{ps.label.toLowerCase()}</span> : null)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Stat sheet — slides up when a player is tapped */}
      {activePid !== null && activePlayer && activeStats && (
        <>
          {/* Backdrop */}
          <div
            className="absolute inset-0 z-40"
            style={{ background: "rgba(0,0,0,0.5)" }}
            onClick={() => setActivePid(null)}
          />
          {/* Sheet */}
          <div
            className="absolute bottom-0 inset-x-0 z-50 rounded-t-3xl pb-8"
            style={{ background: "#131110" }}
          >
            {/* Handle + player name */}
            <div className="flex flex-col items-center pt-3 pb-4 border-b border-white/10">
              <div className="w-10 h-1 rounded-full bg-white/20 mb-3" />
              <div className="text-lg font-bold text-white">{activePlayer.name}</div>
              <div className="text-sm text-white/40">
                {sportProfile.computeScore(activeStats)} {sportProfile.scoreLabel.toLowerCase()} · {sportProfile.primaryStats.slice(0, 2).map(ps => `${activeStats[ps.field]}${ps.label.toLowerCase()}`).join(' · ')}
              </div>
            </div>

            {/* Stat buttons - 3 per row */}
            <div className="grid grid-cols-3 gap-2 p-4">
              {sportProfile.quickActions.map((action, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleStat(activePid, action.field, action.delta, `${activePlayer.name} — ${action.label}${action.sublabel ? " " + action.sublabel : ""}`)}
                  className="flex flex-col items-center justify-center rounded-xl active:scale-95 transition-transform select-none"
                  style={{
                    background: action.bg,
                    padding: "14px 8px",
                    minHeight: 64,
                  }}
                >
                  <span className="text-lg font-black" style={{ color: action.color }}>{action.label}</span>
                  {action.sublabel && (
                    <span className="text-xs font-medium mt-0.5" style={{ color: action.color, opacity: 0.8 }}>{action.sublabel}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
