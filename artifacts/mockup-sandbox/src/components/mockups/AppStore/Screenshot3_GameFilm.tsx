// App Store Screenshot 3 — "Built-In Game Film"
export default function Screenshot3_GameFilm() {
  const stats = [
    { name: "Marcus J.", pts: 22, reb: 8, ast: 5, fgm: 9, fga: 17 },
    { name: "Devon W.", pts: 14, reb: 11, ast: 2, fgm: 6, fga: 13 },
    { name: "Tyrell B.", pts: 10, reb: 4, ast: 9, fgm: 4, fga: 10 },
  ];

  return (
    <div className="w-full h-screen bg-black flex flex-col items-center justify-between overflow-hidden" style={{fontFamily: "'SF Pro Display', -apple-system, sans-serif"}}>
      <div className="pt-10 pb-4 flex flex-col items-center gap-2">
        <div className="bg-orange-500 rounded-full px-4 py-1 text-xs font-bold text-white tracking-widest uppercase">StecStats</div>
        <p className="text-white text-2xl font-bold tracking-tight text-center leading-tight">Game Film +<br/>Box Score, Together.</p>
      </div>

      <div className="relative flex-1 flex items-center justify-center w-full px-8">
        <div className="w-full max-w-xs bg-zinc-900 rounded-3xl overflow-hidden shadow-2xl border border-zinc-700" style={{aspectRatio: "9/19"}}>
          <div className="bg-black px-5 pt-3 pb-1 flex justify-between items-center">
            <span className="text-white text-xs font-semibold">9:41</span>
            <div className="w-4 h-2 border border-white rounded-sm"><div className="h-full w-3/4 bg-white rounded-sm"/></div>
          </div>

          {/* Game title */}
          <div className="bg-zinc-950 px-4 pt-3 pb-2 border-b border-zinc-800">
            <div className="flex justify-between items-start">
              <div>
                <div className="text-white font-bold text-sm">Eagles vs. Wildcats</div>
                <div className="text-zinc-500 text-xs mt-0.5">Mar 14 • Varsity</div>
              </div>
              <div className="text-right">
                <span className="text-orange-400 font-black text-lg">68</span>
                <span className="text-zinc-500 font-bold text-lg"> – </span>
                <span className="text-zinc-400 font-black text-lg">54</span>
              </div>
            </div>
          </div>

          {/* Video player mock */}
          <div className="bg-zinc-950 mx-3 mt-3 rounded-xl overflow-hidden border border-zinc-700">
            <div className="bg-zinc-800 relative" style={{aspectRatio: "16/9"}}>
              {/* Court lines suggestion */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="border border-zinc-600 rounded-lg w-20 h-14 opacity-30"/>
                <div className="absolute w-8 h-8 border border-zinc-600 rounded-full opacity-30"/>
              </div>
              {/* Play button */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur flex items-center justify-center">
                  <div className="w-0 h-0 ml-1" style={{borderTop: "6px solid transparent", borderBottom: "6px solid transparent", borderLeft: "10px solid white"}}/>
                </div>
              </div>
              {/* Timestamp */}
              <div className="absolute bottom-1.5 right-2 text-white text-xs bg-black/50 rounded px-1">32:14</div>
            </div>
            {/* Scrubber */}
            <div className="px-3 py-2">
              <div className="h-1 bg-zinc-700 rounded-full">
                <div className="h-full w-2/5 bg-orange-500 rounded-full"/>
              </div>
            </div>
          </div>

          {/* Tab bar */}
          <div className="mx-3 mt-2 flex bg-zinc-800 rounded-lg p-0.5">
            <div className="flex-1 bg-zinc-900 rounded-md py-1 text-center text-xs text-white font-semibold">Box Score</div>
            <div className="flex-1 py-1 text-center text-xs text-zinc-500">Highlights</div>
            <div className="flex-1 py-1 text-center text-xs text-zinc-500">Lowlights</div>
          </div>

          {/* Box score rows */}
          <div className="mx-3 mt-2 space-y-1">
            {/* Header */}
            <div className="flex justify-between px-2">
              <span className="text-zinc-600 text-xs w-20">PLAYER</span>
              <div className="flex gap-3 text-zinc-600 text-xs">
                <span className="w-6 text-center">PTS</span>
                <span className="w-6 text-center">REB</span>
                <span className="w-6 text-center">AST</span>
                <span className="w-12 text-center">FG</span>
              </div>
            </div>
            {stats.map((p, i) => (
              <div key={p.name} className={`flex justify-between items-center px-2 py-1 rounded-lg ${i === 0 ? "bg-orange-500/10" : ""}`}>
                <span className={`text-xs w-20 truncate ${i === 0 ? "text-white font-semibold" : "text-zinc-400"}`}>{p.name.split(" ")[0]}</span>
                <div className="flex gap-3 text-xs">
                  <span className={`w-6 text-center font-semibold ${i === 0 ? "text-orange-400" : "text-zinc-300"}`}>{p.pts}</span>
                  <span className="w-6 text-center text-zinc-400">{p.reb}</span>
                  <span className="w-6 text-center text-zinc-400">{p.ast}</span>
                  <span className="w-12 text-center text-zinc-500">{p.fgm}/{p.fga}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="pb-10 text-center px-6">
        <p className="text-zinc-400 text-sm font-medium">Watch the game. See the stats.<br/>No second screen needed.</p>
      </div>
    </div>
  );
}
