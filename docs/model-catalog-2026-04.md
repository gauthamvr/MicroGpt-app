# MicroGPT Suggested-Models Catalog — April 2026

Research snapshot produced 2026-04-19. Every URL below was verified against
HuggingFace's model API at research time. Update before shipping to the
store.

## A. Text LLMs (GGUF) — ranked by size bucket

### Tiny (≤ 0.8 GB) — ultra-fast, low-end phones

| # | Model | GGUF (Unsloth repo + file) | Size | Ctx | Mobile/Quality/Stability/RP |
|---|---|---|---|---|---|
| 1 | Qwen3.5-0.8B Q4_K_M | `unsloth/Qwen3.5-0.8B-GGUF` → `Qwen3.5-0.8B-Q4_K_M.gguf` | ~500 MB | 256 K | 10 / 7 / 9 / 5 |
| 2 | Qwen3-0.6B Q4_K_M | `unsloth/Qwen3-0.6B-GGUF` → `Qwen3-0.6B-Q4_K_M.gguf` | ~484 MB | 32 K | 10 / 6 / 10 / 4 |
| 3 | Gemma-3-1B-it Q4_K_M | `unsloth/gemma-3-1b-it-GGUF` → `gemma-3-1b-it-Q4_K_M.gguf` | ~769 MB | 32 K | 9 / 7 / 10 / 5 |
| 4 | SmolLM3-3B UD-IQ2_M | `unsloth/SmolLM3-3B-GGUF` → `SmolLM3-3B-UD-IQ2_M.gguf` | ~790 MB | 128 K | 7 / 6 / 8 / 5 |

### Small (0.8–2.0 GB) — sweet spot for most Androids

| # | Model | GGUF | Size | Ctx | Scores |
|---|---|---|---|---|---|
| 1 | Qwen3.5-2B Q4_K_M | `unsloth/Qwen3.5-2B-GGUF` → `Qwen3.5-2B-Q4_K_M.gguf` (has `mmproj-F16.gguf`) | ~1.3 GB | 256 K | 9 / 9 / 9 / 6 |
| 2 | Qwen3-1.7B Q4_K_M | `unsloth/Qwen3-1.7B-GGUF` → `Qwen3-1.7B-Q4_K_M.gguf` | ~1.03 GB | 128 K | 9 / 8 / 10 / 5 |
| 3 | SmolLM3-3B Q4_K_M | `unsloth/SmolLM3-3B-GGUF` → `SmolLM3-3B-Q4_K_M.gguf` | ~1.78 GB | 128 K | 7 / 8 / 8 / 5 |
| 4 | DeepSeek-R1-Distill-Qwen-1.5B Q8_0 | `unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF` → `DeepSeek-R1-Distill-Qwen-1.5B-Q8_0.gguf` | ~1.89 GB | 32 K | 8 / 8 / 9 / 4 (leaks `<think>` — bad for RP) |
| 5 | Ministral-3-3B Instruct IQ3_XXS | `unsloth/Ministral-3-3B-Instruct-2512-GGUF` → `Ministral-3-3B-Instruct-2512-IQ3_XXS.gguf` (also has mmproj) | ~0.9 GB | 32 K+ | 7 / 6 / 8 / 6 |

### Mid (2.0–4.5 GB) — flagships, ≥ 8 GB RAM

| # | Model | GGUF | Size | Ctx | Scores |
|---|---|---|---|---|---|
| 1 | Qwen3.5-4B Q4_K_M | `unsloth/Qwen3.5-4B-GGUF` (has `mmproj-F16.gguf`) | ~2.5 GB | 256 K | 7 / 9 / 9 / 7 |
| 2 | Ministral-3-3B Q4_K_M | `unsloth/Ministral-3-3B-Instruct-2512-GGUF` | ~2.0 GB | 32 K+ | 8 / 8 / 9 / 7 |
| 3 | Gemma-3-4B-it Q4_K_M | `unsloth/gemma-3-4b-it-GGUF` (has mmproj) | ~2.8 GB | 128 K | 7 / 8 / 10 / 6 |
| 4 | Gemma-4-E2B-it Q4_K_M | `unsloth/gemma-4-E2B-it-GGUF` (has mmproj) | ~2.5 GB | 128 K | 7 / 9 / 7 / 6 |
| 5 | Phi-4-mini-instruct Q4_K_M | `unsloth/Phi-4-mini-instruct-GGUF` | ~2.4 GB | 128 K | 7 / 8 / 9 / 3 |

### Large (4.5–8 GB) — high-end flagships, 12 GB+ RAM only

| # | Model | GGUF | Size | Ctx | Notes |
|---|---|---|---|---|---|
| 1 | Gemma-4-E4B-it Q4_K_M | `unsloth/gemma-4-E4B-it-GGUF` (has mmproj ~990 MB) | ~4–5 GB | 128 K | Google's top on-device multimodal |
| 2 | Qwen3.5-9B Q4_K_M | `unsloth/Qwen3.5-9B-GGUF` | ~5.5 GB | 256 K | Desktop-class quality; needs 16 GB RAM |
| 3 | MiniCPM-V-4.5 Q4_K_M | `openbmb/MiniCPM-V-4_5-gguf` (+ `mmproj-model-f16.gguf` ~1.1 GB) | ~6.1 GB total | 32 K+ | GPT-4o-class vision; video-native |
| 4 | Ministral-3-8B Q4_K_M | `unsloth/Ministral-3-8B-Instruct-2512-GGUF` | ~4.9 GB | 128 K | Agentic + function-calling |

## B. Vision-capable LLMs (GGUF + mmproj)

| # | Main GGUF | mmproj | Total | Ctx | Notes |
|---|---|---|---|---|---|
| 1 | `unsloth/Qwen3-VL-2B-Instruct-GGUF` → `Qwen3-VL-2B-Instruct-Q4_K_M.gguf` | `mmproj-F16.gguf` (~0.78 GB) | ~1.8 GB | 262 K | Best tiny VLM in 2026 |
| 2 | `unsloth/Qwen3-VL-4B-Instruct-GGUF` → `Qwen3-VL-4B-Instruct-Q4_K_M.gguf` | `mmproj-Qwen3VL-4B-Instruct-F16.gguf` | ~3.3 GB | 262 K | Best mid-tier VLM |
| 3 | `unsloth/gemma-4-E2B-it-GGUF` | `mmproj-F16.gguf` (~986 MB) | ~2.5–3.5 GB | 128 K | Already in catalog; keep |
| 4 | `unsloth/gemma-4-E4B-it-GGUF` | `mmproj-F16.gguf` (~990 MB) | ~5 GB | 128 K | Image + video + audio |
| 5 | `openbmb/MiniCPM-V-4_5-gguf` | `mmproj-model-f16.gguf` | ~6.1 GB | 32 K | 12 GB+ flagships only |

Drop candidates: SmolVLM2-2.2B (outclassed by Qwen3-VL-2B). Keep SmolVLM-256M as "ultra-small vision" fallback.

## C. Image-gen models for Android

### C1. MNN (Adreno GPU via OpenCL) — `xororz/sd-mnn`

AbsoluteReality, AnythingV5, ChilloutMix, CuteYukiMix, QteaMix — all 5 already in catalog. ~1.1 GB each, 512×512, 20–25 steps, ~15–30 s on Adreno 740/750.

### C2. QNN / NPU — `xororz/sd-qnn`

**Action required:** the current catalog pins `*_qnn2.28_min.zip` for all devices. `_min` is the non-flagship build and wastes Hexagon 790/800 capability. On Snapdragon 8 Gen 2+ (SOC_MODEL SM8550 and newer), switch to `*_qnn2.28_8gen2.zip` files.

Top 5 NPU picks (all `_8gen2` for flagships, `_min` for older QNN devices):

| # | Model | `_8gen2` URL | Size |
|---|---|---|---|
| 1 | RealisticVisionHyper | `xororz/sd-qnn/resolve/main/RealisticVisionHyper_qnn2.28_8gen2.zip` | ~1.0 GB |
| 2 | DreamShaperV8 | `xororz/sd-qnn/resolve/main/DreamShaperV8_qnn2.28_8gen2.zip` | ~1.0 GB |
| 3 | AbsoluteReality | `xororz/sd-qnn/resolve/main/AbsoluteReality_qnn2.28_8gen2.zip` | ~0.95 GB |
| 4 | AnythingV5 | `xororz/sd-qnn/resolve/main/AnythingV5_qnn2.28_8gen2.zip` | ~1.0 GB |
| 5 | MajicmixRealisticV7 | `xororz/sd-qnn/resolve/main/MajicmixRealisticV7_qnn2.28_8gen2.zip` | ~1.0 GB |

5–15 s per 512×512 image on 8 Gen 3+.

### C3. CPU (sd.cpp via expo-stable-diffusion)

| # | Model | URL | Size |
|---|---|---|---|
| 1 | SD-1.5 Q4_0 | `second-state/stable-diffusion-v1-5-GGUF` → `stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf` | ~1.57 GB |
| 2 | SD-1.5 Q8_0 | same repo → `stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf` | ~1.76 GB |
| 3 | DreamShaper-8 | `Lykon/DreamShaper` → `DreamShaper_8_pruned.safetensors` | ~2.0 GB |
| 4 | Realistic Vision V6 Hyper | `second-state/Realistic_Vision_V6.0_B1-GGUF` → `realisticVisionV60B1_v51HyperVAE-Q4_0.gguf` | ~1.57 GB |
| 5 | MeinaPastel | `Meina/MeinaMix` → `MeinaPastel - baked VAE.safetensors` | ~2.0 GB |

Optional larger/slower adds: `second-state/stable-diffusion-3-medium-GGUF`, `gpustack/FLUX.1-lite-GGUF` (advanced-only gated).

## D. Notes for the maintainer

### What's new in 2026 vs older catalogs (Llama-3.2-1B / Qwen2.5-1.5B era)

- **Qwen3.5 family (Feb 2026)** is the go-to Chinese open-weight series; sizes 0.8B, 2B, 4B, 9B all ship with `mmproj-F16.gguf` in Unsloth repos.
- **Gemma-4 (Apr 2026)**: E2B / E4B supersede Gemma-3n on device. If you keep the `Gemma-3n-E2B-it-GGUF` entry, drop the vision label — llama.cpp treats those text-only.
- **Qwen3-VL-2B / 4B Instruct** are the best open small VLMs in 2026. Unsloth's UD (Unsloth Dynamic 2.0) quants beat stock at Q2/Q3.
- **Ministral-3 (Dec 2025, "2512")**: first Mistral phone-targeted lineup with vision via mmproj; strong on function calling.
- **MiniCPM-V-4.5** is the open top-of-class VLM at 8B; video-native.
- **DeepSeek-R1-Distill-Qwen-1.5B** still the best sub-2 GB visible-CoT model, but don't use for RP.
- **Qwen3.6-35B-A3B** MoE: skip, too large for phones.
- **Llama 4 Scout-17B**: MoE, skip.

### Deprecated / warn users away

- `TheBloke/*` repos (stale since 2024, no UD quants, template drift).
- `openbmb/MiniCPM-V-2_6-gguf` — superseded by V-4.5.
- Old Gemma-2 GGUFs.
- Gemma-3n with a vision label.

### Snapdragon image-gen specifics

1. Stop pinning `_min` on flagships — use `_8gen2` for `SOC_MODEL SM8550`/`SM8650`/`SM8750`/`SM8850` (8 Gen 2 → 8 Elite Gen 5). Keep `_min` only for older QNN-capable chips (SM8350/SM8450) and skip QNN entirely on non-Qualcomm.
2. local-dream April 2026 bundles QNN 2.39; existing `qnn2.28` model zips are forward-compatible.
3. 8 Elite Gen 5 can do SDXL-Lightning 1024 px on NPU, but no public QNN conversion is published yet (still SD 1.5 only in `xororz/sd-qnn`). Feature-flag for later.
4. Prefer Hyper/Lightning distills in the catalog (RealisticVisionHyper, HyperSpireV5) — 4–6 steps vs 20–25.

### Concrete catalog changes (landing point: `store/useModelsSlice.ts`, `DEFAULT_BUILTIN_MODELS` array)

Add:
- Qwen3-VL-4B-Instruct (Mid, vision)
- Qwen3.5-2B (Small, best of bucket)
- MiniCPM-V-4.5 (Large, gated on RAM ≥ 12 GB)
- Swap NPU URLs from `_min` to `_8gen2` on flagships
- Optional: `TheDrummer/Gemmasutra-Mini-2B-v1-GGUF` as opt-in roleplay model (content policy; not default)

Remove / warn:
- Gemma-3n-E2B-it-GGUF vision label → text-only
- SmolVLM-256M keep only as "ultra-small vision" fallback
