// App Store Screenshot 4 — "Auto-Generated Highlights"
export default function Screenshot4_Highlights() {
  const clips = [
    { player: "Marcus J.", event: "3-pointer", time: "Q1 • 4:12", made: true },
    { player: "Devon W.", event: "Defensive rebound", time: "Q1 • 3:47", made: true },
    { player: "Marcus J.", event: "Assist → layup", time: "Q2 • 8:02", made: true },
    { player: "Tyrell B.", event: "Steal + fastbreak", time: "Q2 • 5:31", made: true },
    { player: "Kai S.", event: "Missed 3-pointer", time: "Q2 • 3:14", made: false },
  ];

  return (
    <div className="w-full h-screen bg-black flex flex-col items-center justify-between overflow-hidden" style={{fontFamily: "'SF Pro Display', -apple-system, sans-serif"}}>
      <div className="pt-10 pb-4 flex flex-col items-center gap-2">
        <div className="bg-orange-500 rounded-full px-4 py-1 text-xs font-bold text-white tracking-widest uppercase">StecStats</div>
        <p className="text-white text-2xl font-bold tracking-tight text-center leading-tight">Highlights Generated<br/>Automatically.</p>
      </div>

      <div className="relative flex-1 flex items-center justify-center w-full px-8">
        <div className="w-full max-w-xs bg-zinc-900 rounded-3xl overflow-hidden shadow-2xl border border-zinc-700" style={{aspectRatio: "9/19"}}>
          <div className="bg-black px-5 pt-3 pb-1 flex justify-between items-center">
            <span className="text-white text-xs font-semibold">9:41</span>
            <div className="w-4 h-2 border border-white rounded-sm"><div className="h-full w-3/4 bg-white rounded-sm"/></div>
          </div>

          {/* Header */}
          <div className="bg-zinc-950 px-4 pt-3 pb-2 border-b border-zinc-800">
            <div className="text-white font-bold text-sm">Eagles vs. Wildcats</div>
            <div className="text-zinc-500 text-xs">Highlight Reel • 5 plays</div>
          </div>

          {/* Reel preview */}
          <div className="bg-zinc-950 mx-3 mt-3 rounded-xl overflow-hidden border border-zinc-800">
            <div className="bg-gradient-to-br from-zinc-800 to-zinc-900 relative" style={{aspectRatio: "16/9"}}>
              <div className="absolute inset-0 flex items-end p-2">
                <div className="bg-black/60 backdrop-blur rounded-lg px-2 py-1 flex items-center gap-1.5">
                  <div className="w-0 h-0" style={{borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "7px solid #f97316"}}/>
                  <span className="text-white text-xs font-bold">PLAY REEL</span>
                  <span className="text-zinc-400 text-xs">• 1:42</span>
                </div>
              </div>
              {/* Badge */}
              <div className="absolute top-2 right-2 bg-orange-500 rounded-full px-2 py-0.5 text-white text-xs font-bold">AUTO</div>
            </div>
          </div>

          {/* Tab bar */}
          <div className="mx-3 mt-2 flex bg-zinc-800 rounded-lg p-0.5">
            <div className="flex-1 bg-zinc-900 rounded-md py-1 text-center text-xs text-orange-400 font-semibold">Highlights</div>
            <div className="flex-1 py-1 text-center text-xs text-zinc-500">Lowlights</div>
          </div>

          {/* Clip list */}
          <div className="mx-3 mt-2 space-y-1.5">
            {clips.map((c, i) => (
              <div key={i} className="bg-zinc-800/60 rounded-xl px-3 py-2 flex items-center gap-2">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-sm flex-shrink-0 ${c.made ? "bg-green-500/20" : "bg-red-500/20"}`}>
                  {c.made ? "🔥" : "❌"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-white text-xs font-semibold truncate">{c.event}</div>
                  <div className="text-zinc-500 text-xs">{c.player} • {c.time}</div>
                </div>
                <div className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center flex-shrink-0">
                  <div className="w-0 h-0 ml-0.5" style={{borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "6px solid #a1a1aa"}}/>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="pb-10 text-center px-6">
        <p className="text-zinc-400 text-sm font-medium">Every big play, clipped and ready.<br/>No editing required.</p>
      </div>
    </div>
  );
}
