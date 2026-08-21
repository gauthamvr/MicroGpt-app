// modules/expo-stable-diffusion/ios/ExpoStableDiffusionModule.swift
//
// iOS image-generation engine for MicroGPT, exposed under the SAME
// `ExpoStableDiffusion` JS contract used on Android (see ../src/index.ts)
// so lib/image-gen-service.ts works unchanged across platforms.
//
// The Android engines don't port: sd-server runs as a child *process*
// (impossible in the iOS sandbox) and local-dream is Qualcomm-NPU only.
// The iOS alternative is Apple's Core ML Stable Diffusion pipeline
// (apple/ml-stable-diffusion, `import StableDiffusion`), which runs on the
// Neural Engine / GPU. Models are Core ML `.mlmodelc` bundles rather than
// gguf/safetensors, so iOS ships its own image-model catalog.
//
// ── Build resilience ────────────────────────────────────────────────
// Everything Core ML is behind `#if canImport(StableDiffusion)`. That
// means this module COMPILES AND LOADS whether or not the ml-stable-
// diffusion package has been added to the build yet:
//   • Package not wired  → hello() returns "missing-binary", loads/gens
//     reject with a clear message, and the app runs fine with image-gen
//     shown as unavailable (exactly the Android no-binary behaviour).
//   • Package wired       → full on-device Core ML generation.
// To enable it, add apple/ml-stable-diffusion to the build (see
// docs/UPDATING.md → "iOS image generation"). No code change needed here.

import ExpoModulesCore
import Foundation

#if canImport(StableDiffusion)
import StableDiffusion
import CoreML
import UIKit
import CoreGraphics
#endif

public class ExpoStableDiffusionModule: Module {

  // Serializes load / generate / unload so we never touch the pipeline
  // from two calls at once.
  private let queue = DispatchQueue(label: "ai.microgpt.coreml.diffusion", qos: .userInitiated)

  #if canImport(StableDiffusion)
  @available(iOS 16.2, *)
  private var pipeline: StableDiffusionPipelineProtocol? {
    get { _pipelineBox as? StableDiffusionPipelineProtocol }
    set { _pipelineBox = newValue }
  }
  // Type-erased storage so the stored property itself doesn't need the
  // availability annotation.
  private var _pipelineBox: Any?
  #endif

  private var loadedModelPath: String?
  private var generating = false
  private var cancelRequested = false

  public func definition() -> ModuleDefinition {
    Name("ExpoStableDiffusion")

    Events("onGenerationProgress", "onGenerationError")

    // ── hello() ───────────────────────────────────────────────────
    // Mirrors the Android diagnostic string consumed by
    // image-gen-service.diagnoseBinary(): returning "missing-binary"
    // makes the JS treat image-gen as unavailable; any other non-empty
    // string that isn't "not-extracted…" is treated as ready.
    Function("hello") { () -> String in
      #if canImport(StableDiffusion)
      if #available(iOS 16.2, *) {
        return "ready engine=coreml backend=ANE"
      } else {
        return "missing-binary" // Core ML SD pipeline needs iOS 16.2+
      }
      #else
      return "missing-binary"
      #endif
    }

    Function("isLoaded") { () -> Bool in
      self.loadedModelPath != nil
    }

    // ── loadModel(path) ───────────────────────────────────────────
    // `path` is the model DIRECTORY (resolved by image-gen-service to the
    // folder containing Unet.mlmodelc / TextEncoder.mlmodelc).
    AsyncFunction("loadModel") { (path: String, promise: Promise) in
      self.queue.async {
        #if canImport(StableDiffusion)
        if #available(iOS 16.2, *) {
          do {
            try self.loadCoreML(path: path)
            promise.resolve(nil)
          } catch {
            promise.reject("ERR_LOAD_FAILED", "Failed to load Core ML model: \(error.localizedDescription)")
          }
        } else {
          promise.reject("ERR_UNSUPPORTED", "On-device image generation requires iOS 16.2 or newer.")
        }
        #else
        promise.reject("ERR_NO_ENGINE", "Image generation engine is not available in this build.")
        #endif
      }
    }

    // ── unloadModel() ─────────────────────────────────────────────
    AsyncFunction("unloadModel") { (promise: Promise) in
      self.queue.async {
        #if canImport(StableDiffusion)
        if #available(iOS 16.2, *) { self.pipeline = nil }
        #endif
        self.loadedModelPath = nil
        promise.resolve(nil)
      }
    }

    // ── generate(...) → base64 PNG ────────────────────────────────
    AsyncFunction("generate") {
      (prompt: String, negativePrompt: String, width: Int, height: Int,
       steps: Int, cfgScale: Double, seed: Double, promise: Promise) in
      self.queue.async {
        #if canImport(StableDiffusion)
        if #available(iOS 16.2, *) {
          self.generateCoreML(
            prompt: prompt, negativePrompt: negativePrompt,
            steps: steps, cfgScale: cfgScale, seed: seed, promise: promise
          )
        } else {
          self.emitError("On-device image generation requires iOS 16.2 or newer.")
          promise.reject("ERR_UNSUPPORTED", "On-device image generation requires iOS 16.2 or newer.")
        }
        #else
        self.emitError("Image generation engine is not available in this build.")
        promise.reject("ERR_NO_ENGINE", "Image generation engine is not available in this build.")
        #endif
      }
    }

    // ── cancelGeneration() ────────────────────────────────────────
    AsyncFunction("cancelGeneration") { (promise: Promise) in
      self.cancelRequested = true
      promise.resolve(nil)
    }

    // ── unzipModel(zip, dest) ─────────────────────────────────────
    // Core ML model bundles can ship as a .zip of .mlmodelc folders.
    // iOS has no public unzip in Foundation; the iOS catalog therefore
    // distributes already-extracted model files and this is a no-op
    // pass-through that simply verifies the destination exists. (If a
    // zipped distribution is ever needed, vendor ZIPFoundation and
    // implement here — see docs/UPDATING.md.)
    AsyncFunction("unzipModel") { (zipPath: String, destDir: String, promise: Promise) in
      self.queue.async {
        let fm = FileManager.default
        if fm.fileExists(atPath: destDir) {
          promise.resolve(nil)
        } else {
          promise.reject(
            "ERR_UNZIP_UNSUPPORTED",
            "Zipped models aren't supported on iOS; download an extracted Core ML model."
          )
        }
      }
    }

    OnDestroy {
      self.queue.sync {
        #if canImport(StableDiffusion)
        if #available(iOS 16.2, *) { self.pipeline = nil }
        #endif
        self.loadedModelPath = nil
      }
    }
  }

  // MARK: - Core ML implementation

  #if canImport(StableDiffusion)

  @available(iOS 16.2, *)
  private func loadCoreML(path: String) throws {
    let url = URL(fileURLWithPath: path)

    // Validate the essential compiled sub-models exist before handing the
    // directory to the pipeline (a missing TextEncoder.mlmodelc otherwise
    // crashes deep inside encode(ids:)).
    if let missing = Self.validateModelDirectory(at: url) {
      throw NSError(domain: "ExpoStableDiffusion", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: missing])
    }

    // Reload only if the path changed.
    if loadedModelPath == path, pipeline != nil { return }
    pipeline = nil
    loadedModelPath = nil

    let config = MLModelConfiguration()
    // Models whose folder name carries "CPU" use the `original` attention
    // variant (CPU/GPU) and run on pre-A14 chips like the iPhone 11 (A13).
    // ANE models use the Neural Engine (much faster on iPhone 12+).
    let isCPUVariant = url.lastPathComponent.contains("CPU")
    config.computeUnits = isCPUVariant ? .cpuAndGPU : .cpuAndNeuralEngine

    // SDXL's Core ML pipeline (and its resourcesAt: init) require iOS 17.0,
    // unlike the base pipeline which is 16.2. Gate the XL path so the module
    // compiles at a 16.x deployment target.
    let isXL = Self.isXLModelDirectory(at: url)
    let pipe: StableDiffusionPipelineProtocol
    if isXL {
      guard #available(iOS 17.0, *) else {
        throw NSError(
          domain: "ExpoStableDiffusion", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "SDXL Core ML models require iOS 17.0 or newer."],
        )
      }
      pipe = try StableDiffusionXLPipeline(resourcesAt: url, configuration: config, reduceMemory: true)
    } else {
      pipe = try StableDiffusionPipeline(resourcesAt: url, controlNet: [], configuration: config, reduceMemory: true)
    }
    try pipe.loadResources()

    pipeline = pipe
    loadedModelPath = path
  }

  @available(iOS 16.2, *)
  private func generateCoreML(
    prompt: String, negativePrompt: String, steps: Int, cfgScale: Double, seed: Double, promise: Promise
  ) {
    guard let pipe = pipeline else {
      emitError("No image model loaded")
      promise.reject("ERR_NO_MODEL", "No image model loaded")
      return
    }
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      promise.reject("ERR_INVALID_PROMPT", "Prompt cannot be empty")
      return
    }
    if generating {
      promise.reject("ERR_BUSY", "Image generation already in progress")
      return
    }

    generating = true
    cancelRequested = false
    defer { generating = false }

    // step 0 priming event, matching the Android module.
    emitProgress(step: 0, totalSteps: steps)

    var cfg = StableDiffusionPipeline.Configuration(prompt: trimmed)
    cfg.negativePrompt = negativePrompt
    cfg.stepCount = max(1, steps)
    cfg.guidanceScale = Float(cfgScale)
    cfg.seed = seed < 0 ? UInt32.random(in: 0 ..< UInt32.max) : UInt32(truncatingIfNeeded: Int(seed))
    // We don't ship the SafetyChecker model, and we don't want generated
    // images silently blanked — run with the checker disabled.
    cfg.disableSafety = true

    do {
      let images = try pipe.generateImages(configuration: cfg) { progress in
        if self.cancelRequested { return false }
        self.emitProgress(step: progress.step, totalSteps: progress.stepCount)
        return true
      }

      if cancelRequested {
        promise.reject("ERR_CANCELLED", "Generation was cancelled")
        return
      }
      guard let cg = images.compactMap({ $0 }).first else {
        emitError("Pipeline produced no image")
        promise.reject("ERR_NO_IMAGE", "Pipeline produced no image")
        return
      }

      emitProgress(step: steps, totalSteps: steps)

      guard let png = UIImage(cgImage: cg).pngData() else {
        promise.reject("ERR_ENCODE", "Failed to encode PNG")
        return
      }
      // Existing contract returns a base64 PNG string.
      promise.resolve(png.base64EncodedString())
    } catch {
      let msg = "Image generation failed: \(error.localizedDescription)"
      // A failed run can leave the pipeline in a bad state; drop it so the
      // next attempt reloads fresh.
      pipeline = nil
      loadedModelPath = nil
      emitError(msg)
      promise.reject("ERR_GENERATE_FAILED", msg)
    }
  }

  // SDXL ships TextEncoder2.mlmodelc.
  private static func isXLModelDirectory(at url: URL) -> Bool {
    FileManager.default.fileExists(atPath: url.appendingPathComponent("TextEncoder2.mlmodelc").path)
  }

  private static func hasValidUnetDirectory(at url: URL) -> Bool {
    let fm = FileManager.default
    if fm.fileExists(atPath: url.appendingPathComponent("Unet.mlmodelc").path) { return true }
    return fm.fileExists(atPath: url.appendingPathComponent("UnetChunk1.mlmodelc").path)
      && fm.fileExists(atPath: url.appendingPathComponent("UnetChunk2.mlmodelc").path)
  }

  /// Returns an error message if a required component is missing, else nil.
  private static func validateModelDirectory(at url: URL) -> String? {
    let fm = FileManager.default
    for comp in ["TextEncoder.mlmodelc", "VAEDecoder.mlmodelc"] {
      if !fm.fileExists(atPath: url.appendingPathComponent(comp).path) {
        return "Missing required model component: \(comp)"
      }
    }
    if !hasValidUnetDirectory(at: url) {
      return "Missing required model component: Unet.mlmodelc"
    }
    if isXLModelDirectory(at: url),
       !fm.fileExists(atPath: url.appendingPathComponent("TextEncoder2.mlmodelc").path) {
      return "Missing required SDXL component: TextEncoder2.mlmodelc"
    }
    return nil
  }

  #endif

  // MARK: - Events

  private func emitProgress(step: Int, totalSteps: Int) {
    sendEvent("onGenerationProgress", [
      "step": step,
      "totalSteps": totalSteps,
      "engine": "coreml",
      "backend": "ANE (Core ML)",
    ])
  }

  private func emitError(_ message: String) {
    sendEvent("onGenerationError", ["message": message])
  }
}
