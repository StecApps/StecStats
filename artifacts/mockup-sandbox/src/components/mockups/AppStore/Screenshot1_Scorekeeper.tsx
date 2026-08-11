// App Store Screenshot 1 — "Track Every Stat, Live"
// Full-bleed design, no phone frame — fills any viewport size
export default function Screenshot1_Scorekeeper() {
  const players = [
    { name: "Marcus J.", pts: 12, reb: 4, ast: 3, active: true },
    { name: "Devon W.", pts: 8, reb: 7, ast: 1, active: false },
    { name: "Tyrell B.", pts: 6, reb: 2, ast: 5, active: false },
    { name: "Kai S.", pts: 4, reb: 3, ast: 2, active: false },
  ];
  const statButtons = ["2PT", "3PT", "FT", "REB", "AST", "STL", "BLK", "TO", "FOUL"];

  return (
    <div className="w-screen h-screen bg-black flex flex-col overflow-hidden"
      style={{ fontFamily: "'SF Pro Display', -apple-system, sans-serif" }}>

      {/* Top — branding + tagline */}
      <div className="flex flex-col items-center gap-[2vh] pt-[6vh] pb-[3vh] flex-shrink-0">
        <div className="bg-orange-500 rounded-full px-[4vw] py-[1vh] text-[2vw] font-black text-white tracking-widest uppercase">
          StecStats
        </div>
        <p className="text-white text-[6vw] font-black tracking-tight text-center leading-tight">
          Track Every Stat,<br />Live.
        </p>
      </div>

      {/* Score header */}
      <div className="bg-zinc-950 mx-[6vw] rounded-2xl px-[5vw] py-[2vh] flex justify-between items-center flex-shrink-0">
        <div className="text-center">
          <div className="text-orange-400 font-black text-[9vw]">38</div>
          <div className="text-zinc-400 text-[2.5vw] font-semibold tracking-wider">EAGLES</div>
        </div>
        <div className="text-center">
          <div className="text-zinc-400 text-[2.8vw] font-semibold">Q3 • 4:22</div>
          <div className="text-red-400 text-[2.5vw] mt-1">● REC</div>
        </div>
        <div className="text-center">
          <div className="text-zinc-300 font-black text-[9vw]">31</div>
          <div className="text-zinc-400 text-[2.5vw] font-semibold tracking-wider">OPP</div>
        </div>
      </div>

      {/* Active player */}
      <div className="mx-[6vw] mt-[2vh] bg-orange-500/15 border border-orange-500/40 rounded-2xl px-[4vw] py-[2vh] flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-[3vw]">
          <div className="w-[10vw] h-[10vw] rounded-full bg-orange-500 flex items-center justify-center text-white font-black text-[4vw]">MJ</div>
          <div>
            <div className="text-white text-[3.5vw] font-bold">Marcus J.</div>
            <div className="text-orange-400 text-[2.8vw]">12 PTS • 4 REB • 3 AST</div>
          </div>
        </div>
        <div className="text-orange-400 text-[2.5vw] font-bold tracking-wider">ACTIVE</div>
      </div>

      {/* Stat buttons */}
      <div className="mx-[6vw] mt-[2vh] grid grid-cols-3 gap-[2vw] flex-shrink-0">
        {statButtons.map((s, i) => (
          <button key={s} className={`rounded-2xl py-[2.5vh] text-[3vw] font-black text-center ${i === 0 ? "bg-orange-500 text-white" : "bg-zinc-800 text-zinc-300"}`}>
            {s}
          </button>
        ))}
      </div>

      {/* Player list */}
      <div className="mx-[6vw] mt-[2vh] space-y-[1.5vh] flex-1 min-h-0">
        {players.slice(1).map(p => (
          <div key={p.name} className="bg-zinc-900 rounded-2xl px-[4vw] py-[2vh] flex items-center justify-between">
            <div className="flex items-center gap-[3vw]">
              <div className="w-[8vw] h-[8vw] rounded-full bg-zinc-700 flex items-center justify-center text-zinc-300 text-[2.8vw] font-bold">
                {p.name.split(" ").map(n => n[0]).join("")}
              </div>
              <span className="text-zinc-300 text-[3vw]">{p.name}</span>
            </div>
            <div className="flex gap-[4vw] text-[2.8vw] text-zinc-500">
              <span>{p.pts}p</span><span>{p.reb}r</span><span>{p.ast}a</span>
            </div>
          </div>
        ))}
      </div>

      {/* Bottom tagline */}
      <div className="pb-[6vh] pt-[3vh] text-center flex-shrink-0">
        <p className="text-zinc-400 text-[3vw] font-medium">Tap a player. Tap a stat.<br />Your clipboard can retire.</p>
      </div>
    </div>
  );
}
