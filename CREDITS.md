# Credits and third-party licenses

MicroGPT's own source is MIT (see `LICENSE`). It stands on a lot of other
people's work. This file records what comes from where, under which licence,
and — importantly — **which pieces are not redistributed in this repository**
because their licence does not permit it.

---

## Bundled in this repository

| Component | Where | Licence | Notes |
|---|---|---|---|
| [apple/ml-stable-diffusion](https://github.com/apple/ml-stable-diffusion) | `modules/expo-stable-diffusion/ios/vendor/StableDiffusion/` | MIT | Swift Core ML pipeline, vendored so the iOS build has no SwiftPM dependency. Original `LICENSE.md` kept alongside it. |
| [llama.cpp / ggml Hexagon backend](https://github.com/ggml-org/llama.cpp) | `android/app/src/main/assets/ggml-hexagon/libggml-htp-v*.so` | MIT | Copied out of the `llama.rn` npm package (`node_modules/llama.rn/bin/arm64-v8a/`). |

## Pulled in as dependencies

| Component | Licence | Used for |
|---|---|---|
| [llama.rn](https://github.com/mybigday/llama.rn) | MIT | Local LLM inference (GGUF), OpenCL + Hexagon acceleration |
| [Expo](https://expo.dev) / React Native | MIT | App framework |
| [Supabase JS](https://github.com/supabase/supabase-js) | MIT | Auth, character sharing backend |

## Built locally — not redistributed here

| Component | Licence | How you get it |
|---|---|---|
| [leejet/stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) `sd-server` | MIT | Cross-compiled for `arm64-v8a` by `npm run build:sd-server` (Docker). Output lands at `modules/expo-stable-diffusion/android/src/main/jniLibs/arm64-v8a/libsd-server.so`. |

The binary is MIT and *could* legally be committed; it is kept out of git
purely to stop a 25 MB artefact from bloating every clone. The build recipe in
`scripts/Dockerfile.sd-server` is pinned to an exact upstream commit, so the
build is reproducible.

## Not redistributed — licence does not allow it

> **Read this before you publish anything derived from this repository.**

| Component | Licence | Why it is absent |
|---|---|---|
| [xororz/local-dream](https://github.com/xororz/local-dream) `libstable_diffusion_core.so` | **CC BY-NC 4.0** | NonCommercial. Redistributing the binary here would push that restriction onto everyone who clones this repo, including commercial users. |
| Qualcomm AI Engine Direct (QNN) runtime — `libQnnHtp*.so`, `libQnnSystem.so` | **Proprietary (Qualcomm)** | ~132 MB of Qualcomm's runtime, obtained by unpacking a local-dream release APK. Not ours to re-host. |

Both are only needed for the **GPU (MNN/OpenCL)** and **NPU (Hexagon/QNN)**
image-generation paths on Snapdragon devices. The app builds and runs without
them — those engines simply report as unavailable and image generation falls
back to the CPU `sd-server` path.

If you want those paths, fetch them yourself from an upstream local-dream
release APK on your own machine — step-by-step commands are in
[`docs/UPDATING.md`](docs/UPDATING.md) §2 and §4. Doing so makes **you**
responsible for complying with CC BY-NC 4.0 and Qualcomm's SDK terms in
whatever you ship.

## Model weights

No model weights are distributed with this app. Everything is downloaded at
runtime, by the user, from Hugging Face — and each model carries its own
licence (CreativeML OpenRAIL-M, Apache-2.0, Llama Community Licence, and so
on). Check the model card before using a model commercially.

Character content browsed through the in-app [Chub.ai](https://chub.ai)
integration belongs to its respective authors and is fetched on demand; none
of it is stored in this repository.
