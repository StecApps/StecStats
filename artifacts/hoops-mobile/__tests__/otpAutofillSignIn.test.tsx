/**
 * Regression guard for iPad email-code autofill/paste.
 *
 * React Native can deliver all six OTP digits in one TextInput change event.
 * The verification handler must use that event value, not the previous render's
 * five-digit state.
 */

jest.mock('@clerk/expo/legacy', () => ({
  useSignIn: jest.fn(),
  useSignUp: jest.fn(),
}));

jest.mock('@/hooks/useColors', () => ({
  useColors: jest.fn(() => ({
    background: '#000',
    foreground: '#fff',
    mutedForeground: '#aaa',
    input: '#111',
    border: '#333',
    primary: '#fff',
    primaryForeground: '#000',
    destructive: '#f00',
    radius: 12,
  })),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: jest.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })),
}));

jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));
jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
}));

jest.mock('react-native', () => {
  const React = require('react');
  const host = (type: string) =>
    function MockNativeElement({ children, ...props }: any) {
      return React.createElement(type, props, children ?? null);
    };
  return {
    View: host('View'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    ScrollView: host('ScrollView'),
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
    ActivityIndicator: host('ActivityIndicator'),
    StyleSheet: { create: (styles: any) => styles },
    Platform: { OS: 'ios' },
    useColorScheme: jest.fn(() => 'dark'),
  };
});

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { useSignIn, useSignUp } from '@clerk/expo/legacy';
import AuthScreen from '../app/(auth)/index';

describe('AuthScreen — email OTP autofill', () => {
  test('verifies the six-digit value delivered by one TextInput event', async () => {
    const attemptFirstFactor = jest.fn().mockResolvedValue({
      status: 'complete',
      createdSessionId: 'session_from_autofill',
    });
    const prepareFirstFactor = jest.fn().mockResolvedValue(undefined);
    const create = jest.fn().mockResolvedValue({
      status: 'needs_first_factor',
      supportedFirstFactors: [
        { strategy: 'email_code', emailAddressId: 'email_address_1' },
      ],
    });
    const setActive = jest.fn().mockResolvedValue(undefined);

    (useSignIn as jest.Mock).mockReturnValue({
      signIn: { create, prepareFirstFactor, attemptFirstFactor },
      setActive,
      isLoaded: true,
    });
    (useSignUp as jest.Mock).mockReturnValue({
      signUp: {},
      setActive: jest.fn(),
      isLoaded: true,
    });

    let screen!: renderer.ReactTestRenderer;
    await act(async () => {
      screen = renderer.create(<AuthScreen />);
    });

    let emailInput = screen.root.findByType('TextInput');
    await act(async () => {
      emailInput.props.onChangeText('reviewer@stecstats.com');
    });
    emailInput = screen.root.findByType('TextInput');
    await act(async () => {
      await emailInput.props.onSubmitEditing();
    });

    const otpInput = screen.root.findByType('TextInput');
    await act(async () => {
      // This is the event shape produced by iPad OTP autofill/paste. Include a
      // non-digit too, proving the production sanitization remains active.
      otpInput.props.onChangeText('12a3456');
      await Promise.resolve();
    });

    expect(prepareFirstFactor).toHaveBeenCalledWith({
      strategy: 'email_code',
      emailAddressId: 'email_address_1',
    });
    expect(attemptFirstFactor).toHaveBeenCalledWith({
      strategy: 'email_code',
      code: '123456',
    });
    expect(setActive).toHaveBeenCalledWith({ session: 'session_from_autofill' });
  });
});