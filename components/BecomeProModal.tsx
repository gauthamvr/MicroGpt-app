// @/components/BecomeProModal.tsx
import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  useColorScheme,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
// import * as InAppPurchases from 'expo-in-app-purchases';

type BecomeProModalProps = {
  visible: boolean;
  onClose: () => void;
  onPurchaseSuccess: () => void;
};

export default function BecomeProModal({
  visible,
  onClose,
  onPurchaseSuccess,
}: BecomeProModalProps) {
  const colorScheme = useColorScheme();
  const cardBgColor = colorScheme === 'dark' ? '#333' : '#fff';
  const headingColor = colorScheme === 'dark' ? '#fff' : '#000';
  const [loading, setLoading] = useState(false);

  // Replace with your product id as set up in the Play Console
  const productId = 'pro_membership';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent={true}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.5)',
          justifyContent: 'center',
          alignItems: 'center',
          padding: 20,
        }}
      >
        <View
          style={{
            backgroundColor: cardBgColor,
            padding: 20,
            borderRadius: 8,
            width: '80%',
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
                color: headingColor,
              }}
            >
              Upgrade to Pro
            </Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons
                name="close-circle-outline"
                size={24}
                color={headingColor}
              />
            </TouchableOpacity>
          </View>

          <Text
            style={{
              fontSize: 16,
              color: headingColor,
              marginBottom: 12,
            }}
          >
            Unlock Pro features with a purchase.
          </Text>

          <TouchableOpacity onPress={onClose} style={{ alignSelf: 'flex-end' }}>
            <Text style={{ color: '#007AFF', fontWeight: 'bold' }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
