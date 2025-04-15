import React, { useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  TextInput,
  Alert,
  useColorScheme,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BACKEND_URL } from '@/constants';
import { fetchAPI } from '@/lib/fetch';

type ProfileEditModalProps = {
  visible: boolean;
  onClose: () => void;
  initialUserData: {
    clerk_id: string;
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
      await fetchAPI(`${BACKEND_URL}/users/${initialUserData.clerk_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          display_name: displayName,
          bio,
        }),
      });
      onUpdated({ username, display_name: displayName, bio });
      onClose();
    } catch (err: any) {
      console.error('ProfileEditModal save error:', err);
      Alert.alert('Error', err?.error || 'Failed to update profile');
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
      statusBarTranslucent={true} // covers status bar area on Android
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
            backgroundColor: colorScheme === 'dark' ? '#333' : '#fff',
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
                color: colorScheme === 'dark' ? '#fff' : '#000',
              }}
            >
              Edit Profile
            </Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons
                name="close-circle-outline"
                size={24}
                color={colorScheme === 'dark' ? '#fff' : '#000'}
              />
            </TouchableOpacity>
          </View>

          {/* Username input */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#ccc' : '#555',
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
              borderColor: '#ccc',
              borderRadius: 6,
              padding: 8,
              marginBottom: 12,
              color: colorScheme === 'dark' ? '#fff' : '#000',
            }}
          />

          {/* Display Name input */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#ccc' : '#555',
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
              borderColor: '#ccc',
              borderRadius: 6,
              padding: 8,
              marginBottom: 12,
              color: colorScheme === 'dark' ? '#fff' : '#000',
            }}
          />

          {/* Bio input */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#ccc' : '#555',
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
              borderColor: '#ccc',
              borderRadius: 6,
              padding: 8,
              marginBottom: 12,
              color: colorScheme === 'dark' ? '#fff' : '#000',
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
              <Text style={{ color: '#888' }}>Cancel</Text>
            </TouchableOpacity>

            {/* Save => pill-shaped. If loading, label is "Saving..." */}
            <TouchableOpacity
              onPress={handleSave}
              disabled={loading}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 16,
                borderRadius: 999, // pill shape
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
