require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoStableDiffusion'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'MIT'
  s.author         = 'MicroGPT'
  s.homepage       = 'https://github.com/microgpt/microgpt'
  # Core ML Stable Diffusion needs iOS 16.2+ at runtime. We depend on the
  # vendored `StableDiffusion` pod (16.0), so this pod is 16.0 too; the
  # module @available-gates every 16.2 call.
  s.platforms      = { :ios => '16.0' }
  s.swift_version  = '5.7'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Vendored apple/ml-stable-diffusion (added to the Podfile by
  # plugins/withStableDiffusionIOS.js). Enables `import StableDiffusion`,
  # which flips on `#if canImport(StableDiffusion)` in the module.
  s.dependency 'StableDiffusion'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  # Only THIS module's own sources (non-recursive) — the vendored library
  # under ios/vendor/ is compiled by its own podspec, not here.
  s.source_files = "*.{h,m,mm,swift,hpp,cpp}"
end
