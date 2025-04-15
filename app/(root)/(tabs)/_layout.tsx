//app/(root)/(tabs)/layout.tsx

import { Tabs, useRouter } from 'expo-router';
import { Image, ImageSourcePropType, View } from 'react-native';
import { useUser } from '@clerk/clerk-expo';
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
  const { user, isLoaded } = useUser();
  const router = useRouter();
  const isSignedIn = isLoaded && user != null;
  const colorScheme = useColorScheme() || 'light';

  useEffect(() => {
    // Additional side effects if needed
  }, [isSignedIn]);

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
            height: 60, // Tab bar height
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
