import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * Wraps any video player with pinch-to-zoom (1×–4×) and double-tap-to-reset.
 * Clipping is applied by the outer Animated.View so zoomed content never
 * bleeds into surrounding UI.
 */
export function ZoomableVideo({ children, style }: Props) {
  // baseScale = committed scale after each pinch gesture ends.
  // pinchScale = live multiplier during an active pinch (reset to 1 each time).
  const baseScale = useSharedValue(1);
  const pinchScale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => {
    const scale = Math.min(4, Math.max(1, baseScale.value * pinchScale.value));
    return { transform: [{ scale }] };
  });

  const pinch = Gesture.Pinch()
    .onStart(() => {
      pinchScale.value = 1;
    })
    .onUpdate((e) => {
      pinchScale.value = e.scale;
    })
    .onEnd(() => {
      baseScale.value = Math.min(4, Math.max(1, baseScale.value * pinchScale.value));
      pinchScale.value = 1;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      baseScale.value = withSpring(1, { damping: 15, stiffness: 200 });
      // pinchScale should already be 1; set explicitly for safety
      pinchScale.value = 1;
    });

  // Simultaneous so an in-progress pinch doesn't block recognising a double-tap.
  const composed = Gesture.Simultaneous(pinch, doubleTap);

  return (
    <GestureDetector gesture={composed}>
      {/* overflow:hidden clips the scaled content to the container boundary */}
      <Animated.View style={[{ overflow: 'hidden' }, style]}>
        <Animated.View style={[{ flex: 1 }, animatedStyle]}>
          {children}
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}
