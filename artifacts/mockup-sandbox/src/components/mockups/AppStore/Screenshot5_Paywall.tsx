// App Store Screenshot 5 — "Built for Every Level of Coach"
export default function Screenshot5_Paywall() {
  const tiers = [
    {
      name: "Free",
      price: "$0",
      sub: "forever",
      color: "zinc",
      features: ["Live stat tracking", "1 team / 1 season", "Career player stats"],
      cta: "Current Plan",
      active: false,
    },
    {
      name: "Pro",
      price: "$9.99",
      sub: "/ month",
      color: "orange",
      features: ["Everything in Free", "Video recording", "Unlimited teams", "Auto highlights"],
      cta: "Start Free Trial",
      active: true,
    },
    {
      name: "Premium",
      price: "$19.99",
      sub: "/ month",
      color: "amber",
      features: ["Everything in Pro", "YouTube live stream", "Advanced film tools", "Priority support"],
      cta: "Upgrade",
      active: false,
    },
  ];

  return (
    <div className="w-full h-screen bg-black flex flex-col items-center justify-between overflow-hidden" style={{fontFamily: "'SF Pro Display', -apple-system, sans-serif"}}>
      <div className="pt-10 pb-4 flex flex-col items-center gap-2">
        <div className="bg-orange-500 rounded-full px-4 py-1 text-xs font-bold text-white tracking-widest uppercase">StecStats</div>
        <p className="text-white text-2xl font-bold tracking-tight text-center leading-tight">Built for Every<br/>Level of Coach.</p>
      </div>

      <div className="relative flex-1 flex items-center justify-center w-full px-8">
        <div className="w-full max-w-xs bg-zinc-900 rounded-3xl overflow-hidden shadow-2xl border border-zinc-700" style={{aspectRatio: "9/19"}}>
          <div className="bg-black px-5 pt-3 pb-1 flex justify-between items-center">
            <span className="text-white text-xs font-semibold">9:41</span>
            <div className="w-4 h-2 border border-white rounded-sm"><div className="h-full w-3/4 bg-white rounded-sm"/></div>
          </div>

          {/* Header */}
          <div className="bg-zinc-950 px-4 pt-3 pb-3 text-center border-b border-zinc-800">
            <div className="text-white font-bold text-sm">Choose Your Plan</div>
            <div className="text-zinc-400 text-xs mt-0.5">7-day free trial on Pro & Premium</div>
          </div>

          {/* Tier cards */}
          <div className="px-3 pt-3 space-y-2">
            {tiers.map((t) => (
              <div
                key={t.name}
                className={`rounded-2xl border p-3 ${
                  t.active
                    ? "bg-orange-500/10 border-orange-500"
                    : "bg-zinc-800/40 border-zinc-700"
                }`}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <div className={`font-bold text-sm ${t.active ? "text-orange-400" : "text-zinc-300"}`}>{t.name}</div>
                    <div className="flex items-baseline gap-0.5 mt-0.5">
                      <span className={`font-black text-lg ${t.active ? "text-white" : "text-zinc-400"}`}>{t.price}</span>
                      <span className="text-zinc-500 text-xs">{t.sub}</span>
                    </div>
                  </div>
                  {t.active && (
                    <div className="bg-orange-500 rounded-full px-2 py-0.5 text-white text-xs font-bold">POPULAR</div>
                  )}
                </div>
                <div className="mt-2 space-y-0.5">
                  {t.features.map(f => (
                    <div key={f} className="flex items-center gap-1.5">
                      <span className={`text-xs ${t.active ? "text-green-400" : "text-zinc-500"}`}>✓</span>
                      <span className={`text-xs ${t.active ? "text-zinc-200" : "text-zinc-500"}`}>{f}</span>
                    </div>
                  ))}
                </div>
                <button className={`mt-2 w-full py-1.5 rounded-xl text-xs font-bold ${
                  t.active
                    ? "bg-orange-500 text-white"
                    : t.name === "Free"
                    ? "bg-zinc-700 text-zinc-400"
                    : "border border-zinc-600 text-zinc-400"
                }`}>
                  {t.cta}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="pb-10 text-center px-6">
        <p className="text-zinc-400 text-sm font-medium">Free forever. Upgrade when you're ready.<br/>Cancel anytime.</p>
      </div>
    </div>
  );
}
