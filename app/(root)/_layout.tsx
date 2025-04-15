// app/(root)/_layout.tsx
import { Stack } from 'expo-router';
import React, { useEffect } from 'react';
import { useStore } from '@/store'; // Ensure correct path
import { useColorScheme } from 'react-native';

const Layout = () => {
  const initializeModels = useStore((state) => state.initializeModels);
  const colorScheme = useColorScheme() || 'light';

  useEffect(() => {
    initializeModels();
  }, [initializeModels]);

  return (
    <Stack
      // Set the background color to avoid white flashes
      screenOptions={{
        contentStyle: {
          backgroundColor: colorScheme === 'dark' ? '#0D0D0D' : '#FCFCFC',
        },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="ProfileDetailPage" options={{ headerShown: false }} />
    </Stack>
  );
};

export default Layout; // Ensure default export
