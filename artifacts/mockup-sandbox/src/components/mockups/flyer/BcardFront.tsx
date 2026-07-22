export function BcardFront() {
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

        {/* Icon watermark */}
        <img
          src="/__mockup/icon-512.png"
          alt=""
          style={{
            position: "absolute",
            right: "-70px",
            top: "50%",
            transform: "translateY(-50%)",
            width: "380px",
            height: "380px",
            objectFit: "contain",
            opacity: 0.18,
            pointerEvents: "none",
          }}
        />

        {/* Main content */}
        <div style={{ padding: "36px 44px 0", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", position: "relative" }}>
          {/* Logo */}
          <div style={{ marginBottom: "20px" }}>
            <img src="/__mockup/logo.png" alt="StecStats" style={{ height: "48px", width: "auto", objectFit: "contain" }} />
          </div>

          {/* Audience badge */}
          <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
            {["For Coaches", "For Parents"].map((label) => (
              <div
                key={label}
                style={{
                  fontSize: "10px",
                  fontWeight: "700",
                  color: "#f97316",
                  border: "1px solid #f97316",
                  borderRadius: "20px",
                  padding: "3px 10px",
                  letterSpacing: "0.5px",
                  textTransform: "uppercase",
                }}
              >
                {label}
              </div>
            ))}
          </div>

          {/* Tagline */}
          <div style={{ fontSize: "14px", color: "#9a9290", lineHeight: "1.6", maxWidth: "360px" }}>
            Stats · Video · Live Streaming · Highlight Reels
            <br />
            <span style={{ color: "#d1ccc9" }}>One app. Every game. The whole team.</span>
          </div>
        </div>

        {/* Bottom row */}
        <div style={{ padding: "0 44px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative" }}>
          <div>
            <div style={{ fontSize: "11px", color: "#4a4442", fontWeight: "600", textTransform: "uppercase", letterSpacing: "1.5px", marginBottom: "5px" }}>
              Free 14-day trial
            </div>
            <div style={{ fontSize: "20px", fontWeight: "800", color: "#f97316" }}>stecstats.com</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "12px", color: "#6b6562" }}>From</div>
            <div style={{ fontSize: "22px", fontWeight: "800", color: "#ffffff" }}>$9.99<span style={{ fontSize: "13px", fontWeight: "400", color: "#6b6562" }}>/mo</span></div>
          </div>
        </div>

        {/* Bottom accent bar */}
        <div style={{ height: "5px", background: "linear-gradient(90deg, #f97316, #ea580c)", flexShrink: 0 }} />
      </div>
    </div>
  );
}
