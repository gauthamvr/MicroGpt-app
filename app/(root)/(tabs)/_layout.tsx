// //app/(root)/(tabs)/layout.tsx

import { Tabs, useRouter } from 'expo-router';
import { Image, ImageSourcePropType, View } from 'react-native';
import { useAuth } from '@/lib/supabase';
import { icons } from '@/constants';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

const getTintColor = (focused: boolean, colorScheme: string) => {
  if (focused) {
    return colorScheme === 'dark' ? '#E6E6E6' : '#0D0D0D';
  } else {
    return colorScheme === 'dark' ? '#9BA1A6' : '#9CA3AF';
  }
};

const TabIcon = ({
  source,
  focused,
  colorScheme,
}: {
  source: ImageSourcePropType;
  focused: boolean;
  colorScheme: string;
}) => {
  const tintColor = getTintColor(focused, colorScheme);

  return (
    <View className="flex-1 justify-center items-center pt-2">
      <Image
        source={source}
        style={{ width: 24, height: 24, tintColor }}
        resizeMode="contain"
      />
    </View>
  );
};

export default function Layout() {
  const { isSignedIn, isLoaded } = useAuth();
  const router = useRouter();
  const colorScheme = useColorScheme() || 'light';

  useEffect(() => {
    /* extra side-effects can go here if needed */
  }, [isSignedIn, isLoaded]);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colorScheme === 'dark' ? '#0D0D0D' : '#FCFCFC',
      }}
    >
      <Tabs
        initialRouteName="home"
        screenOptions={{
          tabBarShowLabel: false,
          tabBarStyle: {
            backgroundColor: colorScheme === 'dark' ? '#0D0D0D' : '#FCFCFC',
            borderTopWidth: 0,
            elevation: 0,
            height: 60,
          },
        }}
      >
        <Tabs.Screen
          name="home"
          options={{
            headerShown: false,
            tabBarIcon: ({ focused }) => (
              <TabIcon
                source={icons.home}
                focused={focused}
                colorScheme={colorScheme}
              />
            ),
          }}
        />

        <Tabs.Screen
          name="explore"
          options={{
            headerShown: false,
            tabBarIcon: ({ focused }) => (
              <TabIcon
                source={icons.list}
                focused={focused}
                colorScheme={colorScheme}
              />
            ),
          }}
        />

        <Tabs.Screen
          name="chat"
          options={{
            headerShown: false,
            tabBarIcon: ({ focused }) => (
              <TabIcon
                source={icons.chat}
                focused={focused}
                colorScheme={colorScheme}
              />
            ),
          }}
          listeners={{
            tabPress: (e) => {
              if (!isSignedIn) {
                e.preventDefault();
                router.push('/(auth)/welcome');
              }
            },
          }}
        />

        <Tabs.Screen
          name="profile"
          options={{
            headerShown: false,
            tabBarIcon: ({ focused }) => (
              <TabIcon
                source={icons.profile}
                focused={focused}
                colorScheme={colorScheme}
              />
            ),
          }}
          listeners={{
            tabPress: (e) => {
              if (!isSignedIn) {
                e.preventDefault();
                router.push('/(auth)/welcome');
              }
            },
          }}
        />
      </Tabs>
    </View>
  );
}
