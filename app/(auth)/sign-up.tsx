// app/(auth)/sign-up.tsx
import { useSignUp } from '@clerk/clerk-expo';
import { Link, router } from 'expo-router';
import React, { useState, useEffect } from 'react';
import { Alert, ScrollView, Text, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ReactNativeModal } from 'react-native-modal';
import { useAuth } from '@clerk/clerk-expo'; // <-- For session check

import CustomButton from '@/components/CustomButton';
import InputField from '@/components/InputField';
import OAuth from '@/components/OAuth';
import { icons } from '@/constants';
import { fetchAPI } from '@/lib/fetch';
import { BACKEND_URL } from '@/constants';

import {
  uniqueNamesGenerator,
  adjectives,
  animals,
  colors,
} from 'unique-names-generator';

// --- Download-cancel store imports ---
import { useStore } from '@/store'; // <-- ADD THIS

const BACKEND = BACKEND_URL;

export default function SignUp() {
  const { isLoaded: isSignUpLoaded, signUp, setActive } = useSignUp();
  const { isLoaded: isAuthLoaded, isSignedIn } = useAuth(); // <-- Session state
  const colorScheme = useColorScheme();
  const placeholderColor = colorScheme === 'dark' ? '#E6E6E6' : '#666666';

  const [form, setForm] = useState({
    email: '',
    password: '',
    username: '',
  });

  const [verification, setVerification] = useState({
    state: 'default',
    error: '',
    code: '',
  });

  // --- Access store to cancel downloads if needed ---
  const { isDownloading, downloadProgress, cancelDownload } = useStore(); // <-- ADD THIS

  // Immediately generate a random username on mount
  useEffect(() => {
    const randomUsername = uniqueNamesGenerator({
      dictionaries: [adjectives, colors, animals],
      separator: '-',
      length: 3,
    });
    setForm((prev) => ({ ...prev, username: randomUsername }));
  }, []);

  // If user is already signed in, skip the sign-up screen
  useEffect(() => {
    if (isAuthLoaded && isSignedIn) {
      router.replace('/(root)/(tabs)/home');
    }
  }, [isAuthLoaded, isSignedIn]);

  // If Clerk is not loaded or signUp hook is not loaded, show null or a small loader
  if (!isAuthLoaded || !isSignUpLoaded) {
    return null;
  }

  // If user is already signed in, also return null; useEffect will navigate away
  if (isSignedIn) {
    return null;
  }

  const onSignUpPress = async () => {
    // --- Cancel any ongoing downloads before sign up ---
    if (isDownloading) {
      Object.keys(downloadProgress).forEach((modelName) => {
        if (downloadProgress[modelName] < 1) {
          cancelDownload(modelName);
        }
      });
    }

    try {
      // 1) Create the user in Clerk
      await signUp.create({
        emailAddress: form.email,
        password: form.password,
      });

      // 2) Request an email verification code
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setVerification((prev) => ({ ...prev, state: 'pending' }));
    } catch (err: any) {
      console.log(JSON.stringify(err, null, 2));
      Alert.alert(
        'Error',
        err.errors?.[0]?.longMessage || 'Something went wrong'
      );
    }
  };

  const onPressVerify = async () => {
    try {
      // 1) Attempt the code verification in Clerk
      const completeSignUp = await signUp.attemptEmailAddressVerification({
        code: verification.code,
      });

      if (completeSignUp.status === 'complete') {
        // 2) Insert user data in your DB
        const bodyPayload = {
          email: form.email,
          clerkId: completeSignUp.createdUserId,
          username: form.username,
          displayName: form.username,
        };

        await fetchAPI(`${BACKEND}/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyPayload),
        });

        // 3) Set the active session => user is signed in
        await setActive({ session: completeSignUp.createdSessionId });

        // Navigate to home
        router.replace('/(root)/(tabs)/home');
      } else {
        setVerification({
          ...verification,
          error: 'Verification failed. Please try again.',
          state: 'failed',
        });
      }
    } catch (err: any) {
      setVerification({
        ...verification,
        error: err.errors?.[0]?.longMessage || 'Something went wrong',
        state: 'failed',
      });
    }
  };

  return (
    <ScrollView className="flex-1 bg-theme-light-background dark:bg-theme-dark-background">
      <SafeAreaView className="flex-1 bg-theme-light-background dark:bg-theme-dark-background">
        <View className="relative w-full h-[150px]">
          <Text className="text-2xl text-theme-light-text-primary dark:text-theme-dark-text-primary font-JakartaSemiBold absolute bottom-5 left-5">
            Create Your Account
          </Text>
        </View>

        <View className="p-5">
          {/* Email Field */}
          <InputField
            label="Email"
            placeholder="Enter email"
            placeholderTextColor={placeholderColor}
            icon={icons.person}
            textContentType="emailAddress"
            value={form.email}
            onChangeText={(value) => setForm({ ...form, email: value })}
          />

          {/* Password Field */}
          <InputField
            label="Password"
            placeholder="Enter password"
            placeholderTextColor={placeholderColor}
            icon={icons.lock}
            secureTextEntry
            textContentType="password"
            value={form.password}
            onChangeText={(value) => setForm({ ...form, password: value })}
          />

          <CustomButton
            title="Sign Up"
            onPress={onSignUpPress}
            className="mt-14"
          />

          <OAuth />

          <Link
            href="/sign-in"
            className="text-lg text-center text-general-200 mt-10"
          >
            Already have an account?{' '}
            <Text className="text-theme-light-text-primary dark:text-theme-dark-text-primary">
              Log In
            </Text>
          </Link>
        </View>

        {/* Verification Modal */}
        <ReactNativeModal isVisible={verification.state === 'pending'}>
          <View className="bg-theme-light-background dark:bg-theme-dark-background px-7 py-9 rounded-2xl min-h-[300px]">
            <Text className="font-JakartaExtraBold text-2xl mb-2 text-theme-light-text-primary dark:text-theme-dark-text-primary">
              Verification
            </Text>
            <Text className="font-Jakarta mb-5 text-theme-light-text-secondary dark:text-theme-dark-text-secondary">
              We&apos;ve sent a verification code to {form.email}.
            </Text>
            <InputField
              label="Code"
              icon={icons.lock}
              placeholder="12345"
              placeholderTextColor={placeholderColor}
              keyboardType="numeric"
              value={verification.code}
              onChangeText={(code) =>
                setVerification({ ...verification, code })
              }
            />
            {verification.error ? (
              <Text className="text-red-500 text-sm mt-1">
                {verification.error}
              </Text>
            ) : null}

            <CustomButton
              title="Verify Email"
              onPress={onPressVerify}
              className="mt-5 bg-success-500"
            />
          </View>
        </ReactNativeModal>
      </SafeAreaView>
    </ScrollView>
  );
}
