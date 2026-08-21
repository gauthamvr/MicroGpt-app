// plugins/withStableDiffusionIOS.js
//
// Expo config plugin that wires the vendored Apple Core ML Stable Diffusion
// library into the iOS build. Two jobs, both iOS-only (Android is never
// touched — we don't even prebuild it):
//
//   1. Add the vendored `StableDiffusion` pod to the generated Podfile so
//      `modules/expo-stable-diffusion/ios/ExpoStableDiffusionModule.swift`
//      can `import StableDiffusion`.
//   2. Raise the iOS deployment target to 16.0. Apple's ml-stable-diffusion
//      API is @available(iOS 16.2, *); 16.0 is its stated package minimum
//      and our module @available-gates every 16.2 call at runtime.
//
// If the package isn't wired (this plugin removed), the module still
// compiles — it's behind `#if canImport(StableDiffusion)`.

const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const DEPLOYMENT_TARGET = '16.0';
const POD_NAME = 'StableDiffusion';
const POD_PATH = '../modules/expo-stable-diffusion/ios/vendor/StableDiffusion';
const POD_LINE = `  pod '${POD_NAME}', :path => '${POD_PATH}'`;

function injectPod(contents) {
  if (contents.includes(`pod '${POD_NAME}'`)) return contents; // already present

  // Preferred anchor: right after `use_expo_modules!` (inside the app target).
  if (/use_expo_modules!.*\n/.test(contents)) {
    return contents.replace(/use_expo_modules!.*\n/, (m) => m + POD_LINE + '\n');
  }
  // Fallback: just before the target's `post_install` block.
  if (contents.includes('post_install do |installer|')) {
    return contents.replace(
      'post_install do |installer|',
      `${POD_LINE}\n\n  post_install do |installer|`,
    );
  }
  return contents;
}

const withStableDiffusionIOS = (config) => {
  // 1. Podfile: inject the pod + set the deployment-target property that
  //    Expo's Podfile reads for its `platform :ios, ...` line.
  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      const iosDir = cfg.modRequest.platformProjectRoot; // <root>/ios

      const podfilePath = path.join(iosDir, 'Podfile');
      if (fs.existsSync(podfilePath)) {
        const updated = injectPod(fs.readFileSync(podfilePath, 'utf8'));
        fs.writeFileSync(podfilePath, updated);
      }

      const propsPath = path.join(iosDir, 'Podfile.properties.json');
      let props = {};
      if (fs.existsSync(propsPath)) {
        try {
          props = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
        } catch {
          props = {};
        }
      }
      props['ios.deploymentTarget'] = DEPLOYMENT_TARGET;
      fs.writeFileSync(propsPath, JSON.stringify(props, null, 2));

      return cfg;
    },
  ]);

  // 2. Xcode project: bump the app target's deployment target to 16.0.
  config = withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const configurations = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configurations)) {
      const entry = configurations[key];
      if (
        typeof entry === 'object' &&
        entry.buildSettings &&
        entry.buildSettings.IPHONEOS_DEPLOYMENT_TARGET !== undefined
      ) {
        entry.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = DEPLOYMENT_TARGET;
      }
    }
    return cfg;
  });

  return config;
};

module.exports = withStableDiffusionIOS;
