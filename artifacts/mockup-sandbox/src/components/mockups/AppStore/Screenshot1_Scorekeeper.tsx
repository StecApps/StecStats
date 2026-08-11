// App Store Screenshot 1 — "Track Every Stat, Live"
// Viewport: set browser to 390×844, then screenshot
export default function Screenshot1_Scorekeeper() {
  const players = [
    { name: "Marcus J.", pts: 12, reb: 4, ast: 3, active: true },
    { name: "Devon W.", pts: 8, reb: 7, ast: 1, active: false },
    { name: "Tyrell B.", pts: 6, reb: 2, ast: 5, active: false },
    { name: "Kai S.", pts: 4, reb: 3, ast: 2, active: false },
  ];

  const statButtons = ["2PT", "3PT", "FT", "REB", "AST", "STL", "BLK", "TO", "FOUL"];

  return (
    <div className="w-full h-screen bg-black flex flex-col items-center justify-between overflow-hidden" style={{fontFamily: "'SF Pro Display', -apple-system, sans-serif"}}>
      {/* Top badge */}
      <div className="pt-10 pb-4 flex flex-col items-center gap-2">
        <div className="bg-orange-500 rounded-full px-4 py-1 text-xs font-bold text-white tracking-widest uppercase">StecStats</div>
        <p className="text-white text-2xl font-bold tracking-tight text-center leading-tight">Track Every Stat,<br/>Live.</p>
      </div>

      {/* Phone mockup */}
      <div className="relative flex-1 flex items-center justify-center w-full px-8">
        <div className="w-full max-w-xs bg-zinc-900 rounded-3xl overflow-hidden shadow-2xl border border-zinc-700" style={{aspectRatio: "9/19"}}>
          {/* Status bar */}
          <div className="bg-black px-5 pt-3 pb-1 flex justify-between items-center">
            <span className="text-white text-xs font-semibold">9:41</span>
            <div className="flex gap-1 items-center">
              <div className="w-4 h-2 border border-white rounded-sm"><div className="h-full w-3/4 bg-white rounded-sm"/></div>
            </div>
          </div>

          {/* Score header */}
          <div className="bg-zinc-950 px-3 py-2 flex justify-between items-center border-b border-zinc-800">
            <div className="text-center">
              <div className="text-orange-400 font-black text-2xl">38</div>
              <div className="text-zinc-400 text-xs">EAGLES</div>
            </div>
            <div className="text-center">
              <div className="text-zinc-500 text-xs font-semibold">Q3 • 4:22</div>
              <div className="text-zinc-600 text-xs mt-0.5">● REC</div>
            </div>
            <div className="text-center">
              <div className="text-zinc-300 font-black text-2xl">31</div>
              <div className="text-zinc-400 text-xs">OPP</div>
            </div>
          </div>

          {/* Active player */}
          <div className="bg-orange-500/10 border-b border-orange-500/30 px-3 py-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-orange-500 flex items-center justify-center text-white font-bold text-sm">MJ</div>
              <div>
                <div className="text-white text-sm font-semibold">Marcus J.</div>
                <div className="text-orange-400 text-xs">12 PTS • 4 REB • 3 AST</div>
              </div>
            </div>
            <div className="text-orange-400 text-xs font-semibold">ACTIVE</div>
          </div>

          {/* Stat buttons */}
          <div className="px-3 py-2 grid grid-cols-3 gap-1.5">
            {statButtons.map((s, i) => (
              <button key={s} className={`rounded-lg py-2.5 text-xs font-bold text-center ${i === 0 ? "bg-orange-500 text-white" : "bg-zinc-800 text-zinc-300"}`}>
                {s}
              </button>
            ))}
          </div>

          {/* Player list */}
          <div className="px-3 pt-1 pb-2 space-y-1">
            {players.slice(1).map(p => (
              <div key={p.name} className="bg-zinc-800/50 rounded-xl px-3 py-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center text-zinc-300 text-xs font-bold">{p.name.split(" ").map(n => n[0]).join("")}</div>
                  <span className="text-zinc-300 text-xs">{p.name}</span>
                </div>
                <div className="flex gap-2 text-xs text-zinc-500">
                  <span>{p.pts}p</span><span>{p.reb}r</span><span>{p.ast}a</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom label */}
      <div className="pb-10 text-center px-6">
        <p className="text-zinc-400 text-sm font-medium">Tap a player. Tap a stat.<br/>Your clipboard can retire.</p>
      </div>
    </div>
  );
}
