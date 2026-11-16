// app/(root)/components/HuggingfaceDownloadModel.tsx
import React, { useMemo, useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  FlatList,
  useColorScheme,
  Platform,
} from 'react-native';
import { themedAlert } from '@/components/ThemedAlert';
import { Ionicons } from '@expo/vector-icons';
import { useStore, detectImageGenFromFilename } from '@/store';
import { repoFromHfUrl } from '@/lib/hf-url';

/**
 * Per-row progress subscribed to just this model's `downloadProgress`
 * slot. Keeping the subscription inside a memoized child prevents the
 * rest of the modal (header, search, other rows) from re-rendering on
 * every 500 ms progress tick.
 */
const HfProgressBar = React.memo(function HfProgressBar({
  modelName,
}: {
  modelName: string;
}) {
  const colorScheme = useColorScheme();
  const raw = useStore((s) => s.downloadProgress?.[modelName] ?? 0);
  const indeterminate = raw < 0;
  const fraction = indeterminate ? 0 : Math.max(0, Math.min(1, raw));
  const pct = indeterminate ? '' : `${Math.round(fraction * 100)}%`;
  const barBg = colorScheme === 'dark' ? '#2A2A2A' : '#E6E6E6';
  const barFill = colorScheme === 'dark' ? '#3B82F6' : '#2563EB';
  const subColor = colorScheme === 'dark' ? '#9BA1A6' : '#666666';
  return (
    <View style={{ marginTop: 6 }}>
      <View
        style={{
          height: 4,
          backgroundColor: barBg,
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            height: '100%',
            width: indeterminate ? '35%' : `${Math.round(fraction * 100)}%`,
            backgroundColor: barFill,
            opacity: indeterminate ? 0.55 : 1,
          }}
        />
      </View>
      <Text style={{ fontSize: 11, marginTop: 2, color: subColor }}>
        {indeterminate ? 'Downloading in background\u2026' : pct}
      </Text>
    </View>
  );
});

/**
 * Type describing each .gguf item from WebView
 */
type GgufItem = {
  href: string; // e.g. "https://huggingface.co/.../myModel.gguf?download=true"
  fileName: string; // e.g. "Llama-3.2-1B-Instruct-Q4_K_M.gguf"
  fileSize: string; // e.g. "808 MB", "2.48 GB"
  /** Model type detected from filename/repo: text, vision, gpu, npu, imagegen-cpu */
  fileType?: string;
  /** Set on rows that stand in for a multi-part (gguf-split) set — the
   *  number of `-0000X-of-0000N.gguf` files collapsed into this row. */
  splitTotal?: number;
};

/** Convert "2.48 GB" => number of bytes */
function parseFileSizeString(sizeString: string): number {
  const match = sizeString.match(/([\d\.]+)\s*(GB|MB|KB)/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === 'GB') return value * 1024 * 1024 * 1024;
  if (unit === 'MB') return value * 1024 * 1024;
  if (unit === 'KB') return value * 1024;
  return 0;
}

/**
 * Name a listed file is stored under. MNN and QNN bundles get the same
 * `-MNN` / `-NPU` suffix as the built-in catalog. The rest of the app keys
 * on it (an NPU model is locked to 512×512 and takes the Hexagon DSP over
 * from the chat model), and without it the two bundles of one model would
 * unpack into the same folder.
 */
function modelNameFor(item: GgufItem): string {
  const base = item.fileName.replace(/\.(gguf|safetensors|ckpt|zip)$/i, '');
  if (item.fileType === 'npu') return `${base}-NPU`;
  if (item.fileType === 'gpu') return `${base}-MNN`;
  return base;
}

/**
 * Matches one part of a gguf-split model, e.g. "model-00001-of-00003.gguf".
 * HuggingFace ships quants this large (typically 45 GB+ per set) only for
 * models far beyond phone hardware; llama.cpp needs EVERY part present to
 * load one. Group 1 = base name, 2 = part index, 3 = total parts.
 */
const SPLIT_PART_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

function parseSplitPart(
  fileName: string,
): { base: string; index: number; total: number } | null {
  const m = SPLIT_PART_RE.exec(fileName);
  if (!m) return null;
  return { base: m[1], index: parseInt(m[2], 10), total: parseInt(m[3], 10) };
}

/** Check if a filename is a multimodal projector (vision support file) */
function isMMProjFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith('.gguf')) return false;
  return (
    lower.includes('mmproj') ||
    lower.includes('projector') ||
    (lower.includes('clip') && lower.includes('vit'))
  );
}

/**
 * QNN zip variant extraction. Filenames on xororz/sd-qnn look like
 *   RealisticVisionHyper_qnn2.28_min.zip
 *   RealisticVisionHyper_qnn2.28_8gen1.zip
 *   RealisticVisionHyper_qnn2.28_8gen2.zip
 * Returns the base model name and the chip-tier suffix, or null if
 * the filename doesn't fit the QNN naming convention.
 */
function parseQnnVariant(fileName: string): { base: string; variant: 'min' | '8gen1' | '8gen2' } | null {
  const m = fileName.match(/^(.+)_qnn\d+\.\d+_(min|8gen1|8gen2)\.zip$/i);
  if (!m) return null;
  const variant = m[2].toLowerCase() as 'min' | '8gen1' | '8gen2';
  return { base: m[1], variant };
}

/** Pick the best QNN variant filename for the detected chip tier. */
function pickQnnVariantForDevice(
  siblings: GgufItem[],
  deviceVariant: 'min' | '8gen1' | '8gen2' | null,
): GgufItem {
  // Fallback order: prefer the device's tier, then drop to the next best
  // that actually ships. 8gen2 device can run _8gen1 and _min as well,
  // but quality drops; 8gen1 device can only run _8gen1 or _min;
  // _min always works.
  const byVariant = new Map<string, GgufItem>();
  for (const s of siblings) {
    const v = parseQnnVariant(s.fileName);
    if (v) byVariant.set(v.variant, s);
  }
  const order: Array<'8gen2' | '8gen1' | 'min'> =
    deviceVariant === '8gen2' ? ['8gen2', '8gen1', 'min'] :
    deviceVariant === '8gen1' ? ['8gen1', 'min'] :
    ['min'];
  for (const v of order) {
    const hit = byVariant.get(v);
    if (hit) return hit;
  }
  return siblings[0];
}

/**
 * Sort + shape the raw scraped items into a list the modal can render.
 * Three jobs:
 *  1. Hide mmproj siblings (they're bundled into the main GGUF download).
 *  2. Collapse QNN chip-tier triplets (min / 8gen1 / 8gen2 of the same
 *     base model) into a single row that picks the right variant at
 *     download time for the detected SoC.
 *  3. Hide NPU rows entirely when the device has no QNN support — the
 *     engine would refuse to load them anyway.
 *  4. Downloaded rows first, then undownloaded.
 */
function sortGgufItems(
  ggufItems: GgufItem[],
  downloadedModels: string[],
  npuSupported: boolean,
  qnnVariant: 'min' | '8gen1' | '8gen2' | null,
) {
  // (a) drop mmproj siblings
  let modelFiles = ggufItems.filter((i) => !isMMProjFile(i.fileName));
  // (a2) collapse multi-part (gguf-split) sets into one row per set.
  // Without this, each part lists as its own downloadable file and a
  // user who grabs just one gets a truncated model that can't load.
  // The collapsed row shows the set's combined size; handleDownload
  // explains why these can't be used on a phone.
  const splitGroups = new Map<string, GgufItem[]>();
  const nonSplit: GgufItem[] = [];
  for (const item of modelFiles) {
    const sp = parseSplitPart(item.fileName);
    if (!sp) { nonSplit.push(item); continue; }
    const key = `${sp.base}-of-${sp.total}`;
    const arr = splitGroups.get(key) ?? [];
    arr.push(item);
    splitGroups.set(key, arr);
  }
  const collapsedSplit: GgufItem[] = [];
  for (const siblings of splitGroups.values()) {
    const first = siblings.find((s) => parseSplitPart(s.fileName)?.index === 1) ?? siblings[0];
    const sp = parseSplitPart(first.fileName)!;
    const totalBytes = siblings.reduce((sum, s) => sum + parseFileSizeString(s.fileSize || ''), 0);
    collapsedSplit.push({
      ...first,
      fileName: `${sp.base}.gguf`,
      fileSize: totalBytes > 0 ? `${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB` : first.fileSize,
      splitTotal: sp.total,
    });
  }
  modelFiles = [...nonSplit, ...collapsedSplit];
  // (b) collapse QNN variants
  const qnnGroups = new Map<string, GgufItem[]>();
  const nonQnn: GgufItem[] = [];
  for (const item of modelFiles) {
    if (item.fileType !== 'npu') { nonQnn.push(item); continue; }
    const parsed = parseQnnVariant(item.fileName);
    if (!parsed) { nonQnn.push(item); continue; }
    const arr = qnnGroups.get(parsed.base) ?? [];
    arr.push(item);
    qnnGroups.set(parsed.base, arr);
  }
  const collapsedQnn: GgufItem[] = [];
  for (const [base, siblings] of qnnGroups) {
    const pick = pickQnnVariantForDevice(siblings, qnnVariant);
    // Re-label the row with the base name so users see one clean entry
    // rather than "..._qnn2.28_8gen2". The actual URL still points at
    // the right variant.
    collapsedQnn.push({
      ...pick,
      fileName: `${base}.zip`,
      fileSize: pick.fileSize,
    });
  }
  modelFiles = [...nonQnn, ...collapsedQnn];
  // (c) filter NPU rows on unsupported devices
  if (!npuSupported) {
    modelFiles = modelFiles.filter((i) => i.fileType !== 'npu');
  }
  // (d) downloaded first
  const downloaded = modelFiles.filter((i) => {
    const baseName = modelNameFor(i);
    return downloadedModels.includes(i.fileName) || downloadedModels.includes(baseName);
  });
  const notDownloaded = modelFiles.filter((i) => {
    const baseName = modelNameFor(i);
    return !downloadedModels.includes(i.fileName) && !downloadedModels.includes(baseName);
  });
  return [...downloaded, ...notDownloaded];
}

/**
 * Find the best mmproj for a specific main-weight filename. Prefer a
 * projector whose filename references the same base name as the tapped
 * weight (repos that ship 2B + 4B side by side have separate projectors
 * named mmproj-Qwen3VL-2B-F16 / mmproj-Qwen3VL-4B-F16). Fall back to
 * the generic F16 > BF16 > first-found ordering when no base match.
 */
/** Precision/quant tag shared by both main weights and mmproj files. */
const QUANT_TAG_RE = /\b(f32|bf16|f16|iq\d(?:_[a-z0-9]+)*|q\d(?:_[a-z0-9]+)*)\b/i;

function extractQuantTag(fileName: string): string | null {
  return fileName.toLowerCase().match(QUANT_TAG_RE)?.[1] ?? null;
}

function findBestMMProj(
  ggufItems: GgufItem[],
  targetFileName?: string,
): GgufItem | null {
  const mmprojs = ggufItems.filter((i) => isMMProjFile(i.fileName));
  if (mmprojs.length === 0) return null;
  // Pull identifying tokens from the target filename — e.g.
  // "Qwen3-VL-4B-Instruct-Q4_K_M.gguf" → ["qwen3", "vl", "4b", "instruct"]
  // Then a projector whose filename shares the most tokens wins.
  if (targetFileName) {
    const target = targetFileName.toLowerCase();
    const targetQuant = extractQuantTag(target);
    const baseTokens = target
      .replace(/\.(gguf|safetensors|ckpt|zip)$/i, '')
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 2 && !/^(q\d|k_m|k_s|f16|f32|bf16|gguf|instruct)$/.test(t));
    let best: GgufItem | null = null;
    let bestScore = 0;
    for (const mm of mmprojs) {
      const mmLower = mm.fileName.toLowerCase();
      let score = 0;
      for (const t of baseTokens) if (mmLower.includes(t)) score += 1;
      // Tie-break: repos that ship the same projector in multiple
      // precisions (e.g. mmproj-...-Q8_0.gguf next to mmproj-...-f16.gguf)
      // score identically on base tokens alone, since quant tokens are
      // filtered out above. Nudge towards the projector whose own quant
      // tag matches the tapped weight's, so an F16 main weight doesn't
      // silently get paired with a Q8_0 projector on a first-found tie.
      if (targetQuant && extractQuantTag(mm.fileName) === targetQuant) score += 0.5;
      if (score > bestScore) {
        best = mm;
        bestScore = score;
      }
    }
    if (best && bestScore > 0) return best;
  }
  // Generic fallback: F16 > BF16 > first-found.
  const f16 = mmprojs.find((m) => m.fileName.toLowerCase().includes('f16') && !m.fileName.toLowerCase().includes('bf16'));
  if (f16) return f16;
  const bf16 = mmprojs.find((m) => m.fileName.toLowerCase().includes('bf16'));
  if (bf16) return bf16;
  return mmprojs[0];
}

/**
 * ratio < 0.4 => null (safe)
 * ratio < 0.65 => warning (yellow)
 * ratio >= 0.65 => close-circle (red / likely crash)
 */
function getIconNameByRatio(
  ratio: number
): keyof typeof Ionicons.glyphMap | null {
  if (ratio < 0.4) return null;
  if (ratio < 0.65) return 'warning';
  return 'close-circle';
}

function getIconColorByRatio(ratio: number): string {
  if (ratio < 0.4) return 'transparent';
  if (ratio < 0.65) return '#CCAA00';
  return '#CC0000';
}

type Props = {
  visible: boolean;
  onClose: () => void;
  ggufItems: GgufItem[];
};

export default function HuggingfaceDownloadModel({
  visible,
  onClose,
  ggufItems,
}: Props) {
  // Per-field selectors — same reasoning as in DownloadModel.tsx: pulling
  // `downloadProgress` / `isDownloading` into this level forces the whole
  // modal to re-render every 500 ms per active download. The per-model
  // progress bar lives in HfProgressBar (above) which subscribes only to
  // its own slot.
  const downloadedModels = useStore((s) => s.downloadedModels);
  const activeDownloads = useStore((s) => s.activeDownloads);
  const selectedModel = useStore((s) => s.selectedModel);
  const totalDeviceMemory = useStore((s) => s.totalDeviceMemory);
  const cancelDownload = useStore((s) => s.cancelDownload);
  const downloadModel = useStore((s) => s.downloadModel);
  const deleteModel = useStore((s) => s.deleteModel);
  const selectModel = useStore((s) => s.selectModel);
  const setDidUserCloseDownloadModal = useStore((s) => s.setDidUserCloseDownloadModal);

  const colorScheme = useColorScheme();

  // Probe device QNN/NPU support once. Captures both the yes/no
  // flag (for filtering NPU rows out of the visible list) and the
  // chip-tier variant (for picking the right _qnn2.28_<variant>.zip
  // when we see multiple variants of the same base model in a repo).
  const [npuSupported, setNpuSupported] = useState<boolean>(false);
  const [qnnVariant, setQnnVariant] = useState<'min' | '8gen1' | '8gen2' | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'android') { setNpuSupported(false); setQnnVariant(null); return; }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const SD = require('expo-stable-diffusion');
      const diag: string = SD?.hello?.() ?? '';
      const match = diag.match(/qnn=(\S+)/);
      const v = match?.[1];
      if (v === 'min' || v === '8gen1' || v === '8gen2') {
        setNpuSupported(true);
        setQnnVariant(v);
      } else {
        setNpuSupported(false);
        setQnnVariant(null);
      }
    } catch {
      setNpuSupported(false);
      setQnnVariant(null);
    }
  }, []);

  // Single icon color matching dark/light scheme
  const iconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';

  // "Use Model" button colors
  const useModelButtonBg = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const useModelButtonText = colorScheme === 'dark' ? '#000000' : '#FFFFFF';

  // Shape the raw scraped list: drop mmprojs (bundled), collapse QNN
  // chip-tier variants into one row, hide NPU rows on unsupported
  // devices, downloaded first.
  const sortedItems = useMemo(
    () => sortGgufItems(ggufItems, downloadedModels, npuSupported, qnnVariant),
    [ggufItems, downloadedModels, npuSupported, qnnVariant]
  );

  // For the vision-projector banner — a repo-level "yes there's a
  // projector" flag. We don't pin a specific file here because the
  // actual pairing happens per-tap in doDownload / handleUseModel.
  const repoHasMmProj = useMemo(
    () => ggufItems.some((i) => isMMProjFile(i.fileName)),
    [ggufItems]
  );
  const largestMmProjSize = useMemo(() => {
    const mmprojs = ggufItems.filter((i) => isMMProjFile(i.fileName));
    return mmprojs[0]?.fileSize ?? '';
  }, [ggufItems]);

  /** Called when user closes the modal. */
  const handleClose = () => {
    setDidUserCloseDownloadModal(true);
    onClose();
  };

  /**
   * Called when user taps "Download": NPU compatibility + memory-based checks
   */
  const handleDownload = (item: GgufItem) => {
    // Multi-part (gguf-split) sets can't be used: llama.cpp needs every
    // part on disk, and sets this large (typically 45 GB+) are far beyond
    // phone hardware anyway. Explain instead of downloading a broken part.
    if (item.splitTotal && item.splitTotal > 1) {
      themedAlert(
        'Multi-Part Model',
        `This model ships as ${item.splitTotal} separate files (${item.fileSize} total) and is built for machines with far more memory than a phone. Pick a smaller single-file version instead — most repos offer one under a few GB (e.g. Q4_K_M).`,
        [{ text: 'OK' }]
      );
      return;
    }
    // Warn about NPU models on unsupported devices before RAM checks
    if (!npuSupported && item.fileType === 'npu') {
      themedAlert(
        'NPU May Not Be Supported',
        'This is an NPU (QNN) model that requires a compatible Snapdragon processor. Your device may not support it and the model will likely fail to load. Download anyway?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Download Anyway',
            style: 'destructive',
            onPress: () => proceedWithMemoryCheck(item),
          },
        ]
      );
      return;
    }
    proceedWithMemoryCheck(item);
  };

  /** RAM-based download checks (called after NPU check passes) */
  const proceedWithMemoryCheck = (item: GgufItem) => {
    const bytes = parseFileSizeString(item.fileSize || '');
    if (bytes <= 0) {
      themedAlert('Size Unknown', 'Cannot parse file size. Proceed anyway?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'OK', onPress: () => doDownload(item) },
      ]);
      return;
    }

    const ratio = totalDeviceMemory > 0 ? bytes / totalDeviceMemory : 0;
    if (ratio >= 0.85) {
      themedAlert(
        'Very Likely to Crash',
        'This model exceeds your estimated available memory. It will almost certainly crash. Download anyway?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Download Anyway',
            style: 'destructive',
            onPress: () => doDownload(item),
          },
        ]
      );
    } else if (ratio >= 0.65) {
      themedAlert(
        'High Risk of Crash',
        'This model is large relative to your available memory. It may crash when loading. Proceed?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Download',
            style: 'destructive',
            onPress: () => doDownload(item),
          },
        ]
      );
    } else if (ratio >= 0.4) {
      themedAlert(
        'Moderate Memory Usage',
        'This model will use a significant portion of your available memory. Proceed?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Continue', onPress: () => doDownload(item) },
        ]
      );
    } else {
      doDownload(item);
    }
  };

  // Download handler — detects model type from fileType badge or filename
  const doDownload = (item: GgufItem) => {
    const modelName = modelNameFor(item);
    const ft = item.fileType || '';
    const isImageGen = ft === 'gpu' || ft === 'npu' || ft === 'imagegen-cpu'
      || detectImageGenFromFilename(modelName);
    const isVision = ft === 'vision';

    // Match a projector against THIS specific weight, not just "first
    // F16 in the repo" — see findBestMMProj for the scoring rule.
    const pairedMmProj = !isImageGen && !isVision
      ? findBestMMProj(ggufItems, item.fileName)
      : null;
    const mmProjUrl = pairedMmProj
      ? pairedMmProj.href.replace('?download=true', '')
      : undefined;
    const mmProjSize = mmProjUrl ? pairedMmProj?.fileSize : undefined;

    // Build the description. We prepend the HF repo (`<owner>/<repo>`)
    // so the user can see at a glance which repo the file came from —
    // the file name alone (e.g. "Qwen3-4B-RPG-Roleplay-V2.Q8_0") drops
    // the owner and is identical for repo forks.
    const repo = repoFromHfUrl(item.href);
    let kind = 'Downloaded from Hugging Face';
    if (ft === 'gpu') kind = 'MNN model (GPU accelerated)';
    else if (ft === 'npu') kind = 'QNN model (NPU accelerated)';
    else if (ft === 'imagegen-cpu') kind = 'Image generation model (CPU)';
    else if (isVision || mmProjUrl) kind = 'Vision model from Hugging Face';
    else if (isImageGen) kind = 'Image generation model';
    const description = repo ? `${repo} — ${kind}` : kind;

    downloadModel({
      name: modelName,
      url: item.href,
      description,
      source: 'huggingface',
      size: item.fileSize || undefined,
      mmProjUrl,
      mmProjSize,
      modelType: isImageGen ? 'imageGen' : undefined,
    });
  };

  // Cancel
  const handleCancel = (item: GgufItem) => {
    cancelDownload(modelNameFor(item));
  };

  // Delete
  const handleDelete = (item: GgufItem) => {
    deleteModel(modelNameFor(item));
  };

  // Use Model
  const handleUseModel = (item: GgufItem) => {
    const modelName = modelNameFor(item);
    const ft = item.fileType || '';
    const isImageGen = ft === 'gpu' || ft === 'npu' || ft === 'imagegen-cpu'
      || detectImageGenFromFilename(modelName);

    const pairedMmProj = !isImageGen ? findBestMMProj(ggufItems, item.fileName) : null;
    const useRepo = repoFromHfUrl(item.href);
    const useKind = isImageGen ? 'Image generation model' : 'Downloaded from Hugging Face';
    selectModel({
      name: modelName,
      url: item.href,
      description: useRepo ? `${useRepo} — ${useKind}` : useKind,
      source: 'huggingface',
      size: item.fileSize || undefined,
      mmProjUrl: pairedMmProj ? pairedMmProj.href.replace('?download=true', '') : undefined,
      mmProjSize: pairedMmProj ? pairedMmProj.fileSize : undefined,
      modelType: isImageGen ? 'imageGen' : undefined,
    });
    onClose();
  };

  /** When user taps the icon (yellow or red) */
  const handleIconTap = () => {
    themedAlert(
      'Warning',
      'Model size is close to or exceeds your device memory. This may cause unexpected behaviour.'
    );
  };

  // Render each row
  const renderItem = ({ item }: { item: GgufItem }) => {
    // ratio => memory usage
    const fileBytes = parseFileSizeString(item.fileSize || '');
    const ratio = totalDeviceMemory > 0 ? fileBytes / totalDeviceMemory : 0;

    // Only show an icon if ratio >= 0.5
    const ratioIconName = getIconNameByRatio(ratio);
    const ratioIconColor = getIconColorByRatio(ratio);

    // States — handle all extensions
    const modelName = modelNameFor(item);
    const isDownloaded = downloadedModels.includes(item.fileName)
      || downloadedModels.includes(modelName); // MNN dirs stored as bare name
    const isDownloadingThisOne =
      activeDownloads instanceof Set ? activeDownloads.has(modelName) : false;
    const isSelected = selectedModel?.name === modelName;

    return (
      <View className="border-b border-theme-light-border dark:border-theme-dark-border py-3">
        {/* Row => left side + right icons */}
        <View className="flex-row items-start justify-between">
          {/* LEFT SIDE => ratio icon + file name, size, "Use Model" */}
          <View style={{ flex: 1, paddingRight: 8 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              {/* If ratioIconName is not null => wrap Ionicons in a pressable to show warning */}
              {ratioIconName && (
                <TouchableOpacity
                  onPress={handleIconTap}
                  style={{ marginRight: 8 }}
                >
                  <Ionicons
                    name={ratioIconName}
                    size={16}
                    color={ratioIconColor}
                  />
                </TouchableOpacity>
              )}
              <Text
                className="text-base font-bold text-theme-light-text-primary dark:text-theme-dark-text-primary"
                style={{ flex: 1 }}
              >
                {item.fileName}
              </Text>
            </View>

            {/* Type badge + Size */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 6, flexWrap: 'wrap' }}>
              {item.fileType === 'gpu' && (
                <View style={{
                  backgroundColor: colorScheme === 'dark' ? '#1E3A5F' : '#EFF6FF',
                  paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                }}>
                  <Text style={{ fontSize: 10, fontWeight: 'bold',
                    color: colorScheme === 'dark' ? '#60A5FA' : '#2563EB' }}>
                    GPU (MNN)
                  </Text>
                </View>
              )}
              {item.fileType === 'npu' && (
                <View style={{
                  backgroundColor: colorScheme === 'dark' ? '#3E1F5E' : '#F5E8FF',
                  paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                }}>
                  <Text style={{ fontSize: 10, fontWeight: 'bold',
                    color: colorScheme === 'dark' ? '#C084FC' : '#9333EA' }}>
                    NPU (QNN)
                  </Text>
                </View>
              )}
              {!npuSupported && item.fileType === 'npu' && (
                <View style={{
                  backgroundColor: colorScheme === 'dark' ? '#4A1E1E' : '#FEE2E2',
                  paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                }}>
                  <Text style={{ fontSize: 10, fontWeight: 'bold',
                    color: colorScheme === 'dark' ? '#FCA5A5' : '#DC2626' }}>
                    UNSUPPORTED DEVICE
                  </Text>
                </View>
              )}
              {item.fileType === 'imagegen-cpu' && (
                <View style={{
                  backgroundColor: colorScheme === 'dark' ? '#3B1E4E' : '#F5E8FF',
                  paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                }}>
                  <Text style={{ fontSize: 10, fontWeight: 'bold',
                    color: colorScheme === 'dark' ? '#D8B4FE' : '#9333EA' }}>
                    IMAGE GEN (CPU)
                  </Text>
                </View>
              )}
              {item.fileType === 'vision' && (
                <View style={{
                  backgroundColor: colorScheme === 'dark' ? '#1E293B' : '#EFF6FF',
                  paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                }}>
                  <Text style={{ fontSize: 10, fontWeight: 'bold',
                    color: colorScheme === 'dark' ? '#93C5FD' : '#2563EB' }}>
                    VISION
                  </Text>
                </View>
              )}
              {(!item.fileType || item.fileType === 'text') && item.fileName.endsWith('.gguf') && (
                <View style={{
                  backgroundColor: colorScheme === 'dark' ? '#1F2937' : '#F3F4F6',
                  paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                }}>
                  <Text style={{ fontSize: 10, fontWeight: 'bold',
                    color: colorScheme === 'dark' ? '#9CA3AF' : '#6B7280' }}>
                    TEXT LLM
                  </Text>
                </View>
              )}
              <Text style={{
                fontSize: 12,
                color: colorScheme === 'dark' ? '#9BA1A6' : '#666666',
              }}>
                {item.fileSize || 'Unknown size'}
              </Text>
            </View>

            {/* In-row download progress (subscribes per-model; the rest
                of the modal doesn't re-render on progress ticks). */}
            {isDownloadingThisOne && <HfProgressBar modelName={modelName} />}

            {/* If downloaded => "Use Model" button */}
            {isDownloaded && (
              <TouchableOpacity
                onPress={() => handleUseModel(item)}
                className="mt-2 p-2 w-24 items-center rounded-full"
                style={{ backgroundColor: useModelButtonBg }}
              >
                <Text
                  className="font-bold"
                  style={{ fontSize: 14, color: useModelButtonText }}
                >
                  Use Model
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* RIGHT SIDE => vertical icons */}
          <View className="flex-col items-end" style={{ width: 30 }}>
            {/* Downloaded => show trash */}
            {isDownloaded && (
              <TouchableOpacity onPress={() => handleDelete(item)}>
                <Ionicons name="trash" size={20} color={iconColor} />
              </TouchableOpacity>
            )}

            {/* If not downloaded => spinner/cancel or download */}
            {!isDownloaded && (
              <>
                {isDownloadingThisOne ? (
                  <View style={{ alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={iconColor} />
                    <TouchableOpacity
                      onPress={() => handleCancel(item)}
                      style={{ marginTop: 6 }}
                    >
                      <Ionicons
                        name="close-circle"
                        size={20}
                        color={iconColor}
                      />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity onPress={() => handleDownload(item)}>
                    <Ionicons name="download" size={20} color={iconColor} />
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" hardwareAccelerated>
      <View className="flex-1 bg-theme-light-background dark:bg-theme-dark-background bg-opacity-50 justify-center items-center p-4">
        {/* Changed width from w-11/12 to w-[99%] below */}
        <View className="w-[99%] max-h-[90%] rounded-lg p-4 bg-theme-light-input-background dark:bg-theme-dark-input-background">
          <Text className="text-xl font-bold text-theme-light-text-primary dark:text-theme-dark-text-primary mb-3">
            Found .gguf Files
          </Text>

          {/* Vision support banner */}
          {repoHasMmProj && (
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: colorScheme === 'dark' ? '#1E293B' : '#EFF6FF',
              padding: 8,
              borderRadius: 8,
              marginBottom: 8,
            }}>
              <Ionicons name="eye-outline" size={16} color={colorScheme === 'dark' ? '#93C5FD' : '#2563EB'} />
              <Text style={{
                marginLeft: 6,
                fontSize: 12,
                color: colorScheme === 'dark' ? '#93C5FD' : '#2563EB',
                flex: 1,
              }}>
                Vision projector detected{largestMmProjSize ? ` (${largestMmProjSize})` : ''}. Models will auto-download with vision support.
              </Text>
            </View>
          )}

          {/* Single scrollable FlatList (downloaded are at top via sortedItems) */}
          <FlatList
            data={sortedItems}
            renderItem={renderItem}
            keyExtractor={(item) => item.fileName}
            className="mb-4"
            removeClippedSubviews
            initialNumToRender={12}
            windowSize={7}
            maxToRenderPerBatch={8}
          />

          {/* Close Button */}
          <TouchableOpacity
            onPress={handleClose}
            className="self-end px-4 py-2 rounded-full"
            style={{
              backgroundColor: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
            }}
          >
            <Text
              className="font-bold"
              style={{
                color: colorScheme === 'dark' ? '#000000' : '#FFFFFF',
              }}
            >
              Close
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
