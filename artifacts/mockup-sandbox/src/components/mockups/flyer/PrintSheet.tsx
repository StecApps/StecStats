const CARD_W = 336;
const CARD_H = 192;
const COLS = 2;
const ROWS = 4;
const GUTTER = 24;
const PAGE_W = 816;
const PAGE_H = 1056;
const H_PAD = (PAGE_W - COLS * CARD_W - (COLS - 1) * GUTTER) / 2;
const V_PAD = (PAGE_H - ROWS * CARD_H - (ROWS - 1) * GUTTER) / 2;

function CardFront() {
  return (
    <div style={{
      width: CARD_W, height: CARD_H,
      background: "#0a0807",
      borderRadius: "4px",
      position: "relative",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      fontFamily: "'Inter', 'Helvetica Neue', Arial, sans-serif",
    }}>
      <div style={{ height: "3px", background: "linear-gradient(90deg,#f97316,#ea580c)", flexShrink: 0 }} />
      <img src="/__mockup/icon-512.png" alt="" style={{
        position: "absolute", right: "-30px", top: "50%", transform: "translateY(-50%)",
        width: "180px", height: "180px", objectFit: "contain", opacity: 0.18, pointerEvents: "none",
      }} />
      <div style={{ padding: "14px 18px 0", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", position: "relative" }}>
        <div style={{ marginBottom: "8px" }}>
          <img src="/__mockup/logo.png" alt="StecStats" style={{ height: "24px", objectFit: "contain" }} />
        </div>
        <div style={{ display: "flex", gap: "5px", marginBottom: "6px" }}>
          {["For Coaches", "For Parents"].map(l => (
            <div key={l} style={{ fontSize: "6px", fontWeight: "700", color: "#f97316", border: "1px solid #f97316", borderRadius: "10px", padding: "2px 6px", textTransform: "uppercase", letterSpacing: "0.3px" }}>{l}</div>
          ))}
        </div>
        <div style={{ fontSize: "8px", color: "#9a9290", lineHeight: 1.5 }}>
          Stats · Video · Live Streaming · Highlight Reels
          <br /><span style={{ color: "#d1ccc9" }}>One app. Every game. The whole team.</span>
        </div>
      </div>
      <div style={{ padding: "0 18px 12px", display: "flex", justifyContent: "space-between", alignItems: "flex-end", position: "relative" }}>
        <div>
          <div style={{ fontSize: "6px", color: "#4a4442", textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: "2px" }}>Free 14-day trial</div>
          <div style={{ fontSize: "11px", fontWeight: "800", color: "#f97316" }}>stecstats.com</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "6px", color: "#6b6562" }}>From</div>
          <div style={{ fontSize: "12px", fontWeight: "800", color: "#fff" }}>$9.99<span style={{ fontSize: "7px", fontWeight: 400, color: "#6b6562" }}>/mo</span></div>
        </div>
      </div>
      <div style={{ height: "3px", background: "linear-gradient(90deg,#f97316,#ea580c)", flexShrink: 0 }} />
    </div>
  );
}

function CardBack() {
  return (
    <div style={{
      width: CARD_W, height: CARD_H,
      background: "#0a0807",
      borderRadius: "4px",
      position: "relative",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      fontFamily: "'Inter', 'Helvetica Neue', Arial, sans-serif",
    }}>
      <div style={{ height: "3px", background: "linear-gradient(90deg,#f97316,#ea580c)", flexShrink: 0 }} />
      <img src="/__mockup/icon-512.png" alt="" style={{
        position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
        width: "180px", height: "180px", objectFit: "contain", opacity: 0.15, pointerEvents: "none",
      }} />
      <div style={{ flex: 1, display: "flex", alignItems: "center", padding: "0 18px", position: "relative" }}>
        <div style={{ flex: 1, paddingRight: "14px" }}>
          <div style={{ marginBottom: "6px" }}>
            <img src="/__mockup/logo.png" alt="StecStats" style={{ height: "18px", objectFit: "contain" }} />
          </div>
          {[
            { icon: "📊", text: "Live stat tracking — every player" },
            { icon: "📹", text: "Auto game video upload" },
            { icon: "📡", text: "Live stream so parents never miss a game" },
            { icon: "🏆", text: "Highlight reels in minutes" },
          ].map(item => (
            <div key={item.text} style={{ display: "flex", alignItems: "center", gap: "5px", marginBottom: "5px" }}>
              <span style={{ fontSize: "9px" }}>{item.icon}</span>
              <span style={{ fontSize: "7px", color: "#d1ccc9" }}>{item.text}</span>
            </div>
          ))}
        </div>
        <div style={{ width: "1px", height: "120px", background: "#1e1a18", flexShrink: 0 }} />
        <div style={{ paddingLeft: "14px", display: "flex", flexDirection: "column", alignItems: "center", gap: "5px" }}>
          <div style={{ background: "#fff", padding: "4px", borderRadius: "4px" }}>
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=60x60&data=https://stecstats.com&bgcolor=ffffff&color=0a0807&margin=0" alt="QR" width={60} height={60} style={{ display: "block" }} />
          </div>
          <div style={{ fontSize: "8px", fontWeight: "700", color: "#f97316" }}>stecstats.com</div>
          <div style={{ fontSize: "6px", color: "#6b6562", textAlign: "center" }}>14-day free trial<br />$9.99/mo · $79/yr</div>
        </div>
      </div>
      <div style={{ height: "3px", background: "linear-gradient(90deg,#f97316,#ea580c)", flexShrink: 0 }} />
    </div>
  );
}

function CropMark({ top, left, size = 8, gap = 4 }: { top: number; left: number; size?: number; gap?: number }) {
  return (
    <>
      <div style={{ position: "absolute", top: top - size - gap, left: top === Math.round(top) ? left : left, width: 0.5, height: size, background: "#ccc" }} />
      <div style={{ position: "absolute", top, left: left - size - gap, width: size, height: 0.5, background: "#ccc" }} />
    </>
  );
}

function Page({ label, children, instructions }: { label: string; children: React.ReactNode; instructions?: string }) {
  return (
    <div style={{ width: PAGE_W, background: "#fff", position: "relative", marginBottom: "32px" }}>
      {/* Header band */}
      <div style={{ background: "#f5f5f5", borderBottom: "1px solid #ddd", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "11px", fontWeight: "700", color: "#333", fontFamily: "monospace" }}>StecStats · {label}</span>
        {instructions && <span style={{ fontSize: "10px", color: "#666", fontFamily: "sans-serif" }}>{instructions}</span>}
      </div>
      <div style={{ height: PAGE_H, position: "relative" }}>
        {children}
      </div>
    </div>
  );
}

function CardGrid({ front }: { front: boolean }) {
  const total = COLS * ROWS;
  return (
    <>
      {Array.from({ length: total }).map((_, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const x = H_PAD + col * (CARD_W + GUTTER);
        const y = V_PAD + row * (CARD_H + GUTTER);
        return (
          <div key={i} style={{ position: "absolute", left: x, top: y }}>
            {/* Corner crop marks */}
            {/* TL */}
            <div style={{ position: "absolute", top: -8, left: 0, width: 0.5, height: 6, background: "#aaa" }} />
            <div style={{ position: "absolute", top: 0, left: -8, height: 0.5, width: 6, background: "#aaa" }} />
            {/* TR */}
            <div style={{ position: "absolute", top: -8, right: 0, width: 0.5, height: 6, background: "#aaa" }} />
            <div style={{ position: "absolute", top: 0, right: -8, height: 0.5, width: 6, background: "#aaa" }} />
            {/* BL */}
            <div style={{ position: "absolute", bottom: -8, left: 0, width: 0.5, height: 6, background: "#aaa" }} />
            <div style={{ position: "absolute", bottom: 0, left: -8, height: 0.5, width: 6, background: "#aaa" }} />
            {/* BR */}
            <div style={{ position: "absolute", bottom: -8, right: 0, width: 0.5, height: 6, background: "#aaa" }} />
            <div style={{ position: "absolute", bottom: 0, right: -8, height: 0.5, width: 6, background: "#aaa" }} />
            {front ? <CardFront /> : <CardBack />}
          </div>
        );
      })}
    </>
  );
}

export function PrintSheet() {
  return (
    <div style={{ background: "#e8e8e8", minHeight: "100vh", padding: "24px", display: "flex", flexDirection: "column", alignItems: "center", fontFamily: "sans-serif" }}>

      {/* Instructions */}
      <div style={{ width: PAGE_W, background: "#fffbe6", border: "1px solid #f0c040", borderRadius: "6px", padding: "12px 16px", marginBottom: "20px", fontSize: "12px", color: "#555", lineHeight: 1.6 }}>
        <strong style={{ color: "#333" }}>🖨 How to print front &amp; back on a home printer:</strong><br />
        1. Print <strong>Page 1 (Fronts)</strong> · 2. Put the sheet back in face-down, same orientation · 3. Print <strong>Page 2 (Backs)</strong> · 4. Cut along the crop marks.
      </div>

      <Page label="Page 1 — FRONTS (print first)" instructions="Print this page first, then flip &amp; print Page 2">
        <CardGrid front={true} />
      </Page>

      <Page label="Page 2 — BACKS (print second)" instructions="Flip sheet short-edge, place back in tray, print">
        <CardGrid front={false} />
      </Page>

    </div>
  );
}
