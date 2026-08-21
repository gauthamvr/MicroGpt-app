// lib/auth.ts

import { supabase } from '@/lib/supabase';
import { createUserProfile } from '@/lib/supabase-api';
import { GoogleSignin } from '@react-native-google-signin/google-signin';

import {
  uniqueNamesGenerator,
  adjectives,
  animals,
  colors,
} from 'unique-names-generator';

GoogleSignin.configure({
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID!,
  // iOS needs its own OAuth client id (the forward, non-reversed form,
  // e.g. "1234-abcd.apps.googleusercontent.com"). Harmless/ignored on
  // Android, which authenticates via the webClientId + SHA-1 cert.
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
});

export const googleOAuth = async () => {
  try {
    await GoogleSignin.hasPlayServices();
    // Sign out of Google first so the account picker always shows
    await GoogleSignin.signOut();
    const signInResult = await GoogleSignin.signIn();

    const idToken = signInResult.data?.idToken;
    if (!idToken) {
      return {
        success: false,
        message: 'No ID token received from Google.',
      };
    }

    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'google',
      token: idToken,
    });

    if (error) {
      return {
        success: false,
        message: error.message,
      };
    }

    // If this is a new user, create their profile in the users table
    if (data.user) {
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('user_id', data.user.id)
        .single();

      if (!existingUser) {
        const randomUsername = uniqueNamesGenerator({
          dictionaries: [adjectives, colors, animals],
          separator: '-',
          length: 3,
        });

        const derivedFullName =
          data.user.user_metadata?.full_name ||
          data.user.email ||
          randomUsername;

        // Non-fatal: sign-in succeeds even if profile creation fails
        try {
          await createUserProfile({
            name: derivedFullName,
            email: data.user.email || '',
            username: randomUsername,
            displayName: randomUsername,
          });
        } catch (backendErr) {
          if (__DEV__) console.error('User profile creation failed:', backendErr);
        }
      }
    }

    return {
      success: true,
      code: 'success',
      message: 'You have successfully signed in with Google',
    };
  } catch (err: any) {
    if (__DEV__) console.error('googleOAuth error:', err);
    return {
      success: false,
      code: err.code,
      message: err?.message || 'Google sign-in failed.',
    };
  }
};
