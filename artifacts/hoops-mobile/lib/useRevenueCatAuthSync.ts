/**
 * useRevenueCatAuthSync
 *
 * Synchronises the RevenueCat subscriber identity with the signed-in Clerk
 * user. Extracted from ApiAuthSetup in app/_layout.tsx so the guard logic
 * can be unit-tested without pulling in Expo's heavy native module tree.
 *
 * IMPORTANT — the isLoaded guard
 * --------------------------------
 * On a Metro reload (or any app restart), Clerk starts with
 *   isSignedIn=false, isLoaded=false
 * while it restores the session from SecureStore. This state is
 * indistinguishable from a deliberate sign-out unless we also inspect
 * isLoaded. Calling logoutRevenueCat() during that window would:
 *   1. Log RC out unnecessarily — the user IS still signed in.
 *   2. In Expo Go's Browser Mode, throw "Unknown backend error" from RC,
 *      potentially corrupting RC state before loginRevenueCat() fires.
 *
 * By returning early when !isLoaded, we ensure logoutRevenueCat() is only
 * called for a real sign-out — never for the transient reload state.
 */

import { useEffect, useRef } from 'react';
import { loginRevenueCat, logoutRevenueCat } from '@/lib/revenuecat';
import { clearPendingPhotos } from '@/lib/pendingPhotoQueue';

interface AuthState {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  userId: string | null | undefined;
}

export function useRevenueCatAuthSync({ isLoaded, isSignedIn, userId }: AuthState): void {
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isLoaded) return; // wait until Clerk has fully restored the session

    if (isSignedIn && userId) {
      loginRevenueCat(userId);
    } else if (!isSignedIn) {
      // Only reach here for a deliberate sign-out, not a transient reload state.
      logoutRevenueCat();
      // Clear the queue for the coach who just signed out.
      const prev = prevUserIdRef.current;
      if (prev) {
        clearPendingPhotos(prev).catch(() => {});
      }
    }
    prevUserIdRef.current = userId;
  }, [isLoaded, isSignedIn, userId]);
}
