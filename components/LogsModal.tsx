// components/LogsModal.tsx
//
// In-app viewer for the log-store ring buffer. Lets the user inspect
// recent console output (the only way to see app logs without dev mode +
// adb on stock Android) and copy / share it. Kept deliberately simple —
// no filtering UI, no search; if the buffer overflows the user just sees
// the last MAX_ENTRIES lines.

import React, { useSyncExternalStore } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Share,
  useColorScheme,
  Pressable,
  Platform,
} from 'react-native';
import { themedAlert } from '@/components/ThemedAlert';
import {
  LogEntry,
  clearLogs,
  formatLogsForShare,
  getLogEntries,
  subscribeLogs,
} from '@/lib/log-store';

// useSyncExternalStore requires the snapshot reference to be stable
// when nothing has changed. log-store guarantees this — the entries
// array is replaced atomically per push, never mutated in place. So
// `getLogEntries` works directly as both the subscribe callback's
// snapshot getter and the server snapshot.

interface LogsModalProps {
  visible: boolean;
  onClose: () => void;
}

const LEVEL_COLORS_DARK: Record<LogEntry['level'], string> = {
  log: '#9CA3AF',
  info: '#9CA3AF',
  warn: '#FBBF24',
  error: '#F87171',
};
const LEVEL_COLORS_LIGHT: Record<LogEntry['level'], string> = {
  log: '#374151',
  info: '#374151',
  warn: '#B45309',
  error: '#B91C1C',
};

const LogsModal: React.FC<LogsModalProps> = ({ visible, onClose }) => {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  // useSyncExternalStore subscribes only this modal to log-store
  // changes. The rest of the app doesn't re-render when new lines
  // come in. When the modal isn't visible, React unmounts it via
  // the conditional render below — no subscription overhead.
  const entries = useSyncExternalStore(subscribeLogs, getLogEntries, getLogEntries);

  const buttonBg = isDark ? '#FFFFFF' : '#000000';
  const buttonText = isDark ? '#000000' : '#FFFFFF';
  const cardBg = isDark ? '#1C1C1E' : '#FFFFFF';
  const textColor = isDark ? '#E5E7EB' : '#1F2937';
  const subText = isDark ? '#9CA3AF' : '#6B7280';
  const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

  const handleShare = async () => {
    const text = formatLogsForShare();
    if (!text) {
      themedAlert('Nothing to share', 'No log entries captured yet.');
      return;
    }
    try {
      await Share.share({ message: text });
    } catch {
      // User cancelled — no-op
    }
  };

  const handleClear = () => {
    themedAlert('Clear logs?', `This wipes ${entries.length} captured entries.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => clearLogs() },
    ]);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      hardwareAccelerated
    >
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.5)',
          justifyContent: 'center',
          alignItems: 'center',
          padding: 16,
        }}
      >
        <Pressable
          onPress={onClose}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <View
          style={{
            width: '94%',
            maxHeight: '88%',
            borderRadius: 12,
            backgroundColor: cardBg,
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 16,
              paddingTop: 16,
              paddingBottom: 12,
            }}
          >
            <Text style={{ color: textColor, fontSize: 18, fontWeight: '700' }}>
              App Logs
            </Text>
            <Text style={{ color: subText, fontSize: 12 }}>
              {entries.length} entries
            </Text>
          </View>

          {/* Log content */}
          <ScrollView
            style={{
              flex: 1,
              backgroundColor: isDark ? '#0B0B0D' : '#F3F4F6',
              paddingHorizontal: 12,
              paddingVertical: 8,
            }}
            contentContainerStyle={{ paddingBottom: 16 }}
          >
            {entries.length === 0 ? (
              <Text style={{ color: subText, fontSize: 13, fontStyle: 'italic' }}>
                No log entries yet. Trigger something in the app and reopen this view.
              </Text>
            ) : (
              entries.map((e, i) => {
                const t = new Date(e.ts);
                const hh = String(t.getHours()).padStart(2, '0');
                const mm = String(t.getMinutes()).padStart(2, '0');
                const ss = String(t.getSeconds()).padStart(2, '0');
                const ms = String(t.getMilliseconds()).padStart(3, '0');
                const time = `${hh}:${mm}:${ss}.${ms}`;
                const color =
                  (isDark ? LEVEL_COLORS_DARK : LEVEL_COLORS_LIGHT)[e.level] ?? textColor;
                return (
                  <Text
                    key={i}
                    selectable
                    style={{
                      color,
                      fontSize: 11,
                      fontFamily: monoFont,
                      marginBottom: 2,
                    }}
                  >
                    <Text style={{ color: subText }}>{time} </Text>
                    <Text style={{ fontWeight: '700' }}>{e.level.toUpperCase()}</Text>
                    {' '}
                    {e.message}
                  </Text>
                );
              })
            )}
          </ScrollView>

          {/* Footer actions */}
          <View
            style={{
              flexDirection: 'row',
              padding: 12,
              gap: 8,
              borderTopWidth: 1,
              borderTopColor: isDark ? '#2A2A2D' : '#E5E7EB',
            }}
          >
            <TouchableOpacity
              onPress={handleClear}
              style={{
                flex: 1,
                paddingVertical: 10,
                borderRadius: 8,
                alignItems: 'center',
                backgroundColor: isDark ? '#2A2A2D' : '#F3F4F6',
              }}
            >
              <Text style={{ color: textColor, fontWeight: '600' }}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleShare}
              style={{
                flex: 2,
                paddingVertical: 10,
                borderRadius: 8,
                alignItems: 'center',
                backgroundColor: buttonBg,
              }}
            >
              <Text style={{ color: buttonText, fontWeight: '700' }}>
                Copy / Share
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onClose}
              style={{
                flex: 1,
                paddingVertical: 10,
                borderRadius: 8,
                alignItems: 'center',
                backgroundColor: isDark ? '#2A2A2D' : '#F3F4F6',
              }}
            >
              <Text style={{ color: textColor, fontWeight: '600' }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

export default LogsModal;
