export function CoachFlyer() {
  return (
    <div className="bg-white flex items-start justify-center min-h-screen p-4">
      <div
        style={{
          width: "816px",
          minHeight: "1056px",
          background: "#0a0807",
          fontFamily: "'Inter', 'Helvetica Neue', Arial, sans-serif",
          position: "relative",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Top orange stripe */}
        <div style={{ height: "6px", background: "linear-gradient(90deg, #f97316, #ea580c)" }} />

        {/* Icon watermark */}
        <img
          src="/__mockup/icon-512.png"
          alt=""
          style={{
            position: "absolute",
            right: "-80px",
            top: "60px",
            width: "500px",
            height: "500px",
            objectFit: "contain",
            opacity: 0.05,
            pointerEvents: "none",
          }}
        />

        {/* Header */}
        <div style={{ padding: "48px 56px 36px", borderBottom: "1px solid #1e1a18", position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "20px", marginBottom: "20px" }}>
            <img src="/__mockup/logo.png" alt="StecStats" style={{ height: "64px", width: "auto", objectFit: "contain" }} />
            <div style={{ display: "flex", gap: "8px" }}>
              {["For Coaches", "For Parents"].map((label) => (
                <div
                  key={label}
                  style={{
                    fontSize: "11px",
                    fontWeight: "700",
                    color: "#f97316",
                    border: "1px solid #f97316",
                    borderRadius: "20px",
                    padding: "4px 12px",
                    letterSpacing: "0.5px",
                    textTransform: "uppercase",
                  }}
                >
                  {label}
                </div>
              ))}
            </div>
          </div>
          <div style={{ fontSize: "22px", color: "#d1ccc9", fontWeight: "400", lineHeight: "1.4", maxWidth: "580px" }}>
            The all-in-one app for coaches who want{" "}
            <span style={{ color: "#f97316", fontWeight: "600" }}>real stats, real video, and parents who never miss a moment</span>
            {" "}— all from one phone.
          </div>
        </div>

        {/* Pitch blocks */}
        <div style={{ padding: "40px 56px", flex: 1 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>

            {[
              {
                icon: "📊",
                headline: "Stats in real time",
                body: "Tap to track points, assists, rebounds & fouls during the game. Every player gets a season stat card automatically.",
              },
              {
                icon: "📹",
                headline: "Full game video",
                body: "Record from your phone and it uploads automatically after. Stats + film in one place, no extra equipment needed.",
              },
              {
                icon: "📡",
                headline: "Live stream to parents",
                body: "Stream directly to parents watching from home. They open a link in their browser — no app download required.",
              },
              {
                icon: "🏆",
                headline: "Auto highlight reels",
                body: "Pick the best plays and generate a highlight video. Players can share clips directly for recruiting and social media.",
              },
            ].map((item) => (
              <div
                key={item.headline}
                style={{
                  background: "#141110",
                  border: "1px solid #2a2421",
                  borderRadius: "12px",
                  padding: "28px 28px",
                }}
              >
                <div style={{ fontSize: "32px", marginBottom: "12px" }}>{item.icon}</div>
                <div style={{ fontSize: "17px", fontWeight: "700", color: "#ffffff", marginBottom: "8px" }}>
                  {item.headline}
                </div>
                <div style={{ fontSize: "14px", color: "#9a9290", lineHeight: "1.6" }}>
                  {item.body}
                </div>
              </div>
            ))}
          </div>

          {/* Quote / social proof */}
          <div
            style={{
              marginTop: "28px",
              background: "#0f1a0e",
              border: "1px solid #1a3318",
              borderLeft: "4px solid #22c55e",
              borderRadius: "8px",
              padding: "20px 24px",
              display: "flex",
              alignItems: "flex-start",
              gap: "14px",
            }}
          >
            <div style={{ fontSize: "22px", marginTop: "2px" }}>💬</div>
            <div>
              <div style={{ fontSize: "14px", color: "#d1ccc9", fontStyle: "italic", lineHeight: "1.6" }}>
                "I set up the roster in 5 minutes before tip-off. By halftime I had every player's stat line ready to share with parents."
              </div>
              <div style={{ fontSize: "12px", color: "#22c55e", fontWeight: "600", marginTop: "8px" }}>
                — Youth Basketball Coach
              </div>
            </div>
          </div>
        </div>

        {/* Bottom CTA strip */}
        <div
          style={{
            padding: "32px 56px",
            borderTop: "1px solid #1e1a18",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "32px",
          }}
        >
          {/* Left: pricing + CTA */}
          <div>
            <div style={{ fontSize: "13px", color: "#6b6562", fontWeight: "600", textTransform: "uppercase", letterSpacing: "1.5px", marginBottom: "10px" }}>
              Start today
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "6px" }}>
              <span style={{ fontSize: "36px", fontWeight: "800", color: "#f97316" }}>$9.99</span>
              <span style={{ fontSize: "16px", color: "#9a9290" }}>/month</span>
              <span style={{ fontSize: "14px", color: "#4a4442", margin: "0 4px" }}>or</span>
              <span style={{ fontSize: "20px", fontWeight: "700", color: "#d1ccc9" }}>$79</span>
              <span style={{ fontSize: "14px", color: "#9a9290" }}>/year</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#22c55e" }} />
              <span style={{ fontSize: "14px", color: "#22c55e", fontWeight: "600" }}>14-day free trial · No credit card needed</span>
            </div>
          </div>

          {/* Right: QR + URL */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                background: "#ffffff",
                padding: "10px",
                borderRadius: "10px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <img
                src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=https://stecstats.com&bgcolor=ffffff&color=0a0807&margin=0"
                alt="QR code to stecstats.com"
                width={120}
                height={120}
                style={{ display: "block" }}
              />
            </div>
            <div style={{ fontSize: "15px", fontWeight: "700", color: "#f97316", letterSpacing: "0.5px" }}>
              stecstats.com
            </div>
          </div>
        </div>

        {/* Bottom orange stripe */}
        <div style={{ height: "6px", background: "linear-gradient(90deg, #f97316, #ea580c)" }} />
      </div>
    </div>
  );
}
