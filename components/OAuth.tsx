// components/OAuth.tsx
import React from 'react';
import { View, useColorScheme } from 'react-native';
import { themedAlert } from '@/components/ThemedAlert';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';

import CustomButton from '@/components/CustomButton';
import { googleOAuth } from '@/lib/auth';
import { useStore } from '@/store';

const OAuth = () => {
  const colorScheme = useColorScheme();
  const googleIconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';

  const isDownloading = useStore((s) => s.isDownloading);
  const downloadProgress = useStore((s) => s.downloadProgress);
  const cancelDownload = useStore((s) => s.cancelDownload);

  const handleGoogleSignIn = async () => {
    if (isDownloading) {
      Object.keys(downloadProgress).forEach((modelName) => {
        if (downloadProgress[modelName] < 1) {
          cancelDownload(modelName);
        }
      });
    }

    const result = await googleOAuth();

    if (result.success) {
      router.replace('/(root)/(tabs)/home');
    } else {
      themedAlert('Error', result.message);
    }
  };

  return (
    <View>
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
