// app/(root)/_layout.tsx
import { Stack } from 'expo-router';
import React, { useEffect } from 'react';
import { useStore } from '@/store';
import { useColorScheme } from 'react-native';

const Layout = () => {
  const initializeModels = useStore((state) => state.initializeModels);
  const colorScheme = useColorScheme() || 'light';

  useEffect(() => {
    initializeModels();
  }, [initializeModels]);

  // With react-native-blob-util, downloads continue in background natively.
  // No AppState pause/resume needed -- the native HTTP client handles it.

  return (
    <Stack
      screenOptions={{
        contentStyle: {
          backgroundColor: colorScheme === 'dark' ? '#0D0D0D' : '#FCFCFC',
        },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="ProfileDetailPage" options={{ headerShown: false }} />
      <Stack.Screen name="DownloadsPage" options={{ headerShown: false }} />
    </Stack>
  );
};

export default Layout;
