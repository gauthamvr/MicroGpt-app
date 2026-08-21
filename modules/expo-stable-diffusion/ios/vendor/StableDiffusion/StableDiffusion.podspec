#
# Vendored copy of apple/ml-stable-diffusion v1.1.1 (MIT) — the
# `StableDiffusion` Swift library target only (no CLI, no ArgumentParser
# dependency). Compiled as its own pod/module so the ExpoStableDiffusion
# module can `import StableDiffusion`, matching the upstream package layout.
#
# Source: https://github.com/apple/ml-stable-diffusion (tag 1.1.1)
# Vendored: swift/StableDiffusion/{pipeline,tokenizer}/*.swift
#
Pod::Spec.new do |s|
  s.name            = 'StableDiffusion'
  s.version         = '1.1.1'
  s.summary         = 'Apple ml-stable-diffusion (vendored Swift library)'
  s.description     = 'Vendored Swift sources from apple/ml-stable-diffusion v1.1.1 (MIT) for on-device Core ML image generation.'
  s.homepage        = 'https://github.com/apple/ml-stable-diffusion'
  s.license         = { :type => 'MIT', :file => 'LICENSE.md' }
  s.author          = 'Apple Inc.'
  # The library's public API is @available(iOS 16.2, *); declare the
  # package's stated minimum so CocoaPods doesn't complain.
  s.platform        = :ios, '16.0'
  s.swift_version   = '5.7'
  s.source          = { :git => '' }
  s.source_files    = '{pipeline,tokenizer}/**/*.swift'
  s.frameworks      = 'CoreML', 'Accelerate', 'CoreGraphics', 'Foundation'
  s.static_framework = true

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
