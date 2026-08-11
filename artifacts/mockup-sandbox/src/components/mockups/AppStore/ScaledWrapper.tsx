// Scales a 390-wide base design up to fill any viewport using CSS zoom.
// Unlike transform:scale, zoom rescales the layout viewport so h-screen / w-full
// inside the children resolve against 390×844, not the real browser dimensions.
export function ScaledWrapper({ children }: { children: React.ReactNode }) {
  const zoom = typeof window !== "undefined" ? window.innerWidth / 390 : 1;
  return (
    <div style={{ zoom, width: 390, height: 844, overflow: "hidden" }}>
      {children}
    </div>
  );
}
