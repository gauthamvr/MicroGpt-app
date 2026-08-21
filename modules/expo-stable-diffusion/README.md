# expo-stable-diffusion (MicroGPT)

On-device Stable Diffusion for React Native / Expo, with **one JS API across
Android and iOS** and three Android inference backends — Qualcomm NPU, Adreno
GPU, and CPU.

This is a local Expo module (it lives in `modules/`, it is not on npm). It is
documented here because the Android half fills a gap: the published RN/Expo
Stable Diffusion packages are iOS Core ML only.

- [`andrei-zgirvaci/expo-stable-diffusion`](https://github.com/andrei-zgirvaci/expo-stable-diffusion)
  — iOS Core ML. Its README lists Android as future work. **Unrelated project
  that happens to share the directory name.**
- [`jeongshin/react-native-ml-stable-diffusion`](https://github.com/jeongshin/react-native-ml-stable-diffusion)
  — also Core ML / Apple Silicon.

Neither runs on Android. If you know of prior art that does, please open an
issue — we would rather use it than maintain this.

---

## The JS API

Identical on both platforms, so calling code never branches on `Platform.OS`:

```ts
import * as SD from 'expo-stable-diffusion';

SD.hello();              // diagnostics: which binaries and which SoC were found
await SD.loadModel(path);
SD.isLoaded();

const sub = SD.addProgressListener(({ step, totalSteps, engine, backend }) => {
  console.log(`${step}/${totalSteps} on ${engine}/${backend}`);
});

const pngBase64 = await SD.generate({
  prompt: 'a red fox in snow, cinematic lighting',
  negativePrompt: 'blurry, low quality',
  width: 512,
  height: 512,
  steps: 20,
  cfgScale: 7.5,
  seed: -1,          // -1 = random
});

await SD.cancelGeneration();
await SD.unloadModel();   // frees 1-2 GB
sub.remove();
```

`loadModel` takes a **file** (`.gguf` / `.safetensors`) or a **directory**
(an MNN or QNN model pack, or a Core ML `.mlmodelc` bundle on iOS). The engine
is chosen from what it finds — the caller does not pick one.

| Path shape | Engine selected |
|---|---|
| Directory containing `unet.bin` | local-dream, **QNN / NPU** |
| Directory containing `unet.mnn` | local-dream, **MNN / OpenCL GPU** |
| `.gguf` or `.safetensors` file | sd-server, **CPU** |
| Core ML bundle directory (iOS) | Apple Core ML, **ANE / GPU** |

Directory detection recurses up to 3 levels, because the upstream model zips
nest inconsistently (`AbsoluteReality/unet.mnn` vs
`output_512/qnn_models_min/unet.bin`).

---

## How it works

### Android: inference engines as child processes

Both Android engines are **standalone ARM64 executables** that the module
spawns with `ProcessBuilder` and talks to over `127.0.0.1`:

```
JS  ──►  Kotlin module  ──►  ProcessBuilder  ──►  sd-server      :8087
                                              └►  local-dream    :18081
                          ◄── HTTP JSON (progress, PNG base64) ──┘
```

Running inference out-of-process buys real things: a native OOM or segfault
inside a diffusion model kills the child, not the app; multi-gigabyte
allocations live outside the JVM heap; and cancellation is a signal rather
than a cooperative flag.

It also means the module never has to link against ggml, MNN, or QNN at build
time. Any upstream binary that keeps its CLI stable can be swapped in without
touching Kotlin.

### Shipping an executable inside an Android app

Android will not execute a file from `assets/`, and since API 29 not from app
storage that was written by another process either. The workaround the module
uses is that **Android extracts anything matching `lib*.so` from
`lib/<abi>/` into `nativeLibraryDir` with the execute bit set** — regardless
of whether the file is actually a shared library.

So `sd-server` is renamed `libsd-server.so` and placed in
`jniLibs/arm64-v8a/`. It is an ELF *executable*, not a library, and nothing
ever calls `System.loadLibrary` on it.

That alone is not enough for Play Store installs. With an AAB, Play may serve
native libraries compressed inside a **split APK** without extracting them to
disk, in which case `nativeLibraryDir` is empty.
[`BinaryResolver.kt`](android/src/main/java/expo/modules/stablediffusion/BinaryResolver.kt)
handles the whole matrix:

1. `nativeLibraryDir` — the normal path, and free.
2. A previously extracted copy in `filesDir/native_bin`, reused only if it is
   newer than the APK (so an app update invalidates the cache).
3. Extract from the base APK, then from every entry in `splitSourceDirs` —
   this is the case that breaks on Play Store builds if you skip it.
4. Fall back to `assets/`, then `setExecutable(true)` and verify
   `canExecute()` before returning, so a failure surfaces here rather than as
   an opaque `ProcessBuilder` error later.

### Picking the right QNN kernels

Qualcomm NPU model packs are compiled per Hexagon generation, so the wrong
pack fails to load. `LocalDreamProcess.detectQnnVariant()` maps `Build.SOC_MODEL`
to one of three upstream pack suffixes (`8gen2` / `8gen1` / `min`), stripping
the AOSP-style `-AB` / `-AC` SKU suffix first.

Unlisted chips return `null` rather than a guess. NPU downloads then stay
hidden on that device instead of costing the user a 1.2 GB download that
cannot load.

### 16 KB page alignment

Android 15 devices can boot with 16 KB memory pages, and an ELF linked for
4 KB pages will not load. NDK r27 only applies 16 KB alignment to executables
when asked, so
[`scripts/Dockerfile.sd-server`](../../scripts/Dockerfile.sd-server) passes
`-Wl,-z,max-page-size=16384`, and `npm run check-16k` audits every shipped
`.so`.

### Sharing the DSP with an LLM

If your app also runs a language model on the Hexagon NPU, both subsystems
open FastRPC sessions to the same DSP and contend for a limited number of
unsigned PD slots — you get `QNNUNET exec failed`.

MicroGPT solves this above the module, in
[`lib/npu-coordinator.ts`](../../lib/npu-coordinator.ts): image generation
takes priority, the text model is evicted to GPU/CPU, and non-NPU loads on
either side are untouched. If you are combining on-device LLM and image
inference, you will need something like it.

### iOS: same contract, different engine

Neither Android engine ports — the iOS sandbox forbids spawning child
processes, and local-dream is Qualcomm-only. iOS uses Apple's
[`ml-stable-diffusion`](https://github.com/apple/ml-stable-diffusion) Swift
pipeline instead, vendored under
[`ios/vendor/StableDiffusion/`](ios/vendor/StableDiffusion/) so the build has
no SwiftPM dependency.

All of it sits behind `#if canImport(StableDiffusion)`. The module compiles
and loads either way: without the package, `hello()` returns
`"missing-binary"` and generation rejects with a clear message — mirroring
Android behaviour when a binary is absent. Deployment target is iOS 16.0; the
pipeline API is `@available(iOS 16.2, *)`.

---

## Using it in another Expo app

1. Copy `modules/expo-stable-diffusion/` into your project.
2. Point Expo autolinking at your modules directory, in `package.json`:

   ```json
   { "expo": { "autolinking": { "nativeModulesDir": "./modules" } } }
   ```

3. Set `minSdkVersion = 30` in `android/build.gradle`.
4. Supply the binaries (next section).
5. Rebuild the native app — `npx expo run:android`. This module cannot work in
   Expo Go.

For iOS, also add the config plugin at
[`plugins/withStableDiffusionIOS.js`](../../plugins/withStableDiffusionIOS.js),
which vendors the Core ML pipeline and raises the deployment target.

---

## Binaries you have to supply

None are committed. See the repository [CREDITS.md](../../CREDITS.md) for why.

| File | Source | Licence | How |
|---|---|---|---|
| `jniLibs/arm64-v8a/libsd-server.so` | [leejet/stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) | MIT | `npm run build:sd-server` (Docker) |
| `jniLibs/arm64-v8a/libstable_diffusion_core.so` | [xororz/local-dream](https://github.com/xororz/local-dream) | **CC BY-NC 4.0** | Extract from a release APK yourself |
| `assets/qnnlibs/*.so` | Qualcomm QNN runtime, via local-dream | **Proprietary** | Same APK |

Exact extraction commands: [`docs/UPDATING.md`](../../docs/UPDATING.md)
sections 2 and 4.

Only the first is needed for the module to do anything. Without the other two
the NPU and GPU paths report as unavailable and everything falls back to CPU.
**A build that includes them inherits the NonCommercial restriction and
Qualcomm's SDK terms** — that obligation is yours, not this repository's.

---

## Limits

- Android is **arm64-v8a only**. No armeabi-v7a, no x86_64, so no Android
  emulator.
- The GPU/NPU engines need a Snapdragon. Everything else gets the CPU path.
- Text-to-image only through the JS API. `local-dream` accepts a
  `--vae_encoder` for img2img and the module passes it when present, but no
  img2img entry point is exposed yet.
- One model at a time. `loadModel` on a different path stops the running
  engine first.
- `generate()` returns base64 PNG over the bridge. Fine at 512x512; if you
  push resolution far higher, write to a file instead.
- Progress granularity is whatever the underlying engine reports — one event
  per diffusion step, no sub-step interpolation.

## Licence

MIT, same as the rest of this repository — for the Kotlin, Swift and
TypeScript here. The vendored Apple pipeline is MIT with its own
`LICENSE.md`. The binaries above are not MIT and are not distributed here.
