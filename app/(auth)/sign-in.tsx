//app/(auth)/sign-in.tsx
import { useSignIn } from '@clerk/clerk-expo';
import { Link, router } from 'expo-router';
import React, { useState, useEffect } from 'react';
import { Alert, ScrollView, Text, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@clerk/clerk-expo'; // <-- For session check

import CustomButton from '@/components/CustomButton';
import InputField from '@/components/InputField';
import OAuth from '@/components/OAuth';
import { icons } from '@/constants';
// --- Download-cancel store imports ---
import { useStore } from '@/store'; // <-- ADD THIS

export default function SignIn() {
  const { signIn, setActive, isLoaded: isSignInLoaded } = useSignIn();
  const { isLoaded: isAuthLoaded, isSignedIn } = useAuth(); // <-- Session state
  const colorScheme = useColorScheme();
  const placeholderColor = colorScheme === 'dark' ? '#E6E6E6' : '#666666';

  const [form, setForm] = useState({
    email: '',
    password: '',
  });

  // --- Access store to cancel downloads if needed ---
  const { isDownloading, downloadProgress, cancelDownload } = useStore(); // <-- ADD THIS

  // If user is already signed in, skip the sign-in screen
  useEffect(() => {
    if (isAuthLoaded && isSignedIn) {
      router.replace('/(root)/(tabs)/home');
    }
  }, [isAuthLoaded, isSignedIn]);

  // While Clerk is checking session or signIn is not loaded, show nothing or a small loader
  if (!isAuthLoaded || !isSignInLoaded) {
    // Could return <ActivityIndicator/> or null
    return null;
  }

  // If we have a valid session, also render nothing (useEffect will navigate away)
  if (isSignedIn) {
    return null;
  }

  const onSignInPress = async () => {
    // --- Cancel any ongoing downloads before sign in ---
    if (isDownloading) {
      Object.keys(downloadProgress).forEach((modelName) => {
        if (downloadProgress[modelName] < 1) {
          cancelDownload(modelName);
        }
      });
    }

    try {
      const signInAttempt = await signIn.create({
        identifier: form.email,
        password: form.password,
      });

      if (signInAttempt.status === 'complete') {
        await setActive({ session: signInAttempt.createdSessionId });
        router.replace('/(root)/(tabs)/home');
      } else {
        // Optional: handle incomplete flow
        Alert.alert('Error', 'Log in failed. Please try again.');
      }
    } catch (err: any) {
      console.log(JSON.stringify(err, null, 2));
      Alert.alert('Error', err.errors?.[0]?.longMessage || 'Sign-in failed');
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
