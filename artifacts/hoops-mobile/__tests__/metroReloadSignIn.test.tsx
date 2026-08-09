/**
 * metroReloadSignIn.test.tsx
 *
 * Regression guard for the Metro-reload sign-in persistence fix.
 *
 * Background
 * ----------
 * On a Metro reload, Clerk starts with isSignedIn=false while it restores
 * the session from SecureStore. This transient state is indistinguishable
 * from a real sign-out unless we also check isLoaded.
 *
 * The bug (pre-fix): the RC effect called logoutRevenueCat() during that
 * window, which in Expo Go's Browser Mode throws "Unknown backend error"
 * and could corrupt RC state before loginRevenueCat() fired a moment later.
 *
 * The fix: useRevenueCatAuthSync guards on `isLoaded` before acting on
 * isSignedIn. The effect returns early when isLoaded=false, so
 * logoutRevenueCat() is only called for a deliberate sign-out.
 *
 * Covers
 * ------
 * 1. isLoaded=false → neither RC call fires (Metro reload transient window).
 * 2. isLoaded=true, isSignedIn=true → loginRevenueCat fires with userId.
 * 3. isLoaded=true, isSignedIn=false → logoutRevenueCat fires (real sign-out).
 * 4. Full reload sequence: isLoaded=false → isLoaded=true, isSignedIn=true →
 *    only loginRevenueCat fires; logoutRevenueCat is never called.
 */

// ── Mocks (hoisted before imports) ────────────────────────────────────────────

const mockLoginRevenueCat = jest.fn();
const mockLogoutRevenueCat = jest.fn();
const mockClearPendingPhotos = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/revenuecat', () => ({
  loginRevenueCat: (...args: any[]) => mockLoginRevenueCat(...args),
  logoutRevenueCat: (...args: any[]) => mockLogoutRevenueCat(...args),
}));

jest.mock('@/lib/pendingPhotoQueue', () => ({
  clearPendingPhotos: (...args: any[]) => mockClearPendingPhotos(...args),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { useRevenueCatAuthSync } from '../lib/useRevenueCatAuthSync';

// ── Test component ────────────────────────────────────────────────────────────
//
// Renders the hook with the given auth state so react-test-renderer can drive
// the useEffect lifecycle.

interface AuthState {
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
}

function Fixture({ isLoaded, isSignedIn, userId }: AuthState) {
  useRevenueCatAuthSync({ isLoaded, isSignedIn, userId });
  return null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Case 1: Transient Metro reload window ──────────────────────────────────────

describe('Metro reload — Clerk not yet loaded (isLoaded=false)', () => {
  test('logoutRevenueCat is NOT called during the transient reload state', async () => {
    await act(async () => {
      renderer.create(<Fixture isLoaded={false} isSignedIn={false} userId={null} />);
    });

    expect(mockLogoutRevenueCat).not.toHaveBeenCalled();
  });

  test('loginRevenueCat is NOT called during the transient reload state', async () => {
    await act(async () => {
      renderer.create(<Fixture isLoaded={false} isSignedIn={false} userId={null} />);
    });

    expect(mockLoginRevenueCat).not.toHaveBeenCalled();
  });
});

// ── Case 2: Session fully restored after reload ────────────────────────────────

describe('Session restored (isLoaded=true, isSignedIn=true)', () => {
  test('loginRevenueCat is called with the correct userId', async () => {
    await act(async () => {
      renderer.create(<Fixture isLoaded={true} isSignedIn={true} userId="user_abc123" />);
    });

    expect(mockLoginRevenueCat).toHaveBeenCalledTimes(1);
    expect(mockLoginRevenueCat).toHaveBeenCalledWith('user_abc123');
  });

  test('logoutRevenueCat is NOT called when the session was restored', async () => {
    await act(async () => {
      renderer.create(<Fixture isLoaded={true} isSignedIn={true} userId="user_abc123" />);
    });

    expect(mockLogoutRevenueCat).not.toHaveBeenCalled();
  });
});

// ── Case 3: Deliberate sign-out ────────────────────────────────────────────────

describe('Deliberate sign-out (isLoaded=true, isSignedIn=false)', () => {
  test('logoutRevenueCat IS called on an explicit sign-out', async () => {
    await act(async () => {
      renderer.create(<Fixture isLoaded={true} isSignedIn={false} userId={null} />);
    });

    expect(mockLogoutRevenueCat).toHaveBeenCalledTimes(1);
  });

  test('loginRevenueCat is NOT called on an explicit sign-out', async () => {
    await act(async () => {
      renderer.create(<Fixture isLoaded={true} isSignedIn={false} userId={null} />);
    });

    expect(mockLoginRevenueCat).not.toHaveBeenCalled();
  });
});

// ── Case 4: Full Metro reload sequence ────────────────────────────────────────
//
// Simulates the real sequence:
//   t=0  isLoaded=false, isSignedIn=false  (Clerk restoring SecureStore)
//   t=1  isLoaded=true,  isSignedIn=true   (session restored successfully)
//
// logoutRevenueCat must never fire across the full sequence.

describe('Full Metro reload sequence (transient → restored)', () => {
  test('logoutRevenueCat is never called at any point during the reload sequence', async () => {
    // t=0: transient loading state immediately after Metro reload
    let instance!: renderer.ReactTestRenderer;
    await act(async () => {
      instance = renderer.create(
        <Fixture isLoaded={false} isSignedIn={false} userId={null} />,
      );
    });

    expect(mockLogoutRevenueCat).not.toHaveBeenCalled();

    // t=1: Clerk has fully restored the session from SecureStore
    await act(async () => {
      instance.update(<Fixture isLoaded={true} isSignedIn={true} userId="user_abc123" />);
    });

    expect(mockLogoutRevenueCat).not.toHaveBeenCalled();
  });

  test('loginRevenueCat is called exactly once once the session is restored', async () => {
    // t=0: transient loading state
    let instance!: renderer.ReactTestRenderer;
    await act(async () => {
      instance = renderer.create(
        <Fixture isLoaded={false} isSignedIn={false} userId={null} />,
      );
    });

    expect(mockLoginRevenueCat).not.toHaveBeenCalled();

    // t=1: session fully restored
    await act(async () => {
      instance.update(<Fixture isLoaded={true} isSignedIn={true} userId="user_abc123" />);
    });

    expect(mockLoginRevenueCat).toHaveBeenCalledTimes(1);
    expect(mockLoginRevenueCat).toHaveBeenCalledWith('user_abc123');
  });
});
