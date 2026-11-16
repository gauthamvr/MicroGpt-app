// The native module behaves like the Android one here: cancelling a
// generation stops the engine, after which generate() fails with
// "No model loaded" until loadModel() runs again.
const mockNative = {
  engineUp: false,
  keepsModelAcrossCancel: false,
  loadModel: jest.fn(async (_path: string) => {
    mockNative.engineUp = true;
  }),
  unloadModel: jest.fn(async () => {
    mockNative.engineUp = false;
  }),
  generate: jest.fn(async (_params: unknown) => {
    if (!mockNative.engineUp) throw new Error('Image generation failed: No model loaded');
    return 'base64-png';
  }),
  cancelGeneration: jest.fn(async () => {
    if (!mockNative.keepsModelAcrossCancel) mockNative.engineUp = false;
  }),
};

jest.mock(
  'expo-stable-diffusion',
  () => ({
    hello: () => 'ready sd-server=yes local-dream=yes',
    isLoaded: () => mockNative.engineUp,
    loadModel: (path: string) => mockNative.loadModel(path),
    unloadModel: () => mockNative.unloadModel(),
    generate: (params: unknown) => mockNative.generate(params),
    cancelGeneration: () => mockNative.cancelGeneration(),
    addProgressListener: () => ({ remove: () => {} }),
  }),
  { virtual: true },
);

jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: {
      dirs: { DownloadDir: '/download', DocumentDir: '/documents' },
      isDir: async (path: string) => path.endsWith('/MicroGPT/Test-MNN'),
      ls: async () => ['unet.mnn', 'clip.mnn'],
      exists: async () => false,
    },
  },
}));

import * as ImageGenService from '../lib/image-gen-service';
import { getModelsDir } from '../lib/storage-paths';

const MODEL_DIR = `${getModelsDir()}/Test-MNN`;

beforeEach(async () => {
  await ImageGenService.unloadImageModel();
  mockNative.engineUp = false;
  mockNative.keepsModelAcrossCancel = false;
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

test('generates again after a cancelled generation', async () => {
  await ImageGenService.loadImageModel('Test-MNN');
  expect(mockNative.loadModel).toHaveBeenCalledTimes(1);
  expect(mockNative.loadModel).toHaveBeenCalledWith(MODEL_DIR);

  await expect(ImageGenService.generateImage({ prompt: 'a cat' })).resolves.toBe('base64-png');

  await ImageGenService.cancelGeneration();
  expect(mockNative.engineUp).toBe(false);

  await expect(ImageGenService.generateImage({ prompt: 'a dog' })).resolves.toBe('base64-png');
  expect(mockNative.loadModel).toHaveBeenCalledTimes(2);
  expect(mockNative.loadModel).toHaveBeenLastCalledWith(MODEL_DIR);
  expect(ImageGenService.getLoadedModelName()).toBe('Test-MNN');
});

test('restarts the engine once for generations queued together', async () => {
  await ImageGenService.loadImageModel('Test-MNN');
  await ImageGenService.cancelGeneration();

  const results = await Promise.all([
    ImageGenService.generateImage({ prompt: 'a cat' }),
    ImageGenService.generateImage({ prompt: 'a dog' }),
  ]);
  expect(results).toEqual(['base64-png', 'base64-png']);
  expect(mockNative.loadModel).toHaveBeenCalledTimes(2);
});

test('does not reload when a cancel leaves the model in memory', async () => {
  mockNative.keepsModelAcrossCancel = true;
  await ImageGenService.loadImageModel('Test-MNN');
  await ImageGenService.cancelGeneration();

  await expect(ImageGenService.generateImage({ prompt: 'a cat' })).resolves.toBe('base64-png');
  expect(mockNative.loadModel).toHaveBeenCalledTimes(1);
});

test('still refuses to generate when nothing was loaded', async () => {
  await expect(ImageGenService.generateImage({ prompt: 'a cat' })).rejects.toThrow('No image model loaded');
  expect(mockNative.loadModel).not.toHaveBeenCalled();
});

test('checks the prompt before touching the engine', async () => {
  await ImageGenService.loadImageModel('Test-MNN');
  await ImageGenService.cancelGeneration();

  await expect(ImageGenService.generateImage({ prompt: 'nude woman' })).rejects.toMatchObject({
    name: 'ContentBlockedError',
  });
  expect(mockNative.loadModel).toHaveBeenCalledTimes(1);
  expect(mockNative.generate).not.toHaveBeenCalled();
});
