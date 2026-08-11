// App Store Screenshot 2 — "Your Whole Roster, One View"
export default function Screenshot2_Stats() {
  const players = [
    { name: "Marcus J.", pts: 18.4, reb: 6.2, ast: 4.1, pct: 54 },
    { name: "Devon W.", pts: 14.1, reb: 9.8, ast: 1.3, pct: 47 },
    { name: "Tyrell B.", pts: 11.7, reb: 3.1, ast: 7.2, pct: 41 },
    { name: "Kai S.", pts: 9.3, reb: 4.5, ast: 2.9, pct: 38 },
    { name: "Jordan M.", pts: 7.8, reb: 5.1, ast: 1.7, pct: 52 },
  ];

  return (
    <div className="w-full h-screen bg-black flex flex-col items-center justify-between overflow-hidden" style={{fontFamily: "'SF Pro Display', -apple-system, sans-serif"}}>
      <div className="pt-10 pb-4 flex flex-col items-center gap-2">
        <div className="bg-orange-500 rounded-full px-4 py-1 text-xs font-bold text-white tracking-widest uppercase">StecStats</div>
        <p className="text-white text-2xl font-bold tracking-tight text-center leading-tight">Your Whole Roster,<br/>One View.</p>
      </div>

      <div className="relative flex-1 flex items-center justify-center w-full px-8">
        <div className="w-full max-w-xs bg-zinc-900 rounded-3xl overflow-hidden shadow-2xl border border-zinc-700" style={{aspectRatio: "9/19"}}>
          <div className="bg-black px-5 pt-3 pb-1 flex justify-between items-center">
            <span className="text-white text-xs font-semibold">9:41</span>
            <div className="w-4 h-2 border border-white rounded-sm"><div className="h-full w-3/4 bg-white rounded-sm"/></div>
          </div>

          {/* Header */}
          <div className="bg-zinc-950 px-4 pt-3 pb-2">
            <div className="text-white font-bold text-base">Eagles — 2024 Season</div>
            <div className="text-zinc-400 text-xs mt-0.5">14 games • 9–5 record</div>
            {/* Summary pills */}
            <div className="flex gap-2 mt-2">
              {[["82.4", "PPG"], ["38.7", "RPG"], ["17.2", "APG"]].map(([v, l]) => (
                <div key={l} className="bg-zinc-800 rounded-lg px-2 py-1 text-center flex-1">
                  <div className="text-orange-400 font-bold text-sm">{v}</div>
                  <div className="text-zinc-500 text-xs">{l}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Column headers */}
          <div className="px-4 py-1.5 flex justify-between bg-zinc-900 border-b border-zinc-800">
            <span className="text-zinc-500 text-xs w-24">PLAYER</span>
            <div className="flex gap-4">
              {["PTS", "REB", "AST", "FG%"].map(h => (
                <span key={h} className="text-zinc-500 text-xs w-8 text-center">{h}</span>
              ))}
            </div>
          </div>

          {/* Player rows */}
          <div className="bg-zinc-950 divide-y divide-zinc-800/50">
            {players.map((p, i) => (
              <div key={p.name} className="px-4 py-2 flex justify-between items-center">
                <div className="flex items-center gap-2 w-24">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${i === 0 ? "bg-orange-500 text-white" : "bg-zinc-700 text-zinc-300"}`}>
                    {p.name.split(" ").map(n => n[0]).join("")}
                  </div>
                  <span className={`text-xs truncate ${i === 0 ? "text-white font-semibold" : "text-zinc-400"}`}>{p.name.split(" ")[0]}</span>
                </div>
                <div className="flex gap-4">
                  <span className={`text-xs w-8 text-center font-semibold ${i === 0 ? "text-orange-400" : "text-zinc-300"}`}>{p.pts}</span>
                  <span className="text-zinc-400 text-xs w-8 text-center">{p.reb}</span>
                  <span className="text-zinc-400 text-xs w-8 text-center">{p.ast}</span>
                  <span className="text-zinc-400 text-xs w-8 text-center">{p.pct}%</span>
                </div>
              </div>
            ))}
          </div>

          {/* Bottom nav */}
          <div className="absolute bottom-0 left-0 right-0 bg-zinc-900 border-t border-zinc-800 px-4 py-2 flex justify-around">
            {[["📊", "Stats"], ["🎬", "Record"], ["🗂", "Games"], ["👤", "Profile"]].map(([icon, label], i) => (
              <div key={label} className={`flex flex-col items-center gap-0.5 ${i === 0 ? "text-orange-400" : "text-zinc-600"}`}>
                <span className="text-base">{icon}</span>
                <span className="text-xs">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="pb-10 text-center px-6">
        <p className="text-zinc-400 text-sm font-medium">Career stats build automatically<br/>with every game you track.</p>
      </div>
    </div>
  );
}
