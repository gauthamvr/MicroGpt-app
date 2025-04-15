// File: components/ModelSettingsModal.tsx

import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  useColorScheme,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface GenerationSettings {
  contextLength: number;
  temperature: number;
  topP: number;
}

interface ModelSettingsModalProps {
  visible: boolean;
  onClose: () => void;
  initialSettings: GenerationSettings;
  onSave: (updated: GenerationSettings) => void;
}

const ModelSettingsModal: React.FC<ModelSettingsModalProps> = ({
  visible,
  onClose,
  initialSettings,
  onSave,
}) => {
  const colorScheme = useColorScheme();

  // For the pill-shaped button background/text color
  const buttonBg = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const buttonTextColor = colorScheme === 'dark' ? '#000000' : '#FFFFFF';

  const [contextLength, setContextLength] = useState(
    initialSettings.contextLength.toString()
  );
  const [temperature, setTemperature] = useState(
    initialSettings.temperature.toString()
  );
  const [topP, setTopP] = useState(initialSettings.topP.toString());

  const handleSave = () => {
    const parsedContext = parseInt(contextLength, 10);
    const parsedTemp = parseFloat(temperature);
    const parsedTopP = parseFloat(topP);

    if (
      isNaN(parsedContext) ||
      isNaN(parsedTemp) ||
      isNaN(parsedTopP) ||
      parsedContext < 1 ||
      parsedTemp < 0 ||
      parsedTemp > 2 ||
      parsedTopP < 0 ||
      parsedTopP > 1
    ) {
      Alert.alert(
        'Invalid Input',
        'Please ensure all fields have valid numeric values.'
      );
      return;
    }

    onSave({
      contextLength: parsedContext,
      temperature: parsedTemp,
      topP: parsedTopP,
    });
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent={true} // covers status bar area on Android
    >
      {/* Outer layer => tapping here closes modal */}
      <TouchableOpacity
        onPress={onClose}
        activeOpacity={1}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.5)',
          justifyContent: 'center',
          alignItems: 'center',
          padding: 16,
        }}
      >
        {/* Inner layer => tapping inside doesn't close */}
        <TouchableOpacity
          onPress={(e) => e.stopPropagation()}
          activeOpacity={1}
          style={{
            width: '90%',
            padding: 16,
            borderRadius: 12,
            backgroundColor: colorScheme === 'dark' ? '#333' : '#fff',
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
              Generation Settings
            </Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons
                name="close-circle-outline"
                size={24}
                color={colorScheme === 'dark' ? '#fff' : '#000'}
              />
            </TouchableOpacity>
          </View>

          {/* Context Length */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#ccc' : '#333',
              marginBottom: 4,
            }}
          >
            Context Length
          </Text>
          <TextInput
            value={contextLength}
            onChangeText={setContextLength}
            keyboardType="number-pad"
            style={{
              borderWidth: 1,
              borderColor: '#ccc',
              borderRadius: 6,
              padding: 8,
              marginBottom: 12,
              color: colorScheme === 'dark' ? '#fff' : '#000',
            }}
          />

          {/* Temperature */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#ccc' : '#333',
              marginBottom: 4,
            }}
          >
            Temperature
          </Text>
          <TextInput
            value={temperature}
            onChangeText={setTemperature}
            keyboardType="decimal-pad"
            style={{
              borderWidth: 1,
              borderColor: '#ccc',
              borderRadius: 6,
              padding: 8,
              marginBottom: 12,
              color: colorScheme === 'dark' ? '#fff' : '#000',
            }}
          />

          {/* Top P */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#ccc' : '#333',
              marginBottom: 4,
            }}
          >
            Top P
          </Text>
          <TextInput
            value={topP}
            onChangeText={setTopP}
            keyboardType="decimal-pad"
            style={{
              borderWidth: 1,
              borderColor: '#ccc',
              borderRadius: 6,
              padding: 8,
              marginBottom: 12,
              color: colorScheme === 'dark' ? '#fff' : '#000',
            }}
          />

          {/* Footer Buttons (Cancel | Save) */}
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            {/* Cancel Button */}
            <TouchableOpacity
              onPress={onClose}
              style={{
                marginRight: 16,
                paddingVertical: 8,
                paddingHorizontal: 16,
              }}
            >
              <Text style={{ color: '#888' }}>Cancel</Text>
            </TouchableOpacity>

            {/* Save => pill-shaped like "Use Model" */}
            <TouchableOpacity
              onPress={handleSave}
              disabled={false}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 16,
                borderRadius: 999, // pill shape
                backgroundColor: buttonBg,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Text style={{ color: buttonTextColor, fontWeight: 'bold' }}>
                Save
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

export default ModelSettingsModal;
