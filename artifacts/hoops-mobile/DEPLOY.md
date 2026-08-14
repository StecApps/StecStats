# Hoops Mobile — Deployment & OTA Rollback Runbook

## OTA Updates (EAS Update)

Over-the-air updates are published via EAS Update. Updates are **staged to the `preview` channel first** and promoted to `production` only after a smoke test passes. This prevents a bad JS bundle from reaching all coaches at once.

### Two-step publish flow

#### Step 1 — Publish to the preview channel

```bash
eas update --channel preview --message "describe what changed"
# or use the package.json alias:
pnpm release:staging
```

Open the Expo dashboard for the preview channel and install the update on a test device (or ask a beta coach to verify):

```
https://expo.dev/accounts/stec/projects/hoops-mobile/updates?channel=preview
```

Verify that the app launches, scoring works, and there are no crashes.

#### Step 2 — Promote to production

Once the preview build is confirmed good, publish the same change to production:

```bash
eas update --channel production --message "describe what changed"
# or use the package.json alias:
pnpm release:prod
```

Monitor the production channel on the Expo dashboard:

```
https://expo.dev/accounts/stec/projects/hoops-mobile/updates?channel=production
```

Coaches receive the update on the next app foreground.

---

## Rolling Back a Bad OTA Update

If a bad JS update is crashing coaches' apps, re-point the production channel to the last known-good update group immediately.

### Step 1 — Find the previous good group ID

Open the Expo dashboard for the production channel:

```
https://expo.dev/accounts/stec/projects/hoops-mobile/updates?channel=production
```

Locate the last update group that was stable (the one before the bad publish). Copy its **Group ID** (a UUID like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).

### Step 2 — Re-publish the good group

```bash
eas update --republish --channel production --group <previous-group-id>
```

Or use the package.json alias (replace the group ID in the script or pass it inline):

```bash
GROUP=<previous-group-id> pnpm rollback:prod
```

### Step 3 — Verify

After republishing, open the Expo dashboard and confirm the production channel now points to the restored group. Coaches will receive the rollback update on next app foreground.

---

## Notes

- `--republish` does **not** create a new build — it re-points the channel to an existing update group.
- The rollback takes effect for all coaches within seconds; no App Store review is required.
- If the crash is in native code (not JS), a new binary build and App Store/TestFlight submission is required — OTA rollback won't help.
- Keep the last 2–3 stable group IDs noted in your release notes or Slack so you can act quickly without hunting through the dashboard.
