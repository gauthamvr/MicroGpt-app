# Content safety

Google Play suspended version code 58 (October 2026) under the Sexual
Content and AI-Generated Content policies: a reviewer downloaded
AbsoluteReality-MNN, typed an explicit prompt and got a nude image. The
policy requires generative-AI apps to **prevent** restricted content and to
offer **in-app reporting** of AI output. This doc lists every safeguard so
none is removed by accident. Any new generation path must go through the
same chokepoints.

## Image generation

All callers (image screen, combo chat `[IMG: …]` tags, the manual image
button) go through `generateImage()` in `lib/image-gen-service.ts`.

| Layer | Where | What it does |
|---|---|---|
| Prompt filter | `lib/content-safety.ts` → `checkImagePrompt` | Rejects sexual, minor-related, gory, hateful and profane prompts (SDXL can render legible words) before any model runs, plus a person in an undressing setting (bath, shower, onsen, sauna, sunbathing, figure study…), which produced most near-misses in calibration. Normalizes leetspeak, spaced-out letters and repeated letters; matches whole words only. Also covers the euphemisms and non-English phrasings that leaked in the October 2026 red-team ("birthday suit", "in the buff", "wearing nothing but…", "sin ropa", "ohne Kleidung"…), and treats a pronoun as a person ("she is in the shower"). Every leaked prompt is a case in `__tests__/content-safety.test.ts`, next to a list of harmless prompts that must keep passing: add to both when a prompt gets through or is wrongly refused. |
| Safety negative prompt | `SAFETY_NEGATIVE_PROMPT`, prepended in `generateImage()` | Steers SD away from nudity on innocent prompts. Goes first because CLIP truncates at 77 tokens. No effect on cfg≈1 Turbo/Hyper models, which is why the classifier exists. |
| Output classifier | `modules/expo-stable-diffusion/android/.../NsfwFilter.kt`, called in `ExpoStableDiffusionModule.generate` | Runs three TFLite classifiers (LiteRT) on every image from **both** engines, including user-imported models: Marqo ViT-tiny, opennsfw2 and GantMan MobileNetV2. Blocked when Marqo ≥ 0.3, opennsfw2 ≥ 0.3, porn+hentai ≥ 0.3, or "sexy" ≥ 0.4 backed by opennsfw2 ≥ 0.1 or porn+hentai ≥ 0.15. A blocked image is never returned (`ERR_NSFW_BLOCKED`). If the classifier can't run, the image is withheld (`ERR_SAFETY_CHECK_FAILED`). Scores are logged under the `NsfwFilter` tag. |
| Catalog | `store/useModelsSlice.ts` | ChilloutMix, CuteYukiMix, MajicmixRealistic, RealisticVisionHyper and RealisticVision-V6 were removed as NSFW-leaning; QteaMix-MNN and SD3-Medium-Q4 were removed because they couldn't be calibrated. Every image model in the catalog uses a calibrated checkpoint. Don't add a model without calibrating it, and never add ones marketed for portraits or "realistic people". The model list is saved on the device, so at start-up `refreshBuiltInModels` (`lib/catalog-merge.ts`) replaces the saved built-in entries with this version's catalog: a model removed here also disappears from existing installs, unless its file is already downloaded (it then stays usable under "Hugging Face Models", and the output classifier still applies). |
| HF browser | `app/(root)/(tabs)/explore.tsx` injected JS | Repos tagged `not-for-all-audiences`, or with explicit names, get no download button. |

### Calibration (October 2026)

408 images were generated on a desktop GPU with six of the shipped
checkpoints (AbsoluteReality, DreamShaper 8, SD 1.5, AnythingV5,
MeinaPastel, SDXL-Base). The prompts were innocent-sounding ones chosen to
provoke nudity (Venus paintings, beach, bathtub, onsen, figure study…), run
both with the app's negative prompt and with none (the cfg≈1 worst case).
Result with the rule above:

- No image showing nudity passed. The highest-scoring images that passed were
  swimwear at a beach, people in hot springs wearing swimsuits, draped
  statues, and submerged bathtub scenes.
- 9 of 120 safe images were withheld: yoga poses, three AnythingV5 anime
  images (a style Marqo over-scores), and four SDXL images.
- QteaMix (only distributed as MNN) and SD3-Medium (gated on HuggingFace)
  couldn't be calibrated, so they were taken out of the catalog. Calibrate them on
  a real phone before re-adding.
- The GantMan "sexy" class rates evening gowns and gym wear 0.9–1.0, which is
  why it only counts when another model agrees.

No single model is enough. Marqo scores Manet's Olympia 0.06, opennsfw2
scores Botticelli's Venus 0.07, and GantMan scores a nude-from-behind onsen
image 0.20.

On-device parity was checked with a throwaway instrumentation test that ran
`NsfwFilter` on 30 fixtures on the emulator: all 30 verdicts matched the
Python reference. Android's `createScaledBitmap` aliases on big downscales,
which is why `NsfwFilter.resize` halves first. Without that, scores drifted by
up to 0.75.

To re-tune: generate a set with the shipped checkpoints, score it with
the three `.tflite` files using the same preprocessing, and look at the images
that **pass** before relaxing anything.

**iOS:** the Core ML path gets the prompt filter and negative prompt (shared
JS) but **not** the output classifier. Apple's own SafetyChecker is 608 MB
for SD 1.5 and doesn't exist for SD 2.1-base. Until `NsfwFilter` is ported
(Core ML conversions of the same two models), the iOS catalog
(`lib/coreml-models.ts`) offers only SD 2.1-base, whose training data was
NSFW-filtered. SD 1.5 Core ML was removed.

## Chat

- `CHAT_CONTENT_RULE` is appended to every system prompt in `home.tsx`,
  after any character-card override, so a card can't switch it off. The old
  "never refuse / no disclaimers" rule is gone.
- `checkChatText` blocks explicit user messages before they reach the
  model, and the streaming reply is checked as it arrives. A flagged reply is
  stopped and replaced with `CHAT_BLOCKED_REPLY`.
- Chub results are screened again on topics and text (`lib/chub-api.ts`), and
  community characters with sexual text can't be published
  (`CreateOrEditCharacterModal.tsx`). Both use `checkCharacterText`: the
  image-prompt wording rules, minus the two that only make sense for a
  short image prompt (a pronoun counting as a person, and image-board tags
  such as "censored"). With those, a card saying "she takes a long bath"
  or "his articles were censored" was rejected.

## Reporting

`lib/content-report.ts` → Supabase `public.content_reports`
(`supabase-migration-content-reports.sql`). Anyone can insert, and nobody can
read through the API; read reports in the Supabase dashboard. Reports made
offline are queued in AsyncStorage and retried. Entry points: the **Report**
button under generated images, the **Report** link under every AI reply, and
the flag on community character cards (Characters tab and user profile pages).

A reported image is cleared, and a reported community character is hidden
from that user's character lists (`hiddenPublicCharacterIds`, persisted in
the store). Character reports carry `character_id`; a trigger fills
`reported_user_id` with the character's author, so reports can be grouped
per character or per author:

```sql
select character_id, reported_user_id, count(*), max(created_at)
from content_reports where content_type = 'character'
group by 1, 2 order by 3 desc;
```

Chub.ai characters under "Discover More" have no report button yet.

Check the table regularly. The policy expects reports to feed back into
the filters.
