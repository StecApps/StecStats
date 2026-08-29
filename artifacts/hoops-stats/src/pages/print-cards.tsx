import { useEffect, useRef } from "react";

const LOGO = "/logo.png";
const ICON = "/icon-512.png";
const QR_SM = "https://api.qrserver.com/v1/create-qr-code/?size=60x60&data=https://stecstats.com&bgcolor=ffffff&color=0a0807&margin=0";

const CARD_W = 336;
const CARD_H = 192;
const COLS = 2;
const ROWS = 4;
const GUTTER = 24;
const PAGE_W = 816;
const PAGE_CONTENT_H = 1023;
const H_PAD = Math.round((PAGE_W - COLS * CARD_W - (COLS - 1) * GUTTER) / 2);
const V_PAD = Math.round((PAGE_CONTENT_H - ROWS * CARD_H - (ROWS - 1) * GUTTER) / 2);

const cardBase: React.CSSProperties = {
  position: "absolute",
  width: CARD_W,
  height: CARD_H,
  background: "#0a0807",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  fontFamily: "'Helvetica Neue',Arial,sans-serif",
  WebkitPrintColorAdjust: "exact",
  printColorAdjust: "exact",
} as React.CSSProperties;

const bar: React.CSSProperties = {
  height: 4,
  background: "linear-gradient(90deg,#f97316,#ea580c)",
  flexShrink: 0,
  WebkitPrintColorAdjust: "exact",
  printColorAdjust: "exact",
} as React.CSSProperties;

const watermark: React.CSSProperties = {
  position: "absolute",
  objectFit: "contain",
  pointerEvents: "none",
};

function CropMarks({ x, y }: { x: number; y: number }) {
  const thin = { background: "#999", position: "absolute" } as React.CSSProperties;
  return (
    <>
      <div style={{ ...thin, left: x, top: y - 8, width: 0.5, height: 6 }} />
      <div style={{ ...thin, left: x - 8, top: y, width: 6, height: 0.5 }} />
      <div style={{ ...thin, left: x + CARD_W, top: y - 8, width: 0.5, height: 6 }} />
      <div style={{ ...thin, left: x + CARD_W + 2, top: y, width: 6, height: 0.5 }} />
      <div style={{ ...thin, left: x, top: y + CARD_H + 2, width: 0.5, height: 6 }} />
      <div style={{ ...thin, left: x - 8, top: y + CARD_H, width: 6, height: 0.5 }} />
      <div style={{ ...thin, left: x + CARD_W, top: y + CARD_H + 2, width: 0.5, height: 6 }} />
      <div style={{ ...thin, left: x + CARD_W + 2, top: y + CARD_H, width: 6, height: 0.5 }} />
    </>
  );
}

function CardFront({ x, y }: { x: number; y: number }) {
  return (
    <>
      <CropMarks x={x} y={y} />
      <div style={{ ...cardBase, left: x, top: y }}>
        <div style={bar} />
        <img src={ICON} alt="" style={{ ...watermark, right: -30, top: "50%", transform: "translateY(-50%)", width: 180, height: 180, opacity: 0.18 }} />
        <div style={{ padding: "12px 16px 0", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", position: "relative" }}>
          {/* Logo — bumped from 22 → 28px */}
          <img src={LOGO} alt="StecStats" style={{ height: 28, objectFit: "contain", objectPosition: "left", marginBottom: 8 }} />
          <div style={{ display: "flex", gap: 5, marginBottom: 7 }}>
            {["For Coaches", "For Parents"].map(l => (
              <div key={l} style={{ fontSize: 6.5, fontWeight: 700, color: "#f97316", border: "1.5px solid #f97316", borderRadius: 10, padding: "2px 6px", textTransform: "uppercase", letterSpacing: 0.3 }}>{l}</div>
            ))}
          </div>
          {/* Description — boosted from #9a9290 → #b8b4b2, tagline from #d1ccc9 → #ffffff */}
          <div style={{ fontSize: 8.5, color: "#b8b4b2", lineHeight: 1.55 }}>
            Stats · Video · Live Streaming · Highlight Reels<br />
            <span style={{ color: "#ffffff", fontWeight: 600 }}>One app. Every game. The whole team.</span>
          </div>
        </div>
        <div style={{ padding: "0 16px 10px", display: "flex", justifyContent: "space-between", alignItems: "flex-end", position: "relative" }}>
          <div>
            {/* Label — boosted from #4a4442 → #8a8685 */}
            <div style={{ fontSize: 6.5, color: "#8a8685", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 2 }}>Free 14-day trial</div>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#f97316" }}>stecstats.com</div>
          </div>
          <div style={{ textAlign: "right" }}>
            {/* "From" label — boosted from #6b6562 → #9a9694 */}
            <div style={{ fontSize: 6.5, color: "#9a9694" }}>From</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#ffffff" }}>$9.99<span style={{ fontSize: 8, fontWeight: 400, color: "#9a9694" }}>/mo</span></div>
          </div>
        </div>
        <div style={bar} />
      </div>
    </>
  );
}

function CardBack({ x, y }: { x: number; y: number }) {
  return (
    <>
      <CropMarks x={x} y={y} />
      <div style={{ ...cardBase, left: x, top: y }}>
        <div style={bar} />
        <img src={ICON} alt="" style={{ ...watermark, left: "50%", top: "50%", transform: "translate(-50%,-50%)", width: 180, height: 180, opacity: 0.15 }} />
        <div style={{ flex: 1, display: "flex", alignItems: "center", padding: "0 16px", position: "relative" }}>
          <div style={{ flex: 1, paddingRight: 12 }}>
            {/* Logo — bumped from 16 → 20px */}
            <img src={LOGO} alt="StecStats" style={{ height: 20, objectFit: "contain", objectPosition: "left", marginBottom: 7 }} />
            {[
              { icon: "📊", text: "Live stat tracking — every player" },
              { icon: "📹", text: "Auto game video upload" },
              { icon: "📡", text: "Live stream so parents never miss a game" },
              { icon: "🏆", text: "Highlight reels in minutes" },
            ].map(item => (
              <div key={item.text} style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5 }}>
                <span style={{ fontSize: 9 }}>{item.icon}</span>
                {/* Bullet text — boosted from #d1ccc9 → #ffffff */}
                <span style={{ fontSize: 7.5, color: "#ffffff" }}>{item.text}</span>
              </div>
            ))}
          </div>
          {/* Divider — slightly lighter so it's visible */}
          <div style={{ width: 1, height: 120, background: "#2e2a28", flexShrink: 0 }} />
          <div style={{ paddingLeft: 12, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div style={{ background: "#fff", padding: 4, borderRadius: 4 }}>
              <img src={QR_SM} width={60} height={60} alt="QR" style={{ display: "block" }} />
            </div>
            <div style={{ fontSize: 8, fontWeight: 700, color: "#f97316" }}>stecstats.com</div>
            {/* Contact — boosted from #d1ccc9 → #ffffff, email from #9a9290 → #c8c4c2 */}
            <div style={{ fontSize: 7.5, color: "#ffffff", textAlign: "center", fontWeight: 600 }}>401-365-0933</div>
            <div style={{ fontSize: 6.5, color: "#c8c4c2", textAlign: "center" }}>support@stecstats.com</div>
            <div style={{ fontSize: 6, color: "#9a9694", textAlign: "center" }}>14-day free · $9.99/mo</div>
          </div>
        </div>
        <div style={bar} />
      </div>
    </>
  );
}

function PrintPage({ label, note, children }: { label: string; note: string; children: React.ReactNode }) {
  return (
    <div style={{ width: PAGE_W, background: "white", marginBottom: 32, position: "relative" }} className="print-page">
      <div className="no-print" style={{ background: "#f5f5f5", borderBottom: "1px solid #ddd", padding: "8px 14px", display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: "monospace", color: "#444" }}>
        <strong>StecStats · {label}</strong>
        <span style={{ color: "#888", fontWeight: 400 }}>{note}</span>
      </div>
      <div style={{ height: PAGE_CONTENT_H, position: "relative" }}>
        {children}
      </div>
    </div>
  );
}

function CardGrid({ front }: { front: boolean }) {
  const cards = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const x = H_PAD + col * (CARD_W + GUTTER);
      const y = V_PAD + row * (CARD_H + GUTTER);
      cards.push(front
        ? <CardFront key={`${row}-${col}`} x={x} y={y} />
        : <CardBack key={`${row}-${col}`} x={x} y={y} />
      );
    }
  }
  return <>{cards}</>;
}

export default function PrintCards() {
  useEffect(() => {
    document.title = "StecStats – Print Business Cards";
  }, []);

  return (
    <>
      <style>{`
        @media print {
          @page { size: letter portrait; margin: 0; }
          .no-print { display: none !important; }
          .instructions { display: none !important; }
          body { background: white !important; padding: 0 !important; }
          .print-page { margin: 0 !important; page-break-after: always; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
      `}</style>
      <div style={{ background: "#e0e0e0", minHeight: "100vh", padding: 24, display: "flex", flexDirection: "column", alignItems: "center", fontFamily: "sans-serif" }}>

        {/* Save as PDF button */}
        <div className="instructions" style={{ width: PAGE_W, marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={() => window.print()}
            style={{ background: "#f97316", color: "#fff", border: "none", borderRadius: 8, padding: "12px 28px", fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 2px 8px rgba(249,115,22,0.4)" }}
          >
            <span style={{ fontSize: 18 }}>⬇</span> Save as PDF / Print
          </button>
          <span style={{ fontSize: 13, color: "#555" }}>
            In the dialog that opens → set <strong>Destination</strong> to <strong>"Save as PDF"</strong> to get a file for your print shop.
          </span>
        </div>

        {/* Instructions */}
        <div className="instructions" style={{ width: PAGE_W, marginBottom: 20, display: "flex", gap: 16 }}>

          {/* Print shop */}
          <div style={{ flex: 1, background: "#f0f7ff", border: "1px solid #bdd7f5", borderRadius: 6, padding: "14px 16px", fontSize: 13, color: "#444", lineHeight: 1.7 }}>
            <strong style={{ color: "#1e4080", display: "block", marginBottom: 4 }}>🏪 Saving a PDF for a print shop</strong>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              <li>Click <strong>"Save as PDF / Print"</strong> above</li>
              <li>Change <strong>Destination</strong> → <strong>Save as PDF</strong></li>
              <li>Margins = <strong>None</strong> · Scale = <strong>100%</strong></li>
              <li>Open <strong>More settings</strong> → enable <strong>"Background graphics"</strong></li>
              <li>Click <strong>Save</strong> — you get a 2-page PDF</li>
              <li>Hand <strong>both pages</strong> to the shop and ask for <strong>double-sided, cut to 3.5" × 2"</strong></li>
            </ol>
            <div style={{ marginTop: 8, fontSize: 11, color: "#6b8ab0" }}>Crop marks are included on every card so the shop knows exactly where to cut.</div>
          </div>

          {/* Home printer */}
          <div style={{ flex: 1, background: "#fffbe6", border: "1px solid #f0c040", borderRadius: 6, padding: "14px 16px", fontSize: 13, color: "#555", lineHeight: 1.7 }}>
            <strong style={{ color: "#7a5c00", display: "block", marginBottom: 4 }}>🖨 Printing at home (front & back)</strong>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              <li>Click <strong>"Save as PDF / Print"</strong> above</li>
              <li>Margins = <strong>None</strong> · Scale = <strong>100%</strong></li>
              <li><strong>More settings</strong> → enable <strong>"Background graphics"</strong></li>
              <li>Print <strong>Page 1 only</strong> (fronts)</li>
              <li>Flip the sheet <strong>short-edge</strong> (top stays top), put back in tray</li>
              <li>Print <strong>Page 2 only</strong> (backs)</li>
              <li>Cut along the crop marks → <strong>8 double-sided cards</strong></li>
            </ol>
            <div style={{ marginTop: 8, fontSize: 11, color: "#a07a00" }}>Tip: if backs print upside-down, flip the paper the other way in step 5.</div>
          </div>

        </div>

        <PrintPage label="Page 1 — FRONTS" note="Print this page first">
          <CardGrid front={true} />
        </PrintPage>

        <PrintPage label="Page 2 — BACKS" note="Flip sheet short-edge, place back in tray, then print">
          <CardGrid front={false} />
        </PrintPage>

      </div>
    </>
  );
}
