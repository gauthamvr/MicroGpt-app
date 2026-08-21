// app/_layout.tsx

import React, { useEffect } from 'react';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View, LogBox } from 'react-native';
import '../global.css';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { ThemedAlertProvider } from '@/components/ThemedAlert';
import { SupabaseAuthProvider } from '@/lib/supabase';
import { installLogCapture } from '@/lib/log-store';

// Tee console.log/warn/error into a small in-memory ring buffer so
// the user can share recent app output via Settings → View Logs.
// Cheap (one push + occasional shift per console call), idempotent,
// no behaviour change to the original console output.
installLogCapture();

SplashScreen.preventAutoHideAsync();

LogBox.ignoreLogs(['Supabase:']);

export default function RootLayout() {
  const [loaded] = useFonts({
    'Jakarta-Bold': require('../assets/fonts/PlusJakartaSans-Bold.ttf'),
    'Jakarta-ExtraBold': require('../assets/fonts/PlusJakartaSans-ExtraBold.ttf'),
    'Jakarta-ExtraLight': require('../assets/fonts/PlusJakartaSans-ExtraLight.ttf'),
    'Jakarta-Light': require('../assets/fonts/PlusJakartaSans-Light.ttf'),
    'Jakarta-Medium': require('../assets/fonts/PlusJakartaSans-Medium.ttf'),
    Jakarta: require('../assets/fonts/PlusJakartaSans-Regular.ttf'),
    'Jakarta-SemiBold': require('../assets/fonts/PlusJakartaSans-SemiBold.ttf'),
  });

  const colorScheme = useColorScheme();

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) return null;

  return (
    <SupabaseAuthProvider>
      <SafeAreaProvider>
        <ThemedAlertProvider>
          <StatusBar
            style={colorScheme === 'dark' ? 'light' : 'dark'}
            translucent
            backgroundColor="transparent"
          />
          <View
            style={{
              flex: 1,
              backgroundColor: colorScheme === 'dark' ? '#0D0D0D' : '#FCFCFC',
            }}
          >
            <Stack
              screenOptions={{
                contentStyle: {
                  backgroundColor: colorScheme === 'dark' ? '#0D0D0D' : '#FCFCFC',
                },
              }}
            >
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen name="(auth)" options={{ headerShown: false }} />
              <Stack.Screen name="(root)" options={{ headerShown: false }} />
              <Stack.Screen name="+not-found" />
            </Stack>
          </View>
        </ThemedAlertProvider>
      </SafeAreaProvider>
    </SupabaseAuthProvider>
  );
}
