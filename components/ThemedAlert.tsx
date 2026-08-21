// components/ThemedAlert.tsx
// A global themed alert system that matches the app's dark/light mode.
// Can be called from anywhere (React components, Zustand store, etc.)

import React, { useState, useEffect, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  useColorScheme,
  StyleSheet,
} from 'react-native';

type AlertButton = {
  text: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
};

type AlertConfig = {
  title: string;
  message?: string;
  buttons?: AlertButton[];
};

// Global event emitter for alerts
type AlertListener = (config: AlertConfig) => void;
let _listener: AlertListener | null = null;

/**
 * Drop-in replacement for Alert.alert() that uses themed modals.
 * Works from anywhere -- React components, stores, utils.
 */
export function themedAlert(
  title: string,
  message?: string,
  buttons?: AlertButton[]
) {
  if (_listener) {
    _listener({ title, message, buttons });
  }
}

/**
 * Place this component once at the app root (inside _layout.tsx).
 * It listens for themedAlert() calls and renders themed modals.
 */
export function ThemedAlertProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [config, setConfig] = useState<AlertConfig | null>(null);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  useEffect(() => {
    _listener = (cfg) => {
      setConfig(cfg);
      setVisible(true);
    };
    return () => {
      _listener = null;
    };
  }, []);

  const handlePress = useCallback(
    (onPress?: () => void) => {
      setVisible(false);
      setConfig(null);
      onPress?.();
    },
    []
  );

  const bg = isDark ? '#1C1C1E' : '#FFFFFF';
  const overlayBg = 'rgba(0,0,0,0.5)';
  const titleColor = isDark ? '#FFFFFF' : '#000000';
  const messageColor = isDark ? '#ABABAB' : '#666666';
  const buttonBg = isDark ? '#2C2C2E' : '#F2F2F7';
  const buttonText = isDark ? '#0A84FF' : '#007AFF';
  const destructiveText = '#FF3B30';
  const cancelText = isDark ? '#ABABAB' : '#8E8E93';
  const dividerColor = isDark ? '#38383A' : '#E5E5EA';

  const buttons = config?.buttons?.length
    ? config.buttons
    : [{ text: 'OK', style: 'default' as const }];

  return (
    <>
      {children}
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={() => handlePress()}
        statusBarTranslucent
      >
        <View style={[styles.overlay, { backgroundColor: overlayBg }]}>
          <View style={[styles.container, { backgroundColor: bg }]}>
            {config?.title ? (
              <Text style={[styles.title, { color: titleColor }]}>
                {config.title}
              </Text>
            ) : null}
            {config?.message ? (
              <Text style={[styles.message, { color: messageColor }]}>
                {config.message}
              </Text>
            ) : null}

            <View style={[styles.divider, { backgroundColor: dividerColor }]} />

            <View style={buttons.length > 2 ? styles.buttonsVertical : styles.buttonsRow}>
              {buttons.map((btn, i) => {
                const isCancel = btn.style === 'cancel';
                const isDestructive = btn.style === 'destructive';
                const color = isDestructive
                  ? destructiveText
                  : isCancel
                    ? cancelText
                    : buttonText;
                const fontWeight = isCancel ? '400' : '600';

                return (
                  <React.Fragment key={i}>
                    {i > 0 && buttons.length <= 2 && (
                      <View
                        style={[
                          styles.verticalDivider,
                          { backgroundColor: dividerColor },
                        ]}
                      />
                    )}
                    {i > 0 && buttons.length > 2 && (
                      <View
                        style={[
                          styles.divider,
                          { backgroundColor: dividerColor },
                        ]}
                      />
                    )}
                    <TouchableOpacity
                      onPress={() => handlePress(btn.onPress)}
                      style={[
                        buttons.length <= 2
                          ? styles.buttonHorizontal
                          : styles.buttonVertical,
                      ]}
                      activeOpacity={0.6}
                    >
                      <Text
                        style={[
                          styles.buttonText,
                          {
                            color,
                            fontWeight: fontWeight as any,
                          },
                        ]}
                      >
                        {btn.text}
                      </Text>
                    </TouchableOpacity>
                  </React.Fragment>
                );
              })}
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  container: {
    width: '100%',
    maxWidth: 320,
    borderRadius: 14,
    overflow: 'hidden',
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
    paddingTop: 20,
    paddingHorizontal: 20,
  },
  message: {
    fontSize: 13,
    textAlign: 'center',
    paddingTop: 8,
    paddingBottom: 20,
    paddingHorizontal: 20,
    lineHeight: 18,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  verticalDivider: {
    width: StyleSheet.hairlineWidth,
    height: '100%',
  },
  buttonsRow: {
    flexDirection: 'row',
  },
  buttonsVertical: {
    flexDirection: 'column',
  },
  buttonHorizontal: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonVertical: {
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: 17,
  },
});
