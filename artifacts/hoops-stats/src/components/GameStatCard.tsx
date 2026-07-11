import { forwardRef } from "react";

interface StatLine {
  playerName: string;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  ftMade: number;
  ftAttempted: number;
  twoMade: number;
  twoAttempted: number;
  threeMade: number;
  threeAttempted: number;
}

interface GameStatCardProps {
  playerName: string;
  teamName: string;
  opponent: string;
  date: string;
  result: string;
  teamScore: number;
  opponentScore: number;
  stat: StatLine;
}

const pct = (made: number, attempted: number) =>
  attempted > 0 ? `${Math.round((made / attempted) * 100)}%` : "—";

const ORANGE = "#ea580c";
const BG = "#0d0d0d";
const SURFACE = "#181818";
const BORDER = "#2a2a2a";
const TEXT_DIM = "#6b6b6b";
const TEXT_MID = "#a3a3a3";
const TEXT_MAIN = "#f5f5f5";
const GREEN = "#22c55e";
const RED = "#ef4444";

export const GameStatCard = forwardRef<HTMLDivElement, GameStatCardProps>(
  ({ playerName, teamName, opponent, date, result, teamScore, opponentScore, stat }, ref) => {
    const fgMade = stat.twoMade + stat.threeMade;
    const fgAttempted = stat.twoAttempted + stat.threeAttempted;
    const isWin = result === "W";
    const dateStr = new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    const secondaryStats = [
      { value: stat.rebounds, label: "REB" },
      { value: stat.assists, label: "AST" },
      { value: stat.steals, label: "STL" },
      { value: stat.blocks, label: "BLK" },
      { value: stat.turnovers, label: "TO" },
    ];

    const shootingStats = [
      { label: "FT", value: `${stat.ftMade}/${stat.ftAttempted}`, pct: pct(stat.ftMade, stat.ftAttempted) },
      { label: "2PT", value: `${stat.twoMade}/${stat.twoAttempted}`, pct: null },
      { label: "3PT", value: `${stat.threeMade}/${stat.threeAttempted}`, pct: pct(stat.threeMade, stat.threeAttempted) },
      { label: "FG%", value: pct(fgMade, fgAttempted), pct: null },
    ];

    return (
      <div
        ref={ref}
        style={{
          width: 600,
          height: 360,
          background: BG,
          fontFamily: "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderRadius: 16,
          border: `1px solid ${BORDER}`,
        }}
      >
        {/* Header */}
        <div
          style={{
            background: SURFACE,
            borderBottom: `1px solid ${BORDER}`,
            padding: "12px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                width: 28,
                height: 28,
                background: ORANGE,
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 800,
                fontSize: 14,
                color: "#fff",
                letterSpacing: -0.5,
              }}
            >
              S
            </div>
            <span
              style={{
                color: TEXT_MAIN,
                fontWeight: 700,
                fontSize: 13,
                letterSpacing: 1.5,
                textTransform: "uppercase",
              }}
            >
              STEC STATS
            </span>
          </div>
          <span
            style={{
              color: TEXT_DIM,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: 1.2,
              textTransform: "uppercase",
            }}
          >
            Game Summary
          </span>
        </div>

        {/* Player + Game info */}
        <div
          style={{
            padding: "16px 20px 12px",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            borderBottom: `1px solid ${BORDER}`,
          }}
        >
          <div>
            <div
              style={{
                color: TEXT_MAIN,
                fontSize: 22,
                fontWeight: 800,
                letterSpacing: -0.5,
                lineHeight: 1.1,
              }}
            >
              {playerName}
            </div>
            <div
              style={{
                color: TEXT_MID,
                fontSize: 12,
                marginTop: 4,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span>{teamName}</span>
              <span style={{ color: BORDER }}>·</span>
              <span>vs {opponent}</span>
              <span style={{ color: BORDER }}>·</span>
              <span>{dateStr}</span>
            </div>
          </div>
          {/* Result badge */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 2,
            }}
          >
            <div
              style={{
                background: isWin ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)",
                border: `1px solid ${isWin ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                color: isWin ? GREEN : RED,
                fontWeight: 800,
                fontSize: 15,
                borderRadius: 8,
                padding: "4px 12px",
                letterSpacing: 0.5,
              }}
            >
              {isWin ? "WIN" : "LOSS"}
            </div>
            <div style={{ color: TEXT_DIM, fontSize: 12, fontWeight: 600 }}>
              {teamScore}–{opponentScore}
            </div>
          </div>
        </div>

        {/* Stats body */}
        <div
          style={{
            flex: 1,
            display: "flex",
            padding: "14px 20px 0",
            gap: 0,
          }}
        >
          {/* Points hero */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              paddingRight: 24,
              marginRight: 24,
              borderRight: `1px solid ${BORDER}`,
              minWidth: 100,
            }}
          >
            <div
              style={{
                color: ORANGE,
                fontSize: 64,
                fontWeight: 900,
                lineHeight: 1,
                letterSpacing: -3,
              }}
            >
              {stat.points}
            </div>
            <div
              style={{
                color: TEXT_DIM,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 2,
                textTransform: "uppercase",
                marginTop: 4,
              }}
            >
              POINTS
            </div>
          </div>

          {/* Secondary stats */}
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 0,
                marginBottom: 16,
              }}
            >
              {secondaryStats.map(({ value, label }) => (
                <div
                  key={label}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{
                      color: TEXT_MAIN,
                      fontSize: 28,
                      fontWeight: 800,
                      lineHeight: 1,
                      letterSpacing: -1,
                    }}
                  >
                    {value}
                  </div>
                  <div
                    style={{
                      color: TEXT_DIM,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 1.5,
                      textTransform: "uppercase",
                      marginTop: 3,
                    }}
                  >
                    {label}
                  </div>
                </div>
              ))}
            </div>

            {/* Shooting line */}
            <div
              style={{
                display: "flex",
                gap: 0,
                background: SURFACE,
                borderRadius: 8,
                padding: "8px 4px",
              }}
            >
              {shootingStats.map(({ label, value, pct: pctVal }, i) => (
                <div
                  key={label}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    borderRight: i < shootingStats.length - 1 ? `1px solid ${BORDER}` : "none",
                  }}
                >
                  <div style={{ color: TEXT_DIM, fontSize: 9, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase" }}>
                    {label}
                  </div>
                  <div style={{ color: TEXT_MAIN, fontSize: 13, fontWeight: 700, marginTop: 2 }}>
                    {value}
                  </div>
                  {pctVal && (
                    <div style={{ color: TEXT_MID, fontSize: 10, marginTop: 1 }}>{pctVal}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "10px 20px",
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
          }}
        >
          <span style={{ color: TEXT_DIM, fontSize: 10, letterSpacing: 1, textTransform: "uppercase" }}>
            stecstats.replit.app
          </span>
        </div>
      </div>
    );
  }
);

GameStatCard.displayName = "GameStatCard";
