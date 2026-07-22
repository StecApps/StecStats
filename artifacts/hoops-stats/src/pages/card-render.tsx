import { useEffect } from "react";

const LOGO = "/logo.png";
const ICON = "/icon-512.png";
const QR_SM = "https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=https://stecstats.com&bgcolor=ffffff&color=0a0807&margin=0";

const W = 1050;
const H = 600;

const bar: React.CSSProperties = {
  height: 12,
  background: "linear-gradient(90deg,#f97316,#ea580c)",
  flexShrink: 0,
  WebkitPrintColorAdjust: "exact",
  printColorAdjust: "exact",
} as React.CSSProperties;

const cardBase: React.CSSProperties = {
  width: W,
  height: H,
  background: "#0a0807",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  fontFamily: "'Helvetica Neue',Arial,sans-serif",
};

function CardFront() {
  return (
    <div style={cardBase}>
      <div style={bar} />
      <img src={ICON} alt="" style={{ position: "absolute", right: -80, top: "50%", transform: "translateY(-50%)", width: 520, height: 520, opacity: 0.18, objectFit: "contain", pointerEvents: "none" }} />
      <div style={{ padding: "36px 50px 0", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", position: "relative" }}>
        <img src={LOGO} alt="StecStats" style={{ height: 80, objectFit: "contain", objectPosition: "left", marginBottom: 22 }} />
        <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
          {["For Coaches", "For Parents"].map(l => (
            <div key={l} style={{ fontSize: 18, fontWeight: 700, color: "#f97316", border: "2px solid #f97316", borderRadius: 30, padding: "5px 18px", textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
          ))}
        </div>
        <div style={{ fontSize: 24, color: "#b8b4b2", lineHeight: 1.55 }}>
          Stats · Video · Live Streaming · Highlight Reels<br />
          <span style={{ color: "#ffffff", fontWeight: 600 }}>One app. Every game. The whole team.</span>
        </div>
      </div>
      <div style={{ padding: "0 50px 30px", display: "flex", justifyContent: "space-between", alignItems: "flex-end", position: "relative" }}>
        <div>
          <div style={{ fontSize: 18, color: "#8a8685", textTransform: "uppercase", letterSpacing: 2, marginBottom: 4 }}>Free 14-day trial</div>
          <div style={{ fontSize: 34, fontWeight: 800, color: "#f97316" }}>stecstats.com</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 18, color: "#9a9694" }}>From</div>
          <div style={{ fontSize: 40, fontWeight: 800, color: "#ffffff" }}>$9.99<span style={{ fontSize: 22, fontWeight: 400, color: "#9a9694" }}>/mo</span></div>
        </div>
      </div>
      <div style={bar} />
    </div>
  );
}

function CardBack() {
  return (
    <div style={cardBase}>
      <div style={bar} />
      <img src={ICON} alt="" style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)", width: 520, height: 520, opacity: 0.15, objectFit: "contain", pointerEvents: "none" }} />
      <div style={{ flex: 1, display: "flex", alignItems: "center", padding: "0 50px", position: "relative" }}>
        <div style={{ flex: 1, paddingRight: 40 }}>
          <img src={LOGO} alt="StecStats" style={{ height: 58, objectFit: "contain", objectPosition: "left", marginBottom: 22 }} />
          {[
            { icon: "📊", text: "Live stat tracking — every player" },
            { icon: "📹", text: "Auto game video upload" },
            { icon: "📡", text: "Live stream so parents never miss a game" },
            { icon: "🏆", text: "Highlight reels in minutes" },
          ].map(item => (
            <div key={item.text} style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
              <span style={{ fontSize: 26 }}>{item.icon}</span>
              <span style={{ fontSize: 22, color: "#ffffff" }}>{item.text}</span>
            </div>
          ))}
        </div>
        <div style={{ width: 2, height: 380, background: "#2e2a28", flexShrink: 0 }} />
        <div style={{ paddingLeft: 40, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <div style={{ background: "#fff", padding: 12, borderRadius: 10 }}>
            <img src={QR_SM} width={180} height={180} alt="QR" style={{ display: "block" }} />
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#f97316" }}>stecstats.com</div>
          <div style={{ fontSize: 22, color: "#ffffff", textAlign: "center", fontWeight: 600 }}>401-365-0933</div>
          <div style={{ fontSize: 18, color: "#c8c4c2", textAlign: "center" }}>Sstec@stecstats.com</div>
          <div style={{ fontSize: 16, color: "#9a9694", textAlign: "center" }}>14-day free · $9.99/mo</div>
        </div>
      </div>
      <div style={bar} />
    </div>
  );
}

export default function CardRender() {
  const side = new URLSearchParams(window.location.search).get("side") ?? "front";

  useEffect(() => {
    document.title = `StecStats Card – ${side}`;
    document.documentElement.style.background = "#0a0807";
    document.body.style.margin = "0";
    document.body.style.padding = "0";
    document.body.style.background = "#0a0807";
    const style = document.createElement("style");
    style.id = "card-render-overrides";
    style.textContent = `
      [data-testid="feedback-button"],
      button[aria-label="Report an issue"],
      .feedback-button,
      #feedback-button { display: none !important; }
    `;
    document.head.appendChild(style);
    return () => document.getElementById("card-render-overrides")?.remove();
  }, [side]);

  return side === "back" ? <CardBack /> : <CardFront />;
}
