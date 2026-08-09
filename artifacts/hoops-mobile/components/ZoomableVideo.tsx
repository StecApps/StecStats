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
  /** Container dimensions used to clamp pan offset. Defaults to a safe fallback. */
  width?: number;
  height?: number;
};

/**
 * Wraps any video player with pinch-to-zoom (1×–4×), single-finger pan (while
 * zoomed), and double-tap-to-reset.
 *
 * Pan is clamped so the video edges never scroll beyond the container boundary:
 *   maxOffset = (scale - 1) * dimension / 2
 *
 * Clipping is applied by the outer Animated.View so zoomed/panned content
 * never bleeds into surrounding UI.
 */
export function ZoomableVideo({ children, style, width = 400, height = 225 }: Props) {
  // --- scale ---
  // baseScale = committed scale after each pinch ends.
  // pinchScale = live multiplier during an active pinch (reset to 1 each time).
  const baseScale = useSharedValue(1);
  const pinchScale = useSharedValue(1);

  // --- pan ---
  // translateX/Y = committed offset after each pan ends.
  // panX/Y       = live delta during an active pan gesture.
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const panX = useSharedValue(0);
  const panY = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => {
    const scale = Math.min(4, Math.max(1, baseScale.value * pinchScale.value));
    // Max pan distance so edges don't scroll past the container.
    const maxX = ((scale - 1) * width)  / 2;
    const maxY = ((scale - 1) * height) / 2;
    const tx = Math.min(maxX, Math.max(-maxX, translateX.value + panX.value));
    const ty = Math.min(maxY, Math.max(-maxY, translateY.value + panY.value));
    return {
      transform: [
        { translateX: tx },
        { translateY: ty },
        { scale },
      ],
    };
  });

  // --- gestures ---
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
      // After scale changes, re-clamp the committed offset in case the new
      // scale makes the current offset out-of-bounds.
      const newScale = baseScale.value;
      const maxX = ((newScale - 1) * width)  / 2;
      const maxY = ((newScale - 1) * height) / 2;
      translateX.value = Math.min(maxX, Math.max(-maxX, translateX.value));
      translateY.value = Math.min(maxY, Math.max(-maxY, translateY.value));
    });

  const pan = Gesture.Pan()
    .onStart(() => {
      panX.value = 0;
      panY.value = 0;
    })
    .onUpdate((e) => {
      panX.value = e.translationX;
      panY.value = e.translationY;
    })
    .onEnd((e) => {
      const scale = Math.min(4, Math.max(1, baseScale.value));
      const maxX = ((scale - 1) * width)  / 2;
      const maxY = ((scale - 1) * height) / 2;
      translateX.value = Math.min(maxX, Math.max(-maxX, translateX.value + e.translationX));
      translateY.value = Math.min(maxY, Math.max(-maxY, translateY.value + e.translationY));
      panX.value = 0;
      panY.value = 0;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      baseScale.value = withSpring(1, { damping: 15, stiffness: 200 });
      pinchScale.value = 1;
      translateX.value = withSpring(0, { damping: 15, stiffness: 200 });
      translateY.value = withSpring(0, { damping: 15, stiffness: 200 });
      panX.value = 0;
      panY.value = 0;
    });

  // Run all three simultaneously so an in-progress pan doesn't block pinch/tap.
  const composed = Gesture.Simultaneous(pinch, pan, doubleTap);

  return (
    <GestureDetector gesture={composed}>
      {/* overflow:hidden clips the scaled/panned content to the container boundary */}
      <Animated.View style={[{ overflow: 'hidden' }, style]}>
        <Animated.View style={[{ flex: 1 }, animatedStyle]}>
          {children}
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}
