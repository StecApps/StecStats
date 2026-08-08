/**
 * Shared screen background decorations — the basketball watermark and orange
 * glow used on the Dashboard. Import and drop these into any tab root View
 * to keep the visual language consistent across the app.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Path } from 'react-native-svg';

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Orange radial glow bleeding down from the top of the screen. */
export function ScreenGlow({ primary }: { primary: string }) {
  const r = (a: number) => hexToRgba(primary, a);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
      {/* Central radial cone */}
      <LinearGradient
        colors={[r(0.34), r(0.15), r(0.05), r(0)] as any}
        locations={[0, 0.22, 0.45, 0.70]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />
      {/* Slight left lean */}
      <LinearGradient
        colors={[r(0.12), r(0)] as any}
        locations={[0, 0.5]}
        start={{ x: 0.75, y: 0 }}
        end={{ x: 0.25, y: 0.5 }}
        style={StyleSheet.absoluteFillObject}
      />
    </View>
  );
}

/** Basketball seam drawing clipped into the top-right corner of the screen. */
export function BasketballWatermark({ color }: { color: string }) {
  const S = 320, CX = S / 2, CY = S / 2, R = 145, SW = 8;
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: -55, right: -90, width: S, height: S, opacity: 0.10 }}
    >
      <Svg width={S} height={S}>
        <Circle cx={CX} cy={CY} r={R} stroke={color} strokeWidth={SW} fill="none" />
        <Path
          d={`M${CX},${CY - R} C${CX - 58},${CY - R * 0.38} ${CX + 58},${CY + R * 0.38} ${CX},${CY + R}`}
          stroke={color} strokeWidth={SW} fill="none" strokeLinecap="round"
        />
        <Path
          d={`M${CX - R},${CY} Q${CX},${CY - R * 0.65} ${CX + R},${CY}`}
          stroke={color} strokeWidth={SW} fill="none" strokeLinecap="round"
        />
        <Path
          d={`M${CX - R},${CY} Q${CX},${CY + R * 0.65} ${CX + R},${CY}`}
          stroke={color} strokeWidth={SW} fill="none" strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}
