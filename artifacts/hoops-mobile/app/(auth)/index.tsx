import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  useColorScheme,
} from 'react-native';
import { useSignIn, useSignUp } from '@clerk/clerk-expo';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';

type Phase = 'email' | 'otp';
type Mode = 'signIn' | 'signUp';

export default function AuthScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const { signIn, setActive: setSignInActive, isLoaded: signInLoaded } = useSignIn();
  const { signUp, setActive: setSignUpActive, isLoaded: signUpLoaded } = useSignUp();

  const [phase, setPhase] = useState<Phase>('email');
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [appleAvailable, setAppleAvailable] = useState(false);
  const otpRef = useRef<TextInput>(null);

  const isLoaded = signInLoaded && signUpLoaded;

  useEffect(() => {
    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync().then(setAppleAvailable).catch(() => {});
    }
  }, []);

  async function handleAppleSignIn() {
    if (!isLoaded) return;
    setLoading(true);
    setError('');
    try {
      // Nonce ties the Apple identity token to this exact request (replay protection)
      const nonce = Crypto.randomUUID();
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce,
      });
      if (!credential.identityToken) throw new Error('No identity token returned from Apple');

      // Attempt sign-in for returning users
      const signInResult = await signIn!.create({
        strategy: 'oauth_token_apple',
        token: credential.identityToken,
      } as any);

      const isTransferable = signInResult.firstFactorVerification?.status === 'transferable';

      if (isTransferable) {
        // New user — transfer the verified Apple credential into a sign-up
        const suResult = await signUp!.create({
          transfer: true,
          ...(credential.fullName?.givenName  ? { firstName: credential.fullName.givenName  } : {}),
          ...(credential.fullName?.familyName ? { lastName:  credential.fullName.familyName } : {}),
        } as any);
        if (suResult.status === 'complete') {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          await setSignUpActive!({ session: suResult.createdSessionId });
        }
      } else if (signInResult.status === 'complete') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await setSignInActive!({ session: signInResult.createdSessionId });
      }
    } catch (err: any) {
      if (err?.code === 'ERR_REQUEST_CANCELED') return; // User dismissed the Apple sheet
      setError(err?.errors?.[0]?.longMessage ?? err?.message ?? 'Apple Sign-In failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleEmailSubmit() {
    if (!isLoaded || !email.trim()) return;
    setLoading(true);
    setError('');
    try {
      // Try sign-in first; if account not found, switch to sign-up
      const result = await signIn!.create({ identifier: email.trim() });
      if (result.status === 'complete') {
        await setSignInActive!({ session: result.createdSessionId });
        return;
      }
      // Need email OTP
      const factor = result.supportedFirstFactors?.find(
        (f: any) => f.strategy === 'email_code',
      ) as any;
      if (factor) {
        await signIn!.prepareFirstFactor({
          strategy: 'email_code',
          emailAddressId: factor.emailAddressId,
        });
        setMode('signIn');
        setPhase('otp');
        setTimeout(() => otpRef.current?.focus(), 300);
      }
    } catch (err: any) {
      const code = err?.errors?.[0]?.code ?? '';
      if (code === 'form_identifier_not_found') {
        // No account → sign up
        try {
          await signUp!.create({ emailAddress: email.trim() });
          await signUp!.prepareEmailAddressVerification({ strategy: 'email_code' });
          setMode('signUp');
          setPhase('otp');
          setTimeout(() => otpRef.current?.focus(), 300);
        } catch (suErr: any) {
          setError(suErr?.errors?.[0]?.longMessage ?? 'Could not create account');
        }
      } else {
        setError(err?.errors?.[0]?.longMessage ?? 'Something went wrong');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleOtpSubmit() {
    if (!isLoaded || otp.length !== 6) return;
    setLoading(true);
    setError('');
    try {
      if (mode === 'signIn') {
        const result = await signIn!.attemptFirstFactor({
          strategy: 'email_code',
          code: otp,
        });
        if (result.status === 'complete') {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          await setSignInActive!({ session: result.createdSessionId });
        }
      } else {
        const result = await signUp!.attemptEmailAddressVerification({ code: otp });
        if (result.status === 'complete') {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          await setSignUpActive!({ session: result.createdSessionId });
        }
      }
    } catch (err: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err?.errors?.[0]?.longMessage ?? 'Invalid code — try again');
      setOtp('');
    } finally {
      setLoading(false);
    }
  }

  const styles = makeStyles(colors, insets);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Logo */}
        <Image
          source={require('@/assets/images/logo.png')}
          style={styles.logo}
          contentFit="contain"
        />

        <Text style={styles.title}>
          {phase === 'email' ? 'Sign in or create\nan account' : 'Check your email'}
        </Text>
        <Text style={styles.subtitle}>
          {phase === 'email'
            ? 'Enter your email to continue'
            : `We sent a 6-digit code to\n${email}`}
        </Text>

        {phase === 'email' ? (
          <>
            <View style={styles.inputWrap}>
              <Ionicons name="mail-outline" size={18} color={colors.mutedForeground} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="coach@example.com"
                placeholderTextColor={colors.mutedForeground}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                onSubmitEditing={handleEmailSubmit}
                autoFocus
              />
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <TouchableOpacity
              style={[styles.btn, (!email.trim() || loading) && styles.btnDisabled]}
              onPress={handleEmailSubmit}
              disabled={!email.trim() || loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={styles.btnText}>Continue</Text>
              )}
            </TouchableOpacity>

            {appleAvailable && (
              <>
                <View style={styles.dividerRow}>
                  <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
                  <Text style={[styles.dividerText, { color: colors.mutedForeground }]}>or</Text>
                  <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
                </View>
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                  buttonStyle={
                    colorScheme === 'light'
                      ? AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                      : AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                  }
                  cornerRadius={colors.radius + 6}
                  style={styles.appleBtn}
                  onPress={handleAppleSignIn}
                />
              </>
            )}
          </>
        ) : (
          <>
            <View style={styles.inputWrap}>
              <Ionicons name="keypad-outline" size={18} color={colors.mutedForeground} style={styles.inputIcon} />
              <TextInput
                ref={otpRef}
                style={styles.input}
                placeholder="000000"
                placeholderTextColor={colors.mutedForeground}
                value={otp}
                onChangeText={(t) => {
                  setOtp(t.replace(/\D/g, '').slice(0, 6));
                  if (t.replace(/\D/g, '').length === 6) handleOtpSubmit();
                }}
                keyboardType="number-pad"
                returnKeyType="done"
                maxLength={6}
              />
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <TouchableOpacity
              style={[styles.btn, (otp.length !== 6 || loading) && styles.btnDisabled]}
              onPress={handleOtpSubmit}
              disabled={otp.length !== 6 || loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={styles.btnText}>Verify</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.back}
              onPress={() => { setPhase('email'); setOtp(''); setError(''); }}
            >
              <Text style={styles.backText}>← Use a different email</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
function makeStyles(colors: ReturnType<typeof import('@/hooks/useColors').useColors>, insets: ReturnType<typeof useSafeAreaInsets>) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    scroll: {
      flexGrow: 1,
      paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 60),
      paddingHorizontal: 28,
      paddingBottom: insets.bottom + 40,
    },
    logo: { width: 220, height: 52, marginBottom: 40 },
    title: {
      fontSize: 28,
      fontFamily: 'Inter_700Bold',
      color: colors.foreground,
      marginBottom: 8,
      lineHeight: 34,
    },
    subtitle: {
      fontSize: 15,
      color: colors.mutedForeground,
      marginBottom: 32,
      lineHeight: 22,
    },
    inputWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.input,
      borderRadius: colors.radius + 6,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 12,
    },
    inputIcon: { paddingLeft: 14 },
    input: {
      flex: 1,
      height: 52,
      paddingHorizontal: 12,
      fontSize: 16,
      color: colors.foreground,
      fontFamily: 'Inter_400Regular',
    },
    error: {
      color: colors.destructive,
      fontSize: 13,
      marginBottom: 12,
      fontFamily: 'Inter_400Regular',
    },
    btn: {
      height: 52,
      borderRadius: colors.radius + 6,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 4,
    },
    btnDisabled: { opacity: 0.4 },
    btnText: {
      fontSize: 16,
      fontFamily: 'Inter_600SemiBold',
      color: colors.primaryForeground,
    },
    back: { marginTop: 20, alignItems: 'center' },
    backText: { color: colors.mutedForeground, fontSize: 14, fontFamily: 'Inter_400Regular' },
    dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 16 },
    dividerLine: { flex: 1, height: 1 },
    dividerText: { fontSize: 12, fontFamily: 'Inter_400Regular' },
    appleBtn: { height: 52, width: '100%' },
  });
}
