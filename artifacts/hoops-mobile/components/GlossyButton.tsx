import React from 'react';
import {
  StyleSheet,
  TouchableOpacity,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';

type GlossyButtonProps = {
  children: React.ReactNode;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
  accessibilityLabel?: string;
  activeOpacity?: number;
  selected?: boolean;
};

export function GlossyButton({
  children,
  onPress,
  style,
  disabled = false,
  accessibilityLabel,
  activeOpacity = 0.78,
  selected = false,
}: GlossyButtonProps) {
  const c = useColors();

  return (
    <TouchableOpacity
      accessibilityLabel={accessibilityLabel}
      activeOpacity={activeOpacity}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.shell,
        { borderColor: selected ? c.primary : c.border, opacity: disabled ? 0.55 : 1 },
        style,
      ]}
    >
      <LinearGradient
        colors={selected
          ? [c.primary, c.card, c.background]
          : [c.primary, c.background, c.card]}
        locations={selected ? [0, 0.62, 1] : [0, 0.24, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.fill}
      >
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(255,255,255,0.24)', 'rgba(255,255,255,0.04)', 'rgba(255,255,255,0)']}
          locations={[0, 0.38, 0.72]}
          start={{ x: 0.15, y: 0 }}
          end={{ x: 0.72, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />
        {children}
      </LinearGradient>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  shell: {
    borderWidth: 1,
    overflow: 'hidden',
  },
  fill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});