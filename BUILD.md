# Build commands (EAS)

Quick reference for building MicroGPT on [EAS](https://expo.dev/eas). Run
everything from the repo root on the branch you want built — EAS builds from
your local committed state.

Before your first build, finish the setup in the [README](README.md):
`.env` / EAS secrets, the Supabase project, Google OAuth clients, and the
native image-generation binaries.

---

## TL;DR

| Goal | Command |
|---|---|
| Android test APK (installable) | `eas build --platform android --profile preview` |
| Android Play Store bundle | `eas build --platform android --profile production` |
| iOS test build (direct install link) | *(set iOS env vars, then)* `eas build --platform ios --profile test` |
| iOS TestFlight / App Store | *(set iOS env vars, then)* `eas build --platform ios --profile production` |

Add `--non-interactive --no-wait` to any of them to queue the build and
return immediately (it runs on EAS servers regardless of your network).

---

## Android

No Apple credentials needed — EAS uses the stored Android keystore
automatically, fully non-interactive.

```powershell
# Installable APK for testing (internal distribution -> direct install link):
eas build --platform android --profile preview

# Play Store bundle (.aab) for release:
eas build --platform android --profile production
```

Queue it and don't block the terminal:
```powershell
eas build --platform android --profile preview --non-interactive --no-wait
```

---

## iOS

iOS auth uses an App Store Connect API key, which avoids the Apple password
and 2FA prompts. Create one in App Store Connect under *Users and Access ->
Integrations -> App Store Connect API*, download the `.p8`, and keep it
**outside the repository** (`*.p8` is gitignored).

Set these three env vars in the same shell as the build command:

```powershell
$env:EXPO_ASC_KEY_ID="<your App Store Connect Key ID>"
$env:EXPO_ASC_ISSUER_ID="<your App Store Connect Issuer ID>"
$env:EXPO_ASC_API_KEY_PATH="<absolute path to AuthKey_XXXXXXXX.p8>"
```

Then:

```powershell
# Ad-hoc test build -> EAS prints a direct install link + QR for registered
# devices. Best for quick on-device testing:
eas build --platform ios --profile test --non-interactive --no-wait

# TestFlight / App Store build:
eas build --platform ios --profile production --non-interactive --no-wait
# ...then push the finished build to TestFlight:
eas submit --platform ios --latest
```

Once the signing certificate and provisioning profile exist in EAS (created
on your first interactive run), `--non-interactive` works for every build
after that.

---

## Get the install link / check status

After a `--no-wait` build, the command prints a `https://expo.dev/.../builds/<id>`
link. Open it for live logs and, when finished, the **Install** button / QR.
Or from the CLI:

```powershell
# List recent builds with their status + artifact URLs:
eas build:list --platform ios --limit 5
eas build:list --platform android --limit 5

# Inspect one build:
eas build:view <build-id>
```

- **Android APK** installs by opening the artifact `.apk` URL on the phone.
- **iOS ad-hoc** installs by opening the build's install page in **Safari**
  on a registered device, then trusting it under
  *Settings -> General -> VPN & Device Management*.
- **iOS TestFlight** installs via the **TestFlight** app after `eas submit`.

---

## Build profiles (`eas.json`)

| Profile | Platform(s) | Output |
|---|---|---|
| `preview` | Android (APK), iOS | Installable test build, internal distribution |
| `test` | iOS only | Ad-hoc install link (registered devices) |
| `production` | Android (AAB), iOS | Store build (Play Store / TestFlight) |
| `development` | both | Dev-client build (needs Metro running) |
| `ios-sim` | iOS | Simulator build (Mac only; for compile checks) |
| `apk` | Android | Plain APK, no version auto-increment |

All non-dev profiles load env vars from the EAS **production** environment.
See [`docs/IOS.md`](docs/IOS.md) for the full iOS notes.
