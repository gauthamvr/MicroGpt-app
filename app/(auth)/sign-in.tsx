//app/(auth)/sign-in.tsx
import { Link, router } from 'expo-router';
import React, { useState, useEffect } from 'react';
import { ScrollView, Text, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { themedAlert } from '@/components/ThemedAlert';
import { useAuth } from '@/lib/supabase';
import { supabase } from '@/lib/supabase';

import CustomButton from '@/components/CustomButton';
import InputField from '@/components/InputField';
import OAuth from '@/components/OAuth';
import { icons } from '@/constants';
// --- Download-cancel store imports ---
import { useStore } from '@/store';

export default function SignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const colorScheme = useColorScheme();
  const placeholderColor = colorScheme === 'dark' ? '#E6E6E6' : '#666666';

  const [form, setForm] = useState({
    email: '',
    password: '',
  });

  const isDownloading = useStore((s) => s.isDownloading);
  const downloadProgress = useStore((s) => s.downloadProgress);
  const cancelDownload = useStore((s) => s.cancelDownload);

  // If user is already signed in, skip the sign-in screen
  useEffect(() => {
    if (isLoaded && isSignedIn) {
      router.replace('/(root)/(tabs)/home');
    }
  }, [isLoaded, isSignedIn]);

  if (!isLoaded) {
    return null;
  }

  if (isSignedIn) {
    return null;
  }

  const onSignInPress = async () => {
    if (isDownloading) {
      Object.keys(downloadProgress).forEach((modelName) => {
        if (downloadProgress[modelName] < 1) {
          cancelDownload(modelName);
        }
      });
    }

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: form.email,
        password: form.password,
      });

      if (error) {
        themedAlert('Error', error.message);
        return;
      }

      router.replace('/(root)/(tabs)/home');
    } catch (err: any) {
      themedAlert('Error', err.message || 'Sign-in failed');
    }
  };

  return (
    <ScrollView className="flex-1 bg-theme-light-background dark:bg-theme-dark-background">
      <SafeAreaView className="flex-1 bg-theme-light-background dark:bg-theme-dark-background">
        {/* Top Banner / Greeting */}
        <View className="relative w-full h-[200px]">
          <Text className="text-2xl text-theme-light-text-primary dark:text-theme-dark-text-primary font-JakartaSemiBold absolute bottom-5 left-5">
            Welcome
          </Text>
        </View>

        {/* Form Section */}
        <View className="p-5">
          <InputField
            label="Email"
            placeholder="Enter email"
            placeholderTextColor={placeholderColor}
            icon={icons.person}
            textContentType="emailAddress"
            value={form.email}
            onChangeText={(value) => setForm({ ...form, email: value })}
          />

          <InputField
            label="Password"
            placeholder="Enter password"
            placeholderTextColor={placeholderColor}
            icon={icons.lock}
            secureTextEntry={true}
            textContentType="password"
            value={form.password}
            onChangeText={(value) => setForm({ ...form, password: value })}
          />

          <CustomButton
            title="Sign In"
            onPress={onSignInPress}
            className="mt-14"
          />

          <OAuth />

          <Link
            href="/sign-up"
            className="text-lg text-center text-general-200 mt-10"
          >
            Don't have an account?{' '}
            <Text className="text-theme-light-text-primary dark:text-theme-dark-text-primary">
              Sign Up
            </Text>
          </Link>
        </View>
      </SafeAreaView>
    </ScrollView>
  );
}
