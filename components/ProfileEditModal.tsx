import React, { useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  TextInput,
  useColorScheme,
} from 'react-native';
import { themedAlert } from '@/components/ThemedAlert';
import { Ionicons } from '@expo/vector-icons';
import { updateUserProfile } from '@/lib/supabase-api';

type ProfileEditModalProps = {
  visible: boolean;
  onClose: () => void;
  initialUserData: {
    username: string;
    display_name: string;
    bio: string;
  };
  // Callback after successful update
  onUpdated: (updatedFields: {
    username?: string;
    display_name?: string;
    bio?: string;
  }) => void;
};

export default function ProfileEditModal({
  visible,
  onClose,
  initialUserData,
  onUpdated,
}: ProfileEditModalProps) {
  const colorScheme = useColorScheme();
  const [username, setUsername] = useState(initialUserData.username);
  const [displayName, setDisplayName] = useState(initialUserData.display_name);
  const [bio, setBio] = useState(initialUserData.bio);
  const [loading, setLoading] = useState(false);

  // For the pill-shaped button background/text color
  const buttonBg = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const buttonTextColor = colorScheme === 'dark' ? '#000000' : '#FFFFFF';

  const handleSave = async () => {
    setLoading(true);
    try {
      await updateUserProfile({
        username,
        display_name: displayName,
        bio,
      });
      onUpdated({ username, display_name: displayName, bio });
      onClose();
    } catch (err: any) {
      console.error('ProfileEditModal save error:', err);
      themedAlert('Error', err?.message || 'Failed to update profile');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent={true}
    >
      {/* Outer touchable => tapping here closes modal */}
      <TouchableOpacity
        onPress={onClose}
        activeOpacity={1}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.5)',
          justifyContent: 'center',
          padding: 20,
        }}
      >
        {/* Inner => tapping inside doesn't close */}
        <TouchableOpacity
          onPress={(e) => e.stopPropagation()}
          activeOpacity={1}
          style={{
            backgroundColor: colorScheme === 'dark' ? '#1C1C1E' : '#FFFFFF',
            borderRadius: 12,
            padding: 16,
          }}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              marginBottom: 12,
            }}
          >
            <Text
              style={{
                fontSize: 18,
                fontWeight: 'bold',
                color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
              }}
            >
              Edit Profile
            </Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons
                name="close-circle-outline"
                size={24}
                color={colorScheme === 'dark' ? '#FFFFFF' : '#000000'}
              />
            </TouchableOpacity>
          </View>

          {/* Username input */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
              marginBottom: 4,
            }}
          >
            Username (must be unique)
          </Text>
          <TextInput
            value={username}
            onChangeText={setUsername}
            style={{
              borderWidth: 1,
              borderColor: colorScheme === 'dark' ? '#444444' : '#CCCCCC',
              borderRadius: 6,
              padding: 8,
              marginBottom: 12,
              backgroundColor: colorScheme === 'dark' ? '#2C2C2E' : '#F5F5F5',
              color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
            }}
          />

          {/* Display Name input */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
              marginBottom: 4,
            }}
          >
            Display Name
          </Text>
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            style={{
              borderWidth: 1,
              borderColor: colorScheme === 'dark' ? '#444444' : '#CCCCCC',
              borderRadius: 6,
              padding: 8,
              marginBottom: 12,
              backgroundColor: colorScheme === 'dark' ? '#2C2C2E' : '#F5F5F5',
              color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
            }}
          />

          {/* Bio input */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
              marginBottom: 4,
            }}
          >
            Bio
          </Text>
          <TextInput
            value={bio}
            onChangeText={setBio}
            multiline
            style={{
              borderWidth: 1,
              borderColor: colorScheme === 'dark' ? '#444444' : '#CCCCCC',
              borderRadius: 6,
              padding: 8,
              marginBottom: 12,
              backgroundColor: colorScheme === 'dark' ? '#2C2C2E' : '#F5F5F5',
              color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
            }}
          />

          {/* Buttons row: Cancel | Save */}
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            {/* Cancel Button */}
            <TouchableOpacity
              onPress={onClose}
              style={{
                marginRight: 16,
                paddingVertical: 8,
                paddingHorizontal: 12,
              }}
            >
              <Text style={{ color: colorScheme === 'dark' ? '#888888' : '#888888' }}>Cancel</Text>
            </TouchableOpacity>

            {/* Save => pill-shaped */}
            <TouchableOpacity
              onPress={handleSave}
              disabled={loading}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 16,
                borderRadius: 999,
                backgroundColor: buttonBg,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Text
                style={{
                  color: buttonTextColor,
                  fontWeight: 'bold',
                }}
              >
                {loading ? 'Saving...' : 'Save'}
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}
