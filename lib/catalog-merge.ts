// lib/catalog-merge.ts
//
// Brings the saved model list in line with the catalog this version of
// the app ships.

import type { Model } from '@/store/useModelsSlice';

/**
 * The model list is persisted, so on an existing install the built-in
 * entries are whatever an earlier version of the app saved. The catalog is
 * the authority on those: its entries replace the saved ones, in catalog
 * order, so corrected sizes, URLs and descriptions arrive with an update,
 * and a built-in entry the catalog no longer has is dropped. Entries the
 * user added (HuggingFace, local import) are kept as they are.
 *
 * `modelType` survives from the saved entry when the catalog doesn't state
 * one: start-up detection writes it there after reading the file's header.
 */
export function refreshBuiltInModels(saved: Model[], catalog: Model[]): Model[] {
  const savedByName = new Map(saved.map((m) => [m.name, m]));
  const catalogNames = new Set(catalog.map((m) => m.name));

  const builtIn = catalog.map((entry) => {
    const prev = savedByName.get(entry.name);
    if (!prev) return entry;
    if (prev.source !== 'builtIn') return prev;
    return entry.modelType || !prev.modelType ? entry : { ...entry, modelType: prev.modelType };
  });
  const own = saved.filter((m) => m.source !== 'builtIn' && !catalogNames.has(m.name));

  return [...builtIn, ...own];
}
