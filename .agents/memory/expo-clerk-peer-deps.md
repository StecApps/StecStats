---
name: Expo Clerk peer deps
description: @clerk/clerk-expo peer dependency requirements and version pitfalls for expo@54
---

## Rule
`@clerk/clerk-expo` requires `expo-auth-session` as a peer dep. Always install it explicitly alongside Clerk; pnpm won't pull it in automatically and Metro will 500 with an UnableToResolveError.

**Why:** `@clerk/clerk-expo` imports `expo-auth-session` in its `useSSO` and `useOAuth` hooks unconditionally, even if you don't use SSO/OAuth.

## Version table (expo@54 / expo-router@6)
| Package | Correct version for expo@54 |
|---|---|
| `@clerk/clerk-expo` | `^2.x` |
| `expo-auth-session` | `~7.0.11` (run `expo install --check` to confirm) |
| `expo-secure-store` | `~15.0.8` |
| `expo-camera` | `~17.0.10` |
| `expo-video` | `~3.0.16` |

**How to apply:** After `pnpm add @clerk/clerk-expo`, immediately run `pnpm exec expo install expo-auth-session` (which picks the compatible version automatically), then restart Metro.

## Token cache pattern
```ts
import * as SecureStore from 'expo-secure-store';
const tokenCache = {
  getToken: (key: string) => SecureStore.getItemAsync(key),
  saveToken: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  clearToken: (key: string) => SecureStore.deleteItemAsync(key),
};
// Pass to <ClerkProvider tokenCache={tokenCache} />
```
