// components/ChatHistoryModal.tsx
import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FlatList, Text, TouchableOpacity, View, Alert } from 'react-native';
import { useStore } from '@/store';
import { useRouter } from 'expo-router';

const ChatSessionsList = () => {
  const { chatSessions, switchToSession, removeSession, currentSessionId } =
    useStore();
  const router = useRouter();

  const handlePressSession = (sessionId: string) => {
    switchToSession(sessionId);
    router.push('/(root)/(tabs)/home');
  };

  const handleLongPressSession = (sessionId: string) => {
    Alert.alert(
      'Delete Chat',
      'Are you sure you want to delete this chat?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => removeSession(sessionId),
        },
      ],
      { cancelable: true }
    );
  };

  // Filter sessions that have at least one "User" message
  const sessionsWithUserMessage = chatSessions
    .filter((s) => s.messages.some((m) => m.sender === 'User'))
    .sort((a, b) => parseInt(b.id, 10) - parseInt(a.id, 10));

  const renderSessionItem = ({
    item,
  }: {
    item: (typeof sessionsWithUserMessage)[0];
  }) => {
    const isSelected = item.id === currentSessionId;
    return (
      <TouchableOpacity
        onPress={() => handlePressSession(item.id)}
        onLongPress={() => handleLongPressSession(item.id)}
        // Updated to set light mode = #FCFCFC, dark mode = #2F2F2F
        className={`px-4 py-4 ${isSelected ? 'bg-[#FCFCFC] dark:bg-[#2F2F2F]' : ''}`}
      >
        <Text
          className="text-[17px] text-black dark:text-white"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {item.title || '(Untitled chat)'}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-[#FCFCFC] dark:bg-[#0D0D0D]">
      {/* Main Content Container */}
      <View className="flex-1">
        {sessionsWithUserMessage.length === 0 ? (
          <View className="flex-1 items-center justify-center">
            <Text className="text-base text-black dark:text-white">
              No chats yet. Start one in Home!
            </Text>
          </View>
        ) : (
          <>
            {/* Header */}
            <View className="py-3 px-4">
              <Text className="text-lg font-bold text-black dark:text-white">
                Chats
              </Text>
            </View>
            <FlatList
              data={sessionsWithUserMessage}
              renderItem={renderSessionItem}
              keyExtractor={(session) => session.id}
              contentContainerStyle={{ paddingVertical: 8 }}
              showsVerticalScrollIndicator={false}
            />
          </>
        )}
      </View>
      {/* Footer with Version Number */}
      <View className="px-4 py-2">
        <Text className="text-xs text-gray-500 dark:text-gray-400 text-center">
          v1.2.7
        </Text>
      </View>
    </SafeAreaView>
  );
};

export default ChatSessionsList;
