# Updating Model Engines and Packages

Practical playbook for updating the things that actually move on this app:
the LLM runtime (llama.rn), the two image-gen engines, the QNN libs, and
the Expo SDK packages. Captures the gotchas we've hit so future sessions
don't have to rediscover them.

> **Building for iOS?** See [`docs/IOS.md`](IOS.md). iOS uses EAS prebuild
> (CNG) — the `ios/` folder is generated on EAS's macOS builder, never
> committed, and the engine sections below (local-dream, sd-server, QNN)
> are **Android-only**. iOS image generation uses Apple Core ML instead.

Each procedure has: **how to update**, **how to verify**, **how to roll
back**. Commit at each stage so a single bad upgrade can be undone with
one `git reset --hard <hash>`.

---

## 1. llama.rn (text model runtime)

Source: <https://github.com/mybigday/llama.rn>. Latest is set in
`package.json` as `llama.rn`.

### Update

1. Check upstream releases:
   ```powershell
   gh api repos/mybigday/llama.rn/releases?per_page=5 --jq '.[] | "\(.tag_name) \(.published_at) \(.body | split(\"\n\")[0])"'
   ```
2. Bump the version in `package.json` (use `~0.X.Y` style for prerelease
   ranges that DON'T cross prerelease boundaries; use `^0.X.Y` for
   stable).
3. Reinstall — see the **Windows install dance** below.

### Windows install dance (mandatory)

llama.rn rc.6+ ships a postinstall that downloads JNI prebuilts and
extracts them with GNU `tar`. On Windows, Git-Bash GNU tar mis-parses
`C:\...` paths as `host:path` and fails. We've patched llama.rn's
extract script to use the system bsdtar (`C:\Windows\System32\tar.exe`)
via `patches/llama.rn+0.X.Y-rc.Z.patch`.

So the install flow is:

```powershell
# Either of these works:
npm run install:windows
# OR explicitly:
npm install --ignore-scripts && npm run setup-native
```

Plain `npm install` will fail at llama.rn's postinstall because npm
runs the package's own postinstall BEFORE our project-level
patch-package can fix it. The `--ignore-scripts` step skips both,
then `setup-native` (=`patch-package && node node_modules/llama.rn/install/download-native-artifacts.js`)
applies the patch and runs the now-fixed download.

**Important: do not use `--legacy-peer-deps`.** That produces a
lockfile EAS rejects with `npm ci`-must-be-in-sync errors (eslint
peer deps get skipped). We saw this on EAS build `2026-05-02` —
fixed by regenerating the lockfile without the flag.

EAS / Linux build runs plain `npm install`; the patch is a no-op on
Linux (only the `process.platform === 'win32'` branch differs).

### When the patch needs regenerating

If the llama.rn version changes, the patch filename has to track
the new version. The old patch will silently skip if the filename
doesn't match. Procedure:

1. After a clean install (`npm install --ignore-scripts`),
   manually re-apply the bsdtar fix to
   `node_modules/llama.rn/install/download-native-artifacts.js` —
   replace the `spawnSync('tar', ...)` call with the
   `process.env.SystemRoot`-based version (see the existing patch
   for the exact diff).
2. Run `npx patch-package llama.rn` — but it'll create an 800-KB
   patch full of binary noise from comparing against an unbuilt
   fresh install. Instead: write the patch by hand. See the existing
   `patches/llama.rn+0.12.0-rc.9.patch` for the template — it's
   ~15 lines.
3. Rename it to `patches/llama.rn+<new-version>.patch`.
4. Verify: `npx patch-package` should print `llama.rn@<new-version> ✔`.
5. Run `npm run setup-native` to confirm the artifact download works.

### Verify

- `npx tsc --noEmit -p tsconfig.json` exits 0.
- `node -e "console.log(require('./node_modules/llama.rn/package.json').version)"` matches package.json.
- `ls node_modules/llama.rn/android/src/main/jniLibs/arm64-v8a/` shows
  `librnllama.so` plus the v8 / dotprod / hexagon variants.
- `npm run check-16k` shows them all 16K-aligned.

### Rollback

```powershell
git reset --hard <prev_commit>
npm run install:windows
```

---

## 2. local-dream binary (image gen via Adreno OpenCL or Hexagon NPU)

Source: <https://github.com/xororz/local-dream>. Distributed as APK
only — extract the `.so` from a release APK.

### Update

1. Find the latest release:
   ```powershell
   gh api repos/xororz/local-dream/releases --jq '.[0]'
   ```
2. Download the APK to a temp dir:
   ```powershell
   gh release download <tag> --repo xororz/local-dream --pattern "LocalDream_armv8a_*.apk" -D /tmp/ld
   ```
3. Extract:
   ```powershell
   unzip -q /tmp/ld/LocalDream_armv8a_*.apk -d /tmp/ld/extract
   ```
4. **Verify CLI compatibility** — our `LocalDreamProcess.kt` invokes
   the binary with specific flags. Confirm they all still exist:
   ```powershell
   for arg in clip unet vae_decoder vae_encoder tokenizer port text_embedding_size backend system_library use_cpu_clip cpu; do
     grep -aoE "$arg" /tmp/ld/extract/lib/arm64-v8a/libstable_diffusion_core.so > /dev/null && echo "$arg: OK" || echo "$arg: MISSING"
   done
   ```
   If any go missing, the upstream binary CLI changed — update
   `LocalDreamProcess.kt:218-247` to match before swapping the
   binary in.
5. Swap in:
   ```powershell
   cp /tmp/ld/extract/lib/arm64-v8a/libstable_diffusion_core.so \
      modules/expo-stable-diffusion/android/src/main/jniLibs/arm64-v8a/libstable_diffusion_core.so
   ```

### Verify

- `npm run check-16k` — should report aligned (recent xororz builds use NDK r27+).
- Smoke-test on device: load an NPU model in combo mode → generate.

### Rollback

```powershell
git checkout <prev_commit> -- modules/expo-stable-diffusion/android/src/main/jniLibs/arm64-v8a/libstable_diffusion_core.so
```

---

## 3. sd-server binary (image gen via CPU + sd.cpp)

Source: <https://github.com/leejet/stable-diffusion.cpp>. NOT distributed
as a prebuilt — we cross-compile from source via Docker.

The original Apr 2026 build was ad-hoc and lost. The current Dockerfile
in `scripts/Dockerfile.sd-server` was reconstructed from inspecting the
preserved `sd-opencl-builder:latest` image with `docker history`.

### Update

```powershell
# Make sure Docker Desktop is running
# Edit scripts/Dockerfile.sd-server and bump:
#   ARG SD_CPP_COMMIT=<new-commit-sha>
# Pin to a known-good leejet/stable-diffusion.cpp commit.

npm run build:sd-server
```

This builds the Docker image (~10-20 min cold, much faster on rebuild
because of layer cache), runs it, copies the binary into jniLibs, and
runs `check-16k`.

### Build flags worth knowing

The Dockerfile pins these because the original recipe used them:

| Flag | Why |
|---|---|
| `-DGGML_OPENMP=OFF` | Android NDK has no OpenMP — must be off |
| `-DGGML_VULKAN=OFF` | We use OpenCL, not Vulkan |
| `-DGGML_OPENCL=ON` | The whole point |
| `-DGGML_OPENCL_TARGET_VERSION=200` | Adreno targets OpenCL 2.0 |
| `-DGGML_BACKEND_DL=OFF` | No dynamic backend loading on mobile |
| `-DBUILD_SHARED_LIBS=OFF` | Static link sd.cpp libs into the executable |
| `-DSD_BUILD_EXAMPLES=ON` | This is what builds the `sd-server` target |
| `-DANDROID_PLATFORM=android-30` | Matches the app's `minSdk` |
| `-DCMAKE_EXE_LINKER_FLAGS="-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"` | 16-KB page alignment for executables — NDK r27 needs this explicitly (r28+ does it by default) |

### Verify

- Output file `modules/expo-stable-diffusion/android/src/main/jniLibs/arm64-v8a/libsd-server.so`.
- `npm run check-16k` — must report `libsd-server.so` aligned.
- CLI compatibility check (same script as local-dream above, against
  `libsd-server.so`):
  ```powershell
  for arg in model listen-port listen-ip vae-tiling clip-on-cpu vae-on-cpu; do
    grep -aoE "$arg" modules/expo-stable-diffusion/android/src/main/jniLibs/arm64-v8a/libsd-server.so > /dev/null && echo "$arg: OK" || echo "$arg: MISSING"
  done
  ```
- Smoke-test on device: load a GGUF/safetensors SD model → generate.

### Rollback

```powershell
git checkout <prev_commit> -- modules/expo-stable-diffusion/android/src/main/jniLibs/arm64-v8a/libsd-server.so
```

---

## 4. QNN runtime libraries (Hexagon NPU support files)

Source: ship with `xororz/local-dream` APKs (see §2). We bundle them
under `modules/expo-stable-diffusion/android/src/main/assets/qnnlibs/`.

QNN libs are byte-identical between local-dream releases unless
xororz bumps their bundled QNN SDK. As of v2.4.3 (Apr 2026), still
the same set: `libQnnHtp.so`, `libQnnHtpV68..V81.so` (+ Stub + Skel),
`libQnnSystem.so`.

### Update

When updating local-dream binary (§2), also compare the assets:

```powershell
# After extracting an APK to /tmp/ld/extract:
for f in /tmp/ld/extract/assets/qnnlibs/*.so; do
  name=$(basename "$f")
  newsz=$(stat -c%s "$f")
  oldsz=$(stat -c%s "modules/expo-stable-diffusion/android/src/main/assets/qnnlibs/$name" 2>/dev/null || echo 0)
  if [ "$newsz" != "$oldsz" ]; then echo "DIFF $name: new=$newsz old=$oldsz"; fi
done
```

If anything diffs, copy the changed files in:

```powershell
cp /tmp/ld/extract/assets/qnnlibs/*.so modules/expo-stable-diffusion/android/src/main/assets/qnnlibs/
```

### Verify

- `npm run check-16k` — note the `libQnnHtpV*.so` and `libQnnHtpV*Skel.so`
  files report as "32-bit ELF" — that's expected. Those are Hexagon DSP
  binaries that run on the DSP, not the Android CPU. 16K page alignment
  doesn't apply.

### Rollback

`git checkout <prev_commit> -- modules/expo-stable-diffusion/android/src/main/assets/qnnlibs/`

---

## 5. Expo SDK packages

### Update

```powershell
# Stay on the same SDK major (currently 55). Pull patch updates:
npx expo install --check       # see what's behind
npx expo install --fix         # bump to expected versions
```

`--fix` may crash at the very end with `Cannot find module .../expo/bin/cli`
— that's a known issue when expo tries to invoke its own postinstall
plugin pipeline. The `package.json` updates have already been written
by that point. Recover with:

```powershell
npm install --ignore-scripts
npx patch-package           # reapply our llama.rn patch
npm run setup-native        # re-fetch llama.rn JNI prebuilts
```

### Major SDK upgrade (e.g. 55 → 56)

Don't do silently. Major Expo SDK upgrades touch native code — read
the migration guide at <https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/>,
then bump in a dedicated commit.

### Verify

- `npx tsc --noEmit -p tsconfig.json` exits 0.
- `npx expo install --check` reports nothing outdated.
- Smoke test on device.

### Rollback

```powershell
git checkout <prev_commit> -- package.json package-lock.json
npm run install:windows
```

---

## 6. EAS build prerequisites

EAS runs `npm ci --include=dev` on a Linux builder. For that to work:

1. **Lockfile must be in sync with package.json.** If `npm ci` complains
   about missing peer deps (typically `eslint@10.x`), regenerate the
   lockfile with `npm install --ignore-scripts` (NOT `--legacy-peer-deps`)
   and commit.
2. **Patches must apply cleanly.** EAS will run our `postinstall: patch-package`.
   If a patch fails to apply on a future llama.rn version, EAS fails
   immediately. Fix the patch (see §1) before pushing.
3. **No credentials in the repo.** EAS picks up `EXPO_PUBLIC_*` vars
   from EAS Secrets — see `app.config.js` for the validation list.

---

## 7. Native libraries audit

Whenever any `.so` file is updated, run:

```powershell
npm run check-16k
```

This audits every shipped library for Android 16-KB-page compatibility
(per <https://developer.android.com/guide/practices/page-sizes>). Exits
non-zero if anything's misaligned.

Currently expected:
- All llama.rn JNI libs (rc.9): aligned.
- local-dream `libstable_diffusion_core.so` (v2.4.3): aligned.
- `libsd-server.so` (rebuilt via §3): aligned (the `-Wl,-z,max-page-size=16384`
  flag in the Dockerfile is what makes this work for NDK r27).
- QNN system libs: aligned. QNN HtpV*.so + Skel: 32-bit DSP, N/A.

---

## 8. Rollback strategy

Every meaningful change goes in its own commit. To undo just one
update without losing other progress:

```powershell
git log --oneline -20                # find the commit hash
git revert <hash>                    # creates a new commit undoing it
# OR if no one else has pulled and you just want it gone:
git reset --hard <hash-before-it>
```

Avoid `git reset --hard` if the affected commit has been pushed to a
shared branch.

---

## 9. Native rebuild after any model-engine change

After updating llama.rn, local-dream, sd-server, or QNN libs, the
Android build must be rebuilt from scratch to pick up the new natives:

```powershell
cd android
.\gradlew clean
cd ..
npx expo run:android --device
```

For Play Store releases, `eas build --platform android --profile production`
does this automatically.

---

## Quick reference: which files belong to what

| Concern | Files |
|---|---|
| Text inference (llama.rn) | `node_modules/llama.rn/android/src/main/jniLibs/arm64-v8a/*.so` (managed by npm + patch-package) |
| Image inference NPU/GPU | `modules/expo-stable-diffusion/android/src/main/jniLibs/arm64-v8a/libstable_diffusion_core.so` |
| Image inference CPU | `modules/expo-stable-diffusion/android/src/main/jniLibs/arm64-v8a/libsd-server.so` |
| Hexagon DSP runtime | `modules/expo-stable-diffusion/android/src/main/assets/qnnlibs/*.so` |
| Patches | `patches/*.patch` |
| Build infra | `scripts/Dockerfile.sd-server`, `scripts/build-sd-server.sh`, `scripts/check-16k-alignment.js` |
| npm orchestration | `package.json` scripts: `install:windows`, `setup-native`, `check-16k`, `build:sd-server` |
