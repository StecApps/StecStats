// App Store Screenshot 3 — "Game Film + Box Score, Together"
export default function Screenshot3_GameFilm() {
  const stats = [
    { name: "Marcus J.", pts: 22, reb: 8, ast: 5, fgm: 9, fga: 17 },
    { name: "Devon W.", pts: 14, reb: 11, ast: 2, fgm: 6, fga: 13 },
    { name: "Tyrell B.", pts: 10, reb: 4, ast: 9, fgm: 4, fga: 10 },
    { name: "Kai S.", pts: 8, reb: 5, ast: 3, fgm: 3, fga: 8 },
    { name: "Jordan M.", pts: 6, reb: 3, ast: 2, fgm: 2, fga: 6 },
  ];

  return (
    <div className="w-screen h-screen bg-black flex flex-col overflow-hidden"
      style={{ fontFamily: "'SF Pro Display', -apple-system, sans-serif" }}>

      <div className="flex flex-col items-center gap-[2vh] pt-[6vh] pb-[3vh] flex-shrink-0">
        <div className="bg-orange-500 rounded-full px-[4vw] py-[1vh] text-[2vw] font-black text-white tracking-widest uppercase">StecStats</div>
        <p className="text-white text-[6vw] font-black tracking-tight text-center leading-tight">Game Film +<br />Box Score, Together.</p>
      </div>

      {/* Game header */}
      <div className="mx-[6vw] bg-zinc-900 rounded-2xl px-[5vw] py-[2vh] flex justify-between items-center flex-shrink-0">
        <div>
          <div className="text-white font-bold text-[3.5vw]">Eagles vs. Wildcats</div>
          <div className="text-zinc-500 text-[2.8vw] mt-[0.5vh]">Mar 14 • Varsity</div>
        </div>
        <div>
          <span className="text-orange-400 font-black text-[7vw]">68</span>
          <span className="text-zinc-500 font-black text-[5vw]"> – </span>
          <span className="text-zinc-400 font-black text-[7vw]">54</span>
        </div>
      </div>

      {/* Video player */}
      <div className="mx-[6vw] mt-[2vh] bg-zinc-900 rounded-2xl overflow-hidden flex-shrink-0">
        <div className="bg-zinc-800 relative" style={{ aspectRatio: "16/9" }}>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="border border-zinc-600 rounded-lg opacity-20" style={{ width: "30%", height: "60%" }} />
            <div className="absolute rounded-full border border-zinc-600 opacity-20" style={{ width: "20%", aspectRatio: "1" }} />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-[12vw] h-[12vw] rounded-full bg-white/20 backdrop-blur flex items-center justify-center">
              <div className="ml-[1vw]" style={{ width: 0, height: 0, borderTop: "2.5vw solid transparent", borderBottom: "2.5vw solid transparent", borderLeft: "4vw solid white" }} />
            </div>
          </div>
          <div className="absolute bottom-[1.5vh] right-[2vw] text-white text-[2.5vw] bg-black/60 rounded px-[1.5vw] py-[0.5vh]">32:14</div>
        </div>
        <div className="px-[4vw] py-[1.5vh]">
          <div className="h-[0.8vh] bg-zinc-700 rounded-full">
            <div className="h-full w-2/5 bg-orange-500 rounded-full" />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="mx-[6vw] mt-[2vh] flex bg-zinc-800 rounded-2xl p-[0.5vh] flex-shrink-0">
        <div className="flex-1 bg-zinc-900 rounded-xl py-[1.5vh] text-center text-[2.8vw] text-white font-semibold">Box Score</div>
        <div className="flex-1 py-[1.5vh] text-center text-[2.8vw] text-zinc-500">Highlights</div>
        <div className="flex-1 py-[1.5vh] text-center text-[2.8vw] text-zinc-500">Lowlights</div>
      </div>

      {/* Box score */}
      <div className="mx-[6vw] mt-[1.5vh] flex justify-between px-[2vw] flex-shrink-0">
        <span className="text-zinc-500 text-[2.3vw] w-[30vw]">PLAYER</span>
        <div className="flex gap-[3vw] text-zinc-500 text-[2.3vw]">
          <span className="w-[8vw] text-center">PTS</span>
          <span className="w-[8vw] text-center">REB</span>
          <span className="w-[8vw] text-center">AST</span>
          <span className="w-[12vw] text-center">FG</span>
        </div>
      </div>
      <div className="mx-[6vw] mt-[1vh] space-y-[1.5vh] flex-1 min-h-0">
        {stats.map((p, i) => (
          <div key={p.name} className={`flex justify-between items-center px-[3vw] py-[1.5vh] rounded-xl ${i === 0 ? "bg-orange-500/10" : ""}`}>
            <span className={`text-[3vw] w-[30vw] truncate ${i === 0 ? "text-white font-semibold" : "text-zinc-400"}`}>{p.name.split(" ")[0]}</span>
            <div className="flex gap-[3vw] text-[3vw]">
              <span className={`w-[8vw] text-center font-bold ${i === 0 ? "text-orange-400" : "text-zinc-300"}`}>{p.pts}</span>
              <span className="w-[8vw] text-center text-zinc-500">{p.reb}</span>
              <span className="w-[8vw] text-center text-zinc-500">{p.ast}</span>
              <span className="w-[12vw] text-center text-zinc-500">{p.fgm}/{p.fga}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="pb-[6vh] pt-[2vh] text-center flex-shrink-0">
        <p className="text-zinc-400 text-[3vw] font-medium">Watch the game. See the stats.<br />No second screen needed.</p>
      </div>
    </div>
  );
}
