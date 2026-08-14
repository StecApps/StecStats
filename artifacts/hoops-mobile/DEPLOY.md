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

Monitor the **preview** channel on the Expo dashboard and smoke-test on a device enrolled in the preview channel:

```
https://expo.dev/accounts/stec/projects/hoops-mobile/updates?channel=preview
```

Do **not** promote to production until the preview build is confirmed stable.

---

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
eas update:republish --group <previous-group-id> --destination-channel production
```

Or use the package.json alias (replace the group ID in the script or pass it inline):

```bash
GROUP=<previous-group-id> pnpm rollback:prod
```

### Step 3 — Verify

After republishing, open the Expo dashboard and confirm the production channel now points to the restored group. Coaches will receive the rollback update on next app foreground.

---

## Notes

- `eas update:republish` does **not** create a new build — it re-points the channel to an existing update group.
- The rollback takes effect for all coaches within seconds; no App Store review is required.
- If the crash is in native code (not JS), a new binary build and App Store/TestFlight submission is required — OTA rollback won't help.
- Keep the last 2–3 stable group IDs noted in your release notes or Slack so you can act quickly without hunting through the dashboard.

---


## Verifying a Rollback End-to-End

Use this procedure to confirm the rollback path works **before** you need it in a real incident.


### How to read the active bundle on a device

Open the app → Profile tab → **About** section. The **Bundle** row shows:

```
<channel>  ·  …<last-8-chars-of-update-group-id>
```

Tap the row to open the native share sheet and share/copy the full update group UUID. This is the ground-truth indicator of which bundle the device is running — no Xcode or ADB needed.


### Full test procedure

> All steps use the **preview** channel and a device enrolled in that channel.
> Production is never touched, so coaches are unaffected throughout.

1. **Record the preview baseline group ID**
   On a device enrolled in the **preview** channel, open Profile → About → Bundle.
   Tap the Bundle row and share/copy the full group UUID — this is the baseline you will restore in step 4.
   Also note the last 8 chars displayed in the row so you can confirm visually.

2. **Publish a canary to preview**
   Make a small, detectable change (e.g. a temporary log or label). Publish to preview:
   ```bash
   eas update --channel preview --message "rollback-test: canary"
   # or:
   pnpm release:staging
   ```
   The CLI prints the new group ID on success. Note it, or find it in the Expo dashboard:
   ```
   https://expo.dev/accounts/stec/projects/hoops-mobile/updates?channel=preview
   ```

3. **Confirm the preview device received the canary**
   Foreground the app (or cold-launch). The Bundle row should show `preview  ·  …<canary-suffix>` — different from the baseline suffix noted in step 1.

4. **Roll back the preview channel to the baseline**
   ```bash
   eas update:republish --group <baseline-group-id> --destination-channel preview
   ```
   This is the identical command shape used in a real production rollback, exercised safely against preview.

5. **Confirm the device is back on the baseline**
   Foreground the app again. The Bundle row must show `preview  ·  …<baseline-suffix>` — matching step 1.
   If it still shows the canary suffix, wait ~30 s and relaunch. If it persists, verify in the Expo dashboard that the preview channel pointer changed.

6. **Promote confidence to production (optional)**
   Once the preview rollback is confirmed, you can run an identical drill against `--destination-channel production` using a production-enrolled test device, replacing the `GROUP=` with a known stable production group ID:
   ```bash
   GROUP=<stable-production-group-id> pnpm rollback:prod
   ```


### Interpreting the Bundle row

| Value | Meaning |
|---|---|
| `production  ·  …a1b2c3d4` | Running on production channel, update group ending in `a1b2c3d4` |
| `dev  ·  dev build` | Local Expo Go / development build — OTA not active |
| `preview  ·  …xxxxxxxx` | Running on preview channel (not production) |
