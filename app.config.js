import 'dotenv/config';

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
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/images/icon.png',
        backgroundColor: '#ffffff',
      },
      package: 'com.anonymous.MicroGpt', // ← You can change this safely later
    },
    web: {
      bundler: 'metro',
      output: 'static',
      favicon: './assets/images/icon.png',
    },
    plugins: [
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
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      BACKEND_URL: process.env.BACKEND_URL,
      eas: {
        projectId: '4a7f93f4-b94f-4142-87c3-acfd64be96d2',
      },
    },
  },
};
