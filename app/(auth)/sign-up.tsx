// app/(auth)/sign-up.tsx
import { Link, router } from 'expo-router';
import React, { useState, useEffect } from 'react';
import { ScrollView, Text, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { themedAlert } from '@/components/ThemedAlert';
import { ReactNativeModal } from 'react-native-modal';
import { useAuth } from '@/lib/supabase';
import { supabase } from '@/lib/supabase';
import { createUserProfile } from '@/lib/supabase-api';

import CustomButton from '@/components/CustomButton';
import InputField from '@/components/InputField';
import OAuth from '@/components/OAuth';
import { icons } from '@/constants';

import {
  uniqueNamesGenerator,
  adjectives,
  animals,
  colors,
} from 'unique-names-generator';

// --- Download-cancel store imports ---
import { useStore } from '@/store';

export default function SignUp() {
  const { isLoaded, isSignedIn } = useAuth();
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

  const isDownloading = useStore((s) => s.isDownloading);
  const downloadProgress = useStore((s) => s.downloadProgress);
  const cancelDownload = useStore((s) => s.cancelDownload);

  // Generate a random username on mount
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

  const onSignUpPress = async () => {
    if (isDownloading) {
      Object.keys(downloadProgress).forEach((modelName) => {
        if (downloadProgress[modelName] < 1) {
          cancelDownload(modelName);
        }
      });
    }

    try {
      const { error } = await supabase.auth.signUp({
        email: form.email,
        password: form.password,
      });

      if (error) {
        themedAlert('Error', error.message);
        return;
      }

      // Show verification modal - Supabase will send an OTP email
      setVerification((prev) => ({ ...prev, state: 'pending' }));
    } catch (err: any) {
      themedAlert(
        'Error',
        err.message || 'Something went wrong'
      );
    }
  };

  const onPressVerify = async () => {
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: form.email,
        token: verification.code,
        type: 'signup',
      });

      if (error) {
        setVerification({
          ...verification,
          error: error.message,
          state: 'failed',
        });
        return;
      }

      if (data.session) {
        // Create backend user profile (non-fatal)
        try {
          await createUserProfile({
            name: form.username,
            email: form.email,
            username: form.username,
            displayName: form.username,
          });
        } catch (backendErr) {
          if (__DEV__) console.error('User profile creation failed:', backendErr);
        }

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
        error: err.message || 'Something went wrong',
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
