import { refreshBuiltInModels } from '../lib/catalog-merge';
import type { Model } from '../store/useModelsSlice';

const builtIn = (name: string, extra: Partial<Model> = {}): Model => ({
  name,
  url: `https://example.com/${name}.gguf`,
  description: name,
  source: 'builtIn',
  ...extra,
});

describe('refreshBuiltInModels', () => {
  test('replaces saved built-in entries with the catalog version', () => {
    const saved = [builtIn('A', { size: '167 MB', url: 'https://example.com/old-A.gguf' })];
    const catalog = [builtIn('A', { size: '175 MB' })];
    expect(refreshBuiltInModels(saved, catalog)).toEqual(catalog);
  });

  test('adds new catalog entries in catalog order', () => {
    const saved = [builtIn('A'), builtIn('C')];
    const catalog = [builtIn('A'), builtIn('B'), builtIn('C')];
    expect(refreshBuiltInModels(saved, catalog).map((m) => m.name)).toEqual(['A', 'B', 'C']);
  });

  test('drops built-in entries the catalog no longer has', () => {
    const saved = [builtIn('A'), builtIn('Removed')];
    expect(refreshBuiltInModels(saved, [builtIn('A')]).map((m) => m.name)).toEqual(['A']);
  });

  test('keeps the models the user added, after the catalog', () => {
    const hf: Model = { name: 'Mine-Q4_K_M', url: 'https://example.com/m.gguf', description: 'x', source: 'huggingface' };
    const local: Model = { name: 'Imported', url: '', description: 'y', source: 'local' };
    const result = refreshBuiltInModels([hf, builtIn('A'), local], [builtIn('A'), builtIn('B')]);
    expect(result).toEqual([builtIn('A'), builtIn('B'), hf, local]);
  });

  test('keeps a detected model type the catalog does not state', () => {
    const saved = [builtIn('A', { modelType: 'vision' }), builtIn('B', { modelType: 'text' })];
    const catalog = [builtIn('A'), builtIn('B', { modelType: 'imageGen' })];
    const result = refreshBuiltInModels(saved, catalog);
    expect(result[0].modelType).toBe('vision');
    expect(result[1].modelType).toBe('imageGen');
  });

  test("leaves a user's model alone when it shares a catalog name", () => {
    const mine: Model = { name: 'A', url: '', description: 'Previously downloaded model', source: 'huggingface' };
    expect(refreshBuiltInModels([mine], [builtIn('A'), builtIn('B')])).toEqual([mine, builtIn('B')]);
  });
});
