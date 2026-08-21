# MicroGPT

**Offline AI on your phone — chat *and* image generation, running entirely on
the device.** No API keys, no inference server, no data leaving the handset.
Download a model once and everything after that works in airplane mode.

[![Get it on Google Play](https://img.shields.io/badge/Google%20Play-Download-414141?logo=google-play&logoColor=white)](https://play.google.com/store/apps/details?id=com.anonymous.MicroGpt)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Built with Expo / React Native. Android is the mature platform; iOS is
supported through Expo prebuild (see [`docs/IOS.md`](docs/IOS.md)).

---

## What the app does

### Chat with local language models
- Runs GGUF models through [`llama.rn`](https://github.com/mybigday/llama.rn) —
  Qwen 3.5, Gemma 3, Phi-4-mini, Ministral, SmolLM3, DeepSeek-R1 distills and
  anything else GGUF.
- **Vision models** too (SmolVLM, Qwen3-VL, Gemma-4, MiniCPM-V) — attach a
  photo to a message and ask about it.
- Hardware acceleration picker: **auto / CPU / GPU (OpenCL) / NPU (Hexagon)**.
- Chat history is stored locally on the device.

### Generate images on the device
Three engines on Android, picked automatically from the model format:

| Engine | Backend | Speed (512x512) | Models |
|---|---|---|---|
| `local-dream` | Qualcomm **NPU** (Hexagon / QNN) | ~5-10 s | Prebuilt QNN model packs |
| `local-dream` | Adreno **GPU** (MNN / OpenCL) | ~15-30 s | Prebuilt MNN model packs |
| `sd-server` | **CPU** ([stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)) | minutes | Any GGUF / safetensors — SD 1.5, SDXL, SD 3 |

On iOS the same JS API is served by **Apple Core ML**
([`ml-stable-diffusion`](https://github.com/apple/ml-stable-diffusion)),
with SD 1.5 / SDXL model bundles downloaded from Hugging Face.

This is all packaged as a reusable Expo module —
[`modules/expo-stable-diffusion/`](modules/expo-stable-diffusion/) — see its
[README](modules/expo-stable-diffusion/README.md) for the API, how the engines
are selected, and how prebuilt executables are shipped and resolved inside an
Android app. The published RN/Expo Stable Diffusion packages are iOS Core ML
only; the Android work that does exist has not reached end-to-end
Snapdragon-accelerated generation.

### Combo mode — a chat model that sends you pictures
Load a text model *and* an image model at once. The LLM is prompted to emit
`[IMG: a description]` when it wants to "send a photo";
[`lib/combo-chat-handler.ts`](lib/combo-chat-handler.ts) strips the tag out of
the visible text and renders the generated image inline in the conversation.

Because the LLM's Hexagon backend and the image model's QNN runtime both want
the same DSP, [`lib/npu-coordinator.ts`](lib/npu-coordinator.ts) arbitrates
ownership — the image model wins and the text model transparently falls back
to GPU/CPU rather than failing with a FastRPC contention error.

### Characters
- Create characters with a persona, scenario, greeting and example dialogue.
- Publish them, browse and like what other people published (Supabase-backed).
- Import from [Chub.ai](https://chub.ai) through an in-app browser.

### Getting models
- A curated catalog with RAM-aware guardrails, so a phone is not offered a
  model it cannot load.
- An in-app **Hugging Face browser** for anything not in the catalog —
  including split-GGUF repos, which are detected and grouped.
- [`lib/gguf-detect.ts`](lib/gguf-detect.ts) reads the real GGUF header
  (first 512 KB) to classify a download as text / vision / image rather than
  guessing from the filename.
- Downloads run through a custom native module,
  [`modules/expo-download-manager/`](modules/expo-download-manager/), with
  real progress, speed, ETA, and HTTP-Range resume across app kills.

---

## Setting it up

> **Nothing here works out of the box after `git clone`.** There are four
> things you have to supply yourself: environment variables, a Supabase
> project, Google OAuth clients, and the native image-generation binaries.
> Each is described below.

### 0. Prerequisites

| | |
|---|---|
| Node.js | 20 LTS or newer |
| Android | Studio + SDK, **minSdk 30** (Android 11), arm64 device or emulator |
| iOS | Xcode 15+, deployment target **16.0** — or just use EAS |
| Docker | only if you want to build the CPU image-gen binary yourself |

A real device is strongly recommended. On-device inference on an emulator is
slow, and the NPU/GPU paths do not exist there at all.

### 1. Install dependencies

```bash
npm install
```

**On Windows, use this instead:**

```bash
npm run install:windows
```

The `llama.rn` postinstall extracts native artifacts with GNU `tar`, which
mis-parses `C:\...` paths as `host:path` and fails. The Windows script runs
`npm install --ignore-scripts` first, then applies our `patch-package` patch
and re-runs the download with the system `bsdtar`. Do **not** add
`--legacy-peer-deps` — it produces a lockfile EAS rejects.

Full details, plus how to update every engine: [`docs/UPDATING.md`](docs/UPDATING.md).

### 2. Create `.env` — required, the app will not start without it

Copy the template and fill it in:

```bash
cp .env.example .env
```

```bash
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxx
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=your-client-id.apps.googleusercontent.com

# iOS only — omit on Android
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=1234-abcd.apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME=com.googleusercontent.apps.1234-abcd
```

`.env` is gitignored. Never commit it.

The two Supabase values are **not optional**: `app/_layout.tsx` mounts
`SupabaseAuthProvider`, which calls `createClient()` at module scope. Leave
them blank and the app dies on launch with `supabaseUrl is required.`

For EAS cloud builds the same values must exist as EAS secrets — `.env` is not
uploaded:

```bash
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --value "..."
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value "..."
eas secret:create --scope project --name EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID --value "..."
```

`app.config.js` validates these and fails the build early if any is missing.

### 3. Set up the Supabase project

Create a project at [supabase.com](https://supabase.com), then run both SQL
files against it, in order, from the SQL editor:

1. [`supabase-setup.sql`](supabase-setup.sql) — tables (`users`,
   `public_characters`, `user_likes`, `user_likes_users`,
   `character_downloads`) plus row-level-security policies.
2. [`supabase-migration-counter-integrity.sql`](supabase-migration-counter-integrity.sql)
   — the `toggle_character_like`, `toggle_user_like` and `increment_download`
   RPCs, and triggers that stop like/download counters being written directly.

Then enable **Google** as an auth provider in *Authentication → Providers* and
paste in your Google web client ID and secret.

Take `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
from *Project Settings → API*. Use the **publishable / anon** key. The
`service_role` key must never appear in a mobile app.

### 4. Set up Google Sign-In

In [Google Cloud Console](https://console.cloud.google.com) → *APIs & Services
→ Credentials*, create OAuth 2.0 client IDs:

- **Web application** → this is `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, and it is
  also what the Supabase Google provider needs. Android authenticates against
  the *web* client, not an Android one.
- **Android** → package `com.anonymous.MicroGpt` plus the SHA-1 of your
  signing certificate. Needed for sign-in to succeed on device, even though
  its client ID is never referenced in code. Get the debug SHA-1 with
  `cd android && ./gradlew signingReport`, and the release one from
  `eas credentials`.
- **iOS** → bundle id `com.anonymous.MicroGpt`. Gives you the two iOS values
  in `.env`.

Sign-in is only needed to publish characters and keep a profile. Chat and
image generation work fully signed out.

### 5. Supply the native image-generation binaries

**Image generation will not work until you do this.** These binaries are
deliberately absent from the repository — see [CREDITS.md](CREDITS.md) for
exactly why.

#### CPU engine — `libsd-server.so` (needed for GGUF / SDXL / SD3)

Cross-compiled from [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)
(MIT). Requires Docker:

```bash
npm run build:sd-server   # ~10-20 min the first time
npm run check-16k         # verify 16 KB page alignment for Android 15+
```

The result is written to
`modules/expo-stable-diffusion/android/src/main/jniLibs/arm64-v8a/libsd-server.so`.

#### GPU / NPU engines — `libstable_diffusion_core.so` + QNN runtime (optional)

These come from [xororz/local-dream](https://github.com/xororz/local-dream),
which is **CC BY-NC 4.0**, and they carry the proprietary Qualcomm QNN runtime
(~132 MB) with them. We cannot re-host either, so you have to extract them
from an upstream release APK yourself. The exact commands are in
[`docs/UPDATING.md`](docs/UPDATING.md) sections 2 and 4.

They land in:

```
modules/expo-stable-diffusion/android/src/main/jniLibs/arm64-v8a/libstable_diffusion_core.so
modules/expo-stable-diffusion/android/src/main/assets/qnnlibs/*.so
```

Skip this step and the app still builds and runs — the fast Snapdragon paths
just report as unavailable and image generation uses the CPU engine.

**If you ship a build containing these files, the NonCommercial term and
Qualcomm's SDK terms are yours to comply with.** iOS is unaffected: it uses
Apple Core ML and needs none of this.

### 6. Run it

```bash
npx expo run:android      # builds a dev client and installs it
npx expo start            # Metro, once the dev client is installed
```

This app cannot run in Expo Go — it has custom native modules and needs a
[development build](https://docs.expo.dev/develop/development-builds/introduction/).

For EAS cloud builds (APK, Play Store bundle, TestFlight) see
[`BUILD.md`](BUILD.md). For the iOS specifics — prebuild, Core ML, why `ios/`
is not committed — see [`docs/IOS.md`](docs/IOS.md).

### 7. Get a model

Launch the app, open the models sheet, and download something small first
(Qwen3.5-0.8B is a good smoke test). Models are saved to
`Download/MicroGPT` on Android and `Documents/MicroGPT` on iOS.

---

## Repository layout

```
app/                      expo-router screens (tabs: home, chat, explore, profile)
components/               UI — image generation view, model pickers, modals
lib/                      GGUF detection, image-gen service, NPU coordinator,
                          combo-mode stream parser, Supabase + Chub clients
store/                    zustand slices (models, characters, sessions, settings)
modules/
  expo-stable-diffusion/  the on-device image generation module
  expo-download-manager/  resumable native downloader
plugins/                  config plugin that vendors Core ML into the iOS build
scripts/                  Docker recipe for sd-server, 16 KB alignment auditor
docs/                     IOS.md, UPDATING.md, model catalog notes
```

---

## Licence

MIT — see [LICENSE](LICENSE). Third-party components keep their own licences,
and some of them are **not** MIT: read [CREDITS.md](CREDITS.md) before
redistributing anything from here.

No model weights are shipped with the app. Every model is downloaded by the
user at runtime under its own licence.
