// app/(auth)/welcome.tsx
import React, { useEffect, useState } from 'react';
import { Text, Image, Linking } from 'react-native';
import { View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/lib/supabase';

import OAuth from '@/components/OAuth';
import CustomButton from '@/components/CustomButton';

export default function Welcome() {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useAuth();
  const colorScheme = useColorScheme();

  const [alreadyNavigated, setAlreadyNavigated] = useState(false);

  useEffect(() => {
    if (isLoaded && isSignedIn && !alreadyNavigated) {
      setAlreadyNavigated(true);
      router.replace('/(root)/(tabs)/home');
    }
  }, [isLoaded, isSignedIn, alreadyNavigated]);

  if (!isLoaded) {
    return null;
  }

  if (isSignedIn) {
    return null;
  }

  return (
    <SafeAreaView className="flex-1 bg-theme-light-background dark:bg-theme-dark-background">
      {/* Logo */}
      <View className="items-center mt-10">
        <Image
          source={require('@/assets/images/icon.png')}
          style={{ width: 100, height: 100, borderRadius: 50 }}
        />
      </View>

      {/* Title */}
      <Text className="text-2xl text-center text-theme-light-text-primary dark:text-theme-dark-text-primary mt-5 font-JakartaSemiBold px-4">
        Chat with millions of AI models
      </Text>

      <View className="flex-1" />

      {/* Bottom container */}
      <View className="bg-theme-light-background dark:bg-theme-dark-background rounded-t-3xl p-6">
        {/* Google OAuth button */}
        <OAuth />

        {/* Email Sign Up Button */}
        <CustomButton
          title="Sign up"
          onPress={() => router.push('/(auth)/sign-up')}
          bgVariant="outline"
          textVariant="primary"
          className="mt-5 w-full shadow-none"
        />

        {/* Email Log In Button */}
        <CustomButton
          title="Log in"
          onPress={() => router.push('/(auth)/sign-in')}
          bgVariant="outline"
          textVariant="primary"
          className="mt-5 w-full shadow-none"
        />

        {/* Terms / Footer */}
        <Text className="text-center text-xs text-gray-500 dark:text-gray-400 mt-4 px-4">
          By continuing, you agree to our{' '}
          <Text className="text-theme-light-text-primary dark:text-theme-dark-text-primary">
            Terms
          </Text>{' '}
          and acknowledge our{' '}
          <Text
            className="text-theme-light-text-primary dark:text-theme-dark-text-primary"
            onPress={() => Linking.openURL('https://meteormeta.com/privacy')}
          >
            Privacy Policy
          </Text>
          .
        </Text>
      </View>
    </SafeAreaView>
  );
}
