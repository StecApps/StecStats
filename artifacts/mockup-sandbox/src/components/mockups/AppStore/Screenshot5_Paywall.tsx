// App Store Screenshot 5 — "Built for Every Level of Coach"
export default function Screenshot5_Paywall() {
  const tiers = [
    {
      name: "Free",
      price: "$0",
      sub: "forever",
      features: ["Live stat tracking", "1 team / 1 season", "Career player stats"],
      cta: "Current Plan",
      active: false,
    },
    {
      name: "Pro",
      price: "$9.99",
      sub: "/ month",
      features: ["Everything in Free", "Video recording", "Unlimited teams", "Auto highlights"],
      cta: "Start Free Trial",
      active: true,
    },
    {
      name: "Premium",
      price: "$19.99",
      sub: "/ month",
      features: ["Everything in Pro", "YouTube live stream", "Advanced film tools", "Priority support"],
      cta: "Upgrade",
      active: false,
    },
  ];

  return (
    <div className="w-screen h-screen bg-black flex flex-col overflow-hidden"
      style={{ fontFamily: "'SF Pro Display', -apple-system, sans-serif" }}>

      <div className="flex flex-col items-center gap-[2vh] pt-[6vh] pb-[3vh] flex-shrink-0">
        <div className="bg-orange-500 rounded-full px-[4vw] py-[1vh] text-[2vw] font-black text-white tracking-widest uppercase">StecStats</div>
        <p className="text-white text-[6vw] font-black tracking-tight text-center leading-tight">Built for Every<br />Level of Coach.</p>
      </div>

      <div className="mx-[6vw] text-center flex-shrink-0">
        <div className="text-zinc-400 text-[3vw]">7-day free trial on Pro &amp; Premium</div>
      </div>

      {/* Tier cards */}
      <div className="mx-[6vw] mt-[3vh] space-y-[2vh] flex-1 min-h-0">
        {tiers.map((t) => (
          <div key={t.name} className={`rounded-2xl border p-[4vw] ${t.active ? "bg-orange-500/10 border-orange-500" : "bg-zinc-900 border-zinc-800"}`}>
            <div className="flex justify-between items-start">
              <div>
                <div className={`font-black text-[4vw] ${t.active ? "text-orange-400" : "text-zinc-300"}`}>{t.name}</div>
                <div className="flex items-baseline gap-[1vw] mt-[0.5vh]">
                  <span className={`font-black text-[6vw] ${t.active ? "text-white" : "text-zinc-400"}`}>{t.price}</span>
                  <span className="text-zinc-500 text-[2.8vw]">{t.sub}</span>
                </div>
              </div>
              {t.active && (
                <div className="bg-orange-500 rounded-full px-[2.5vw] py-[0.8vh] text-white text-[2.3vw] font-black">POPULAR</div>
              )}
            </div>
            <div className="mt-[1.5vh] space-y-[0.8vh]">
              {t.features.map(f => (
                <div key={f} className="flex items-center gap-[2vw]">
                  <span className={`text-[3vw] ${t.active ? "text-green-400" : "text-zinc-600"}`}>✓</span>
                  <span className={`text-[2.8vw] ${t.active ? "text-zinc-200" : "text-zinc-500"}`}>{f}</span>
                </div>
              ))}
            </div>
            <button className={`mt-[2vh] w-full py-[1.8vh] rounded-xl text-[3vw] font-black ${
              t.active ? "bg-orange-500 text-white" : t.name === "Free" ? "bg-zinc-800 text-zinc-500" : "border border-zinc-700 text-zinc-400"
            }`}>
              {t.cta}
            </button>
          </div>
        ))}
      </div>

      <div className="pb-[6vh] pt-[2vh] text-center flex-shrink-0">
        <p className="text-zinc-400 text-[3vw] font-medium">Free forever. Upgrade when you're ready.<br />Cancel anytime.</p>
      </div>
    </div>
  );
}
