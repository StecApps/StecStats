# Local Xcode release build

Use this process when EAS Build is unavailable. It creates the native iOS
workspace locally, validates production client configuration, and leaves the
final signing, archive, and TestFlight upload to Xcode.

## 1. Create the local production environment

From `artifacts/hoops-mobile`:

```bash
cp local-ios-release.env.example .env.local
```

Open `.env.local` and set `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` to the
**Production** publishable key for the same Replit-managed Clerk tenant shown
in the project's Users & Auth pane. Do not use a key copied from an old EAS
profile or another Clerk project.

The file is ignored by Git. Do not commit it.

## 2. Install dependencies

From the repository root:

```bash
corepack enable
pnpm install
```

## 3. Generate the native iOS workspace

```bash
pnpm --filter @workspace/hoops-mobile run ios:release:prepare
```

This runs Expo prebuild for iOS without `--clean`, preserving any existing
native project changes. It also applies Clerk's required iOS 17 deployment
target before CocoaPods installs ClerkKit. The generated `ios/` directory is
intentionally ignored by Git.

## 4. Validate the production environment

```bash
pnpm --filter @workspace/hoops-mobile run ios:release:check
```

The check intentionally fails if the build would use a missing/test/wrong-tenant
Clerk key, the wrong API domain, the wrong Clerk proxy, a proxy that does not
advertise email-code and Apple-token login, a non-proxy-capable Clerk Expo SDK,
an iOS deployment target below 17, or a missing RevenueCat iOS key. It never
prints the key value.

## 5. Verify on a physical iPhone

Connect the iPhone and run:

```bash
pnpm --filter @workspace/hoops-mobile run ios:release:device
```

Before archiving, verify:

1. Sign in with Apple completes without a Clerk strategy error.
2. `reviewer@stecstats.com` receives a fresh six-digit code promptly.
3. Pasting or autofilling the code leaves the login screen.
4. Monthly and annual StoreKit products appear.
5. Purchase, restore, subscription management, and account deletion work.

## 6. Archive and upload to TestFlight

Open the workspace:

```bash
open artifacts/hoops-mobile/ios/StecStats.xcworkspace
```

If that workspace name differs, open the only `.xcworkspace` inside
`artifacts/hoops-mobile/ios`.

In Xcode:

1. Select the StecStats scheme.
2. Select **Any iOS Device (arm64)** as the destination.
3. Confirm the Release signing team and bundle identifier.
4. Choose **Product → Archive**.
5. In Organizer, right-click the new archive and choose **Show in Finder**.
6. Before uploading, verify that exact archive from the repository root:

```bash
pnpm --filter @workspace/hoops-mobile run ios:release:verify-archive -- \
  "/full/path/to/StecStats.xcarchive"
```

The verifier fails if the archive has no `main.jsbundle` or if the bundle does
not contain the production values from `.env.local`. It reports variable names
only and never prints the Clerk key.

7. In Organizer, choose **Distribute App → App Store Connect → Upload**.
8. Wait for processing, then install that exact build from TestFlight.

Do not resubmit the older build. Clerk client configuration is embedded in the
JavaScript bundle during the native archive, so correcting `.env.local`
requires a newly archived binary.