// components/OAuth.tsx
import React from 'react';
import { Alert, View, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useOAuth } from '@clerk/clerk-expo';
import { router } from 'expo-router';

import CustomButton from '@/components/CustomButton';
import { googleOAuth } from '@/lib/auth';
import { useStore } from '@/store';

const OAuth = () => {
  // Initialize Clerk's useOAuth for Google
  const { startOAuthFlow } = useOAuth({ strategy: 'oauth_google' });

  // For theming the icon color
  const colorScheme = useColorScheme();
  const googleIconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';

  // Access your store to cancel downloads if needed
  const { isDownloading, downloadProgress, cancelDownload } = useStore();

  // Handler for Google sign-in
  const handleGoogleSignIn = async () => {
    // Cancel any ongoing downloads
    if (isDownloading) {
      Object.keys(downloadProgress).forEach((modelName) => {
        // If a model is not fully downloaded, cancel it
        if (downloadProgress[modelName] < 1) {
          cancelDownload(modelName);
        }
      });
    }

    // Proceed with the Google OAuth flow
    const result = await googleOAuth(startOAuthFlow);

    if (result.success) {
      router.replace('/(root)/(tabs)/home');
    } else {
      Alert.alert('Error', result.message);
    }
  };

  return (
    <View>
      {/* Any other UI elements here */}
      <View className="flex flex-row justify-center items-center mt-4 gap-x-3"></View>

      <CustomButton
        title="Continue with Google"
        className="mt-2 w-full shadow-none"
        onPress={handleGoogleSignIn}
        bgVariant="outline"
        textVariant="primary"
        IconLeft={() => (
          <Ionicons
            name="logo-google"
            size={20}
            color={googleIconColor}
            style={{ marginRight: 8 }}
          />
        )}
      />
    </View>
  );
};

export default OAuth;
