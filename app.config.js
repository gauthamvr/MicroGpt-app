import 'dotenv/config';

// ─── Env validation ────────────────────────────────────────────────────
// These EXPO_PUBLIC_* vars are baked into the JS bundle at build time.
// Locally they come from .env (gitignored). For EAS cloud builds they
// must be set as EAS Secrets:
//
//   eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --value "..."
//   eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value "..."
//   eas secret:create --scope project --name EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID --value "..."
//
const requiredEnvVars = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
];
const missing = requiredEnvVars.filter((v) => !process.env[v]);
if (missing.length > 0 && process.env.EAS_BUILD === 'true') {
  throw new Error(
    `Missing required environment variables for EAS build: ${missing.join(', ')}.\n` +
      'Set them as EAS Secrets: eas secret:create --scope project --name <VAR> --value "..."',
  );
}

// ─── Google Sign-In iOS URL scheme ─────────────────────────────────────
// iOS Google Sign-In needs the *reversed* iOS OAuth client ID registered
// as a URL scheme (e.g. "com.googleusercontent.apps.1234-abcd"). This is
// a DIFFERENT credential from the web client ID used for the Supabase
// id-token exchange — create an "iOS" OAuth client in Google Cloud Console
// for the bundle id below and set EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME to its
// reversed client ID. A harmless placeholder keeps the build green until
// then (sign-in just won't work on iOS until the real value is set).
const googleIosUrlScheme =
  process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME ||
  'com.googleusercontent.apps.placeholder-set-EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME';

export default {
  expo: {
    name: 'MicroGpt',
    slug: 'MicroGpt',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    scheme: 'myapp',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.meteormeta.MicroGpt',
      // On-device LLM/image models are multi-GB. Ask the OS for the
      // higher memory ceiling (the llama.rn plugin also sets the
      // matching entitlements on production builds).
      infoPlist: {
        // Avoids the App Store "export compliance" prompt on every
        // upload. The app only uses standard HTTPS — no custom crypto.
        ITSAppUsesNonExemptEncryption: false,
        // expo-image-picker (attach images to chat) + saving generated
        // images to the photo library.
        NSPhotoLibraryUsageDescription:
          'MicroGPT needs access to your photos so you can attach images to chats and save generated images.',
        NSPhotoLibraryAddUsageDescription:
          'MicroGPT saves images it generates to your photo library.',
        NSCameraUsageDescription:
          'MicroGPT needs camera access so you can take a photo to send in a chat.',
        // Allow large background model downloads to continue briefly
        // when the app is backgrounded (URLSession background tasks).
        UIBackgroundModes: ['fetch'],
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/images/icon.png',
        backgroundColor: '#ffffff',
      },
      package: 'com.meteormeta.MicroGpt',
    },
    web: {
      bundler: 'metro',
      output: 'static',
      favicon: './assets/images/icon.png',
    },
    plugins: [
      ['llama.rn', { enableOpenCLAndHexagon: true }],
      'expo-router',
      [
        'expo-splash-screen',
        {
          image: './assets/images/splash.png',
          imageWidth: 200,
          resizeMode: 'contain',
          backgroundColor: '#ffffff',
        },
      ],
      [
        'expo-notifications',
        {
          icon: './assets/images/icon.png',
          color: '#000000',
        },
      ],
      'expo-secure-store',
      [
        '@react-native-google-signin/google-signin',
        {
          iosUrlScheme: googleIosUrlScheme,
        },
      ],
      // iOS-only: vendor Apple Core ML Stable Diffusion into the build and
      // set the iOS deployment target to 16.0. No-op for Android.
      './plugins/withStableDiffusionIOS',
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      eas: {
        projectId: '4a7f93f4-b94f-4142-87c3-acfd64be96d2',
      },
    },
  },
};
