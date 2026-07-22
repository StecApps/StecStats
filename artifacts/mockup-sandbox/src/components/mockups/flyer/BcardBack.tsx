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

        {/* Icon watermark — centered behind content */}
        <img
          src="/__mockup/icon-512.png"
          alt=""
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: "360px",
            height: "360px",
            objectFit: "contain",
            opacity: 0.15,
            pointerEvents: "none",
          }}
        />

        {/* Main content */}
        <div style={{ flex: 1, display: "flex", alignItems: "center", padding: "0 44px", position: "relative" }}>

          {/* Left: bullets */}
          <div style={{ flex: 1, paddingRight: "40px" }}>
            <div style={{ marginBottom: "14px" }}>
              <img src="/__mockup/logo.png" alt="StecStats" style={{ height: "32px", width: "auto", objectFit: "contain" }} />
            </div>

            {/* Audience row */}
            <div style={{ display: "flex", gap: "6px", marginBottom: "16px" }}>
              {["Coaches", "Parents"].map((label) => (
                <div
                  key={label}
                  style={{
                    fontSize: "9px",
                    fontWeight: "700",
                    color: "#f97316",
                    border: "1px solid rgba(249,115,22,0.5)",
                    borderRadius: "20px",
                    padding: "2px 8px",
                    letterSpacing: "0.5px",
                    textTransform: "uppercase",
                  }}
                >
                  {label}
                </div>
              ))}
            </div>

            {[
              { icon: "📊", text: "Live stat tracking — every player, every game" },
              { icon: "📹", text: "Auto game video upload from your phone" },
              { icon: "📡", text: "Live stream so parents never miss a game" },
              { icon: "🏆", text: "Highlight reels ready in minutes" },
            ].map((item) => (
              <div key={item.text} style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "11px" }}>
                <span style={{ fontSize: "16px", flexShrink: 0 }}>{item.icon}</span>
                <span style={{ fontSize: "12px", color: "#d1ccc9", lineHeight: "1.4" }}>{item.text}</span>
              </div>
            ))}
          </div>

          {/* Divider */}
          <div style={{ width: "1px", height: "200px", background: "#1e1a18", flexShrink: 0 }} />

          {/* Right: contact + QR */}
          <div style={{ paddingLeft: "40px", display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
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
              <div style={{ fontSize: "11px", color: "#d1ccc9", marginBottom: "3px" }}>401-365-0933</div>
              <div style={{ fontSize: "10px", color: "#9a9290" }}>Sstec@stecstats.com</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "9px", color: "#4a4442" }}>14-day free trial</div>
              <div style={{ fontSize: "10px", color: "#6b6562" }}>$9.99/mo · $79/yr</div>
            </div>
          </div>
        </div>

        {/* Bottom accent bar */}
        <div style={{ height: "5px", background: "linear-gradient(90deg, #f97316, #ea580c)", flexShrink: 0 }} />
      </div>
    </div>
  );
}
