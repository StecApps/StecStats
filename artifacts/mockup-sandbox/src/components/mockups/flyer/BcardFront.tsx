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

        {/* Background basketball watermark */}
        <svg
          style={{ position: "absolute", right: "-40px", top: "50%", transform: "translateY(-50%)", opacity: 0.04 }}
          width="320" height="320" viewBox="0 0 48 48"
        >
          <circle cx="24" cy="24" r="22" fill="#f97316" />
          <path d="M24 2 C24 2 24 46 24 46" stroke="white" strokeWidth="2.5" />
          <path d="M2 24 C2 24 46 24 46 24" stroke="white" strokeWidth="2.5" />
          <path d="M6 10 C14 16 14 32 6 38" stroke="white" strokeWidth="2.5" fill="none" />
          <path d="M42 10 C34 16 34 32 42 38" stroke="white" strokeWidth="2.5" fill="none" />
        </svg>

        {/* Main content */}
        <div style={{ padding: "36px 44px 0", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          {/* Logo row */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "28px" }}>
            <img src="/__mockup/logo.png" alt="StecStats" style={{ height: "48px", width: "auto", objectFit: "contain" }} />
          </div>

          {/* Tagline */}
          <div style={{ fontSize: "15px", color: "#9a9290", lineHeight: "1.55", maxWidth: "380px" }}>
            Stats · Video · Live Streaming · Highlight Reels
            <br />
            <span style={{ color: "#d1ccc9" }}>Everything a coach needs, from one phone.</span>
          </div>
        </div>

        {/* Bottom row */}
        <div style={{ padding: "0 44px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: "11px", color: "#4a4442", fontWeight: "600", textTransform: "uppercase", letterSpacing: "1.5px", marginBottom: "6px" }}>
              Free 14-day trial
            </div>
            <div style={{ fontSize: "20px", fontWeight: "800", color: "#f97316" }}>stecstats.com</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "13px", color: "#6b6562" }}>From</div>
            <div style={{ fontSize: "22px", fontWeight: "800", color: "#ffffff" }}>$9.99<span style={{ fontSize: "13px", fontWeight: "400", color: "#6b6562" }}>/mo</span></div>
          </div>
        </div>

        {/* Bottom accent bar */}
        <div style={{ height: "5px", background: "linear-gradient(90deg, #f97316, #ea580c)", flexShrink: 0 }} />
      </div>
    </div>
  );
}
