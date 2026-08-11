// App Store Screenshot 4 — "Highlights Generated Automatically"
export default function Screenshot4_Highlights() {
  const clips = [
    { player: "Marcus J.", event: "3-pointer", time: "Q1 • 4:12", made: true },
    { player: "Devon W.", event: "Defensive rebound", time: "Q1 • 3:47", made: true },
    { player: "Marcus J.", event: "Assist → layup", time: "Q2 • 8:02", made: true },
    { player: "Tyrell B.", event: "Steal + fastbreak", time: "Q2 • 5:31", made: true },
    { player: "Kai S.", event: "Missed 3-pointer", time: "Q2 • 3:14", made: false },
    { player: "Jordan M.", event: "And-one drive", time: "Q3 • 7:44", made: true },
  ];

  return (
    <div className="w-screen h-screen bg-black flex flex-col overflow-hidden"
      style={{ fontFamily: "'SF Pro Display', -apple-system, sans-serif" }}>

      <div className="flex flex-col items-center gap-[2vh] pt-[6vh] pb-[3vh] flex-shrink-0">
        <div className="bg-orange-500 rounded-full px-[4vw] py-[1vh] text-[2vw] font-black text-white tracking-widest uppercase">StecStats</div>
        <p className="text-white text-[6vw] font-black tracking-tight text-center leading-tight">Highlights Generated<br />Automatically.</p>
      </div>

      {/* Reel card */}
      <div className="mx-[6vw] bg-zinc-900 rounded-2xl overflow-hidden flex-shrink-0">
        <div className="bg-zinc-800 relative" style={{ aspectRatio: "16/9" }}>
          <div className="absolute top-[2vh] right-[2vw] bg-orange-500 rounded-full px-[2.5vw] py-[0.8vh] text-white text-[2.3vw] font-black">AUTO</div>
          <div className="absolute bottom-[2vh] left-[3vw] bg-black/60 backdrop-blur rounded-xl px-[2.5vw] py-[1vh] flex items-center gap-[2vw]">
            <div style={{ width: 0, height: 0, borderTop: "1.5vw solid transparent", borderBottom: "1.5vw solid transparent", borderLeft: "2.5vw solid #f97316" }} />
            <span className="text-white text-[2.8vw] font-bold">PLAY REEL</span>
            <span className="text-zinc-400 text-[2.5vw]">• 1:42</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="mx-[6vw] mt-[2vh] flex bg-zinc-800 rounded-2xl p-[0.5vh] flex-shrink-0">
        <div className="flex-1 bg-zinc-900 rounded-xl py-[1.5vh] text-center text-[2.8vw] text-orange-400 font-semibold">Highlights</div>
        <div className="flex-1 py-[1.5vh] text-center text-[2.8vw] text-zinc-500">Lowlights</div>
      </div>

      {/* Clip list */}
      <div className="mx-[6vw] mt-[2vh] space-y-[1.5vh] flex-1 min-h-0">
        {clips.map((c, i) => (
          <div key={i} className="bg-zinc-900 rounded-2xl px-[4vw] py-[2vh] flex items-center gap-[3vw]">
            <div className={`w-[9vw] h-[9vw] rounded-xl flex items-center justify-center text-[4vw] flex-shrink-0 ${c.made ? "bg-green-500/20" : "bg-red-500/20"}`}>
              {c.made ? "🔥" : "❌"}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-white text-[3vw] font-semibold truncate">{c.event}</div>
              <div className="text-zinc-500 text-[2.5vw] mt-[0.3vh]">{c.player} • {c.time}</div>
            </div>
            <div className="w-[8vw] h-[8vw] rounded-full bg-zinc-800 flex items-center justify-center flex-shrink-0">
              <div className="ml-[0.5vw]" style={{ width: 0, height: 0, borderTop: "1.3vw solid transparent", borderBottom: "1.3vw solid transparent", borderLeft: "2vw solid #71717a" }} />
            </div>
          </div>
        ))}
      </div>

      <div className="pb-[6vh] pt-[2vh] text-center flex-shrink-0">
        <p className="text-zinc-400 text-[3vw] font-medium">Every big play, clipped and ready.<br />No editing required.</p>
      </div>
    </div>
  );
}
