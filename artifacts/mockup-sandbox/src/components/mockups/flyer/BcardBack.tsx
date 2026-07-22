export function BcardBack() {
  return (
    <div style={{ background: "#1a1a1a", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "32px" }}>
      <div
        style={{
          width: "638px",
          height: "363px",
          background: "#0a0807",
          borderRadius: "12px",
          position: "relative",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          fontFamily: "'Inter', 'Helvetica Neue', Arial, sans-serif",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
        }}
      >
        {/* Top accent bar */}
        <div style={{ height: "5px", background: "linear-gradient(90deg, #f97316, #ea580c)", flexShrink: 0 }} />

        {/* Main content */}
        <div style={{ flex: 1, display: "flex", alignItems: "center", padding: "0 44px" }}>

          {/* Left: 4 bullets */}
          <div style={{ flex: 1, paddingRight: "40px" }}>
            <div style={{ fontSize: "11px", color: "#f97316", fontWeight: "700", textTransform: "uppercase", letterSpacing: "2px", marginBottom: "20px" }}>
              What you get
            </div>
            {[
              { icon: "📊", text: "Live stat tracking — per player, per game" },
              { icon: "📹", text: "Auto game video upload from your phone" },
              { icon: "📡", text: "Live stream to parents in one tap" },
              { icon: "🏆", text: "Highlight reels in minutes" },
            ].map((item) => (
              <div key={item.text} style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "14px" }}>
                <span style={{ fontSize: "18px", flexShrink: 0 }}>{item.icon}</span>
                <span style={{ fontSize: "13px", color: "#d1ccc9", lineHeight: "1.4" }}>{item.text}</span>
              </div>
            ))}
          </div>

          {/* Divider */}
          <div style={{ width: "1px", height: "200px", background: "#1e1a18", flexShrink: 0 }} />

          {/* Right: QR + URL + price */}
          <div style={{ paddingLeft: "40px", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
            <div style={{ background: "#ffffff", padding: "8px", borderRadius: "8px" }}>
              <img
                src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=https://stecstats.com&bgcolor=ffffff&color=0a0807&margin=0"
                alt="QR code"
                width={100}
                height={100}
                style={{ display: "block" }}
              />
            </div>
            <div style={{ fontSize: "14px", fontWeight: "700", color: "#f97316" }}>stecstats.com</div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "11px", color: "#4a4442", marginBottom: "3px" }}>14-day free trial</div>
              <div style={{ fontSize: "13px", color: "#9a9290" }}>$9.99/mo · $79/yr</div>
            </div>
          </div>
        </div>

        {/* Bottom accent bar */}
        <div style={{ height: "5px", background: "linear-gradient(90deg, #f97316, #ea580c)", flexShrink: 0 }} />
      </div>
    </div>
  );
}
