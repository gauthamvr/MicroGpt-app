// lib/storage-paths.ts
//
// Single source of truth for where MicroGPT keeps downloaded models and
// generated images, abstracted across platforms so the rest of the app
// never has to branch on Platform.OS for a base directory.
//
//   Android — the public `Download/MicroGPT` folder. This is where the
//     catalog and the native downloader have always written; it's visible
//     in the Files app and survives an app reinstall.
//   iOS — there is NO shared public Downloads directory; every app reads
//     and writes only inside its own sandbox. We use `Documents/MicroGPT`.
//
// Keeping Android pinned to DownloadDir means this change is purely
// additive: existing Android paths resolve exactly as before.

import { Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';

/** Primary model-storage directory (`<base>/MicroGPT`). */
export function getModelsDir(): string {
  const base =
    Platform.OS === 'ios'
      ? ReactNativeBlobUtil.fs.dirs.DocumentDir
      : ReactNativeBlobUtil.fs.dirs.DownloadDir;
  return `${base}/MicroGPT`;
}

/**
 * Legacy/secondary location some older builds wrote to. Still checked when
 * resolving an already-downloaded model so upgrades don't lose files.
 */
export function getLegacyModelsDir(): string {
  return `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/Downloads`;
}
