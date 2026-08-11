// App Store Screenshot 2 — "Your Whole Roster, One View"
export default function Screenshot2_Stats() {
  const players = [
    { name: "Marcus J.", pts: 18.4, reb: 6.2, ast: 4.1, pct: 54 },
    { name: "Devon W.", pts: 14.1, reb: 9.8, ast: 1.3, pct: 47 },
    { name: "Tyrell B.", pts: 11.7, reb: 3.1, ast: 7.2, pct: 41 },
    { name: "Kai S.", pts: 9.3, reb: 4.5, ast: 2.9, pct: 38 },
    { name: "Jordan M.", pts: 7.8, reb: 5.1, ast: 1.7, pct: 52 },
    { name: "Chris R.", pts: 5.2, reb: 2.4, ast: 3.1, pct: 44 },
  ];

  return (
    <div className="w-screen h-screen bg-black flex flex-col overflow-hidden"
      style={{ fontFamily: "'SF Pro Display', -apple-system, sans-serif" }}>

      <div className="flex flex-col items-center gap-[2vh] pt-[6vh] pb-[3vh] flex-shrink-0">
        <div className="bg-orange-500 rounded-full px-[4vw] py-[1vh] text-[2vw] font-black text-white tracking-widest uppercase">StecStats</div>
        <p className="text-white text-[6vw] font-black tracking-tight text-center leading-tight">Your Whole Roster,<br />One View.</p>
      </div>

      {/* Season summary */}
      <div className="mx-[6vw] bg-zinc-900 rounded-2xl px-[4vw] py-[2vh] flex-shrink-0">
        <div className="text-white font-bold text-[3.5vw]">Eagles — 2024 Season</div>
        <div className="text-zinc-400 text-[2.8vw] mt-[0.5vh]">14 games • 9–5 record</div>
        <div className="flex gap-[2vw] mt-[2vh]">
          {[["82.4", "PPG"], ["38.7", "RPG"], ["17.2", "APG"]].map(([v, l]) => (
            <div key={l} className="bg-zinc-800 rounded-xl px-[3vw] py-[1.5vh] text-center flex-1">
              <div className="text-orange-400 font-black text-[4.5vw]">{v}</div>
              <div className="text-zinc-500 text-[2.3vw] mt-[0.5vh]">{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Column headers */}
      <div className="mx-[6vw] mt-[2vh] flex justify-between flex-shrink-0 px-[2vw]">
        <span className="text-zinc-500 text-[2.5vw] w-[30vw]">PLAYER</span>
        <div className="flex gap-[3vw]">
          {["PTS", "REB", "AST", "FG%"].map(h => (
            <span key={h} className="text-zinc-500 text-[2.5vw] w-[10vw] text-center">{h}</span>
          ))}
        </div>
      </div>

      {/* Player rows */}
      <div className="mx-[6vw] mt-[1.5vh] space-y-[1.5vh] flex-1 min-h-0">
        {players.map((p, i) => (
          <div key={p.name} className={`flex justify-between items-center px-[3vw] py-[1.8vh] rounded-2xl ${i === 0 ? "bg-orange-500/10 border border-orange-500/30" : "bg-zinc-900"}`}>
            <div className="flex items-center gap-[2.5vw] w-[30vw]">
              <div className={`w-[7vw] h-[7vw] rounded-full flex items-center justify-center text-[2.5vw] font-bold ${i === 0 ? "bg-orange-500 text-white" : "bg-zinc-700 text-zinc-300"}`}>
                {p.name.split(" ").map(n => n[0]).join("")}
              </div>
              <span className={`text-[3vw] truncate ${i === 0 ? "text-white font-semibold" : "text-zinc-400"}`}>{p.name.split(" ")[0]}</span>
            </div>
            <div className="flex gap-[3vw]">
              <span className={`text-[3vw] w-[10vw] text-center font-bold ${i === 0 ? "text-orange-400" : "text-zinc-300"}`}>{p.pts}</span>
              <span className="text-zinc-500 text-[3vw] w-[10vw] text-center">{p.reb}</span>
              <span className="text-zinc-500 text-[3vw] w-[10vw] text-center">{p.ast}</span>
              <span className="text-zinc-500 text-[3vw] w-[10vw] text-center">{p.pct}%</span>
            </div>
          </div>
        ))}
      </div>

      <div className="pb-[6vh] pt-[3vh] text-center flex-shrink-0">
        <p className="text-zinc-400 text-[3vw] font-medium">Career stats build automatically<br />with every game you track.</p>
      </div>
    </div>
  );
}
