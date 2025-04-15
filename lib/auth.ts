// lib/auth.ts

import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';
import { BACKEND_URL } from '@/constants';
import { fetchAPI } from '@/lib/fetch';

// 1) Import the username generator
import {
  uniqueNamesGenerator,
  adjectives,
  animals,
  colors,
} from 'unique-names-generator';

export const tokenCache = {
  async getToken(key: string) {
    try {
      const item = await SecureStore.getItemAsync(key);
      if (item) {
        // console.log(`${key} was used 🔐 \n`);
      } else {
        // console.log('No values stored under key: ' + key);
      }
      return item;
    } catch (error) {
      console.error('SecureStore get item error: ', error);
      await SecureStore.deleteItemAsync(key);
      return null;
    }
  },
  async saveToken(key: string, value: string) {
    try {
      return SecureStore.setItemAsync(key, value);
    } catch (err) {
      return;
    }
  },
};

const BACKEND = BACKEND_URL;

export const googleOAuth = async (startOAuthFlow: any) => {
  try {
    const { createdSessionId, setActive, signUp } = await startOAuthFlow({
      redirectUrl: Linking.createURL('(root)/(tabs)/home'),
    });

    if (createdSessionId) {
      if (setActive) {
        // 1) Set this as the active session
        await setActive({ session: createdSessionId });

        // 2) If it's a brand-new user, Clerk provides `signUp.createdUserId`
        if (signUp.createdUserId) {
          // Generate a random username
          const randomUsername = uniqueNamesGenerator({
            dictionaries: [adjectives, colors, animals],
            separator: '-',
            length: 3,
          });

          // Attempt to build a "name" from first/last; fallback to email if empty
          const derivedFullName =
            `${signUp.firstName ?? ''} ${signUp.lastName ?? ''}`.trim() ||
            signUp.emailAddress;

          // Create the user in your Express backend with username + displayName
          await fetchAPI(`${BACKEND}/users`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: derivedFullName,
              email: signUp.emailAddress,
              clerkId: signUp.createdUserId,
              username: randomUsername,
              displayName: randomUsername,
            }),
          });
        }

        return {
          success: true,
          code: 'success',
          message: 'You have successfully signed in with Google',
        };
      }
    }

    return {
      success: false,
      message: 'An error occurred while signing in with Google',
    };
  } catch (err: any) {
    console.error('googleOAuth error:', err);
    return {
      success: false,
      code: err.code,
      message: err?.errors?.[0]?.longMessage || 'Google sign-in failed.',
    };
  }
};
