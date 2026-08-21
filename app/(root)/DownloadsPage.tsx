// app/(root)/DownloadsPage.tsx

import React, { useCallback, useState } from 'react';
import {
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  useColorScheme,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { themedAlert } from '@/components/ThemedAlert';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import {
  useStore,
  formatBytes,
  formatEta,
  isImageGenModel,
  getModelFileName,
} from '@/store';

// Tiny "1.57 GB" / "320 MB" → bytes parser. Decimal units to match
// HuggingFace size strings (so paused-row math lines up with the
// catalog's published size). Returns 0 when the string is missing or
// unparseable — callers fall back to "X downloaded" without a total.
function parseSizeStringToBytes(s?: string): number {
  if (!s) return 0;
  const m = s.match(/([\d.]+)\s*(GB|MB|KB)/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  if (u === 'GB') return v * 1_000_000_000;
  if (u === 'MB') return v * 1_000_000;
  if (u === 'KB') return v * 1_000;
  return 0;
}

// Lazy-load the local native download module so this page still loads on
// iOS / dev builds where autolinking missed it. Mirrors the guard in
// store/useModelsSlice.ts.
let ExpoDownloadManager: typeof import('expo-download-manager') | null = null;
try {
  if (Platform.OS === 'android') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ExpoDownloadManager = require('expo-download-manager');
  }
} catch {
  ExpoDownloadManager = null;
}

export default function DownloadsPage() {
  const router = useRouter();
  const cs = useColorScheme();
  const isDark = cs === 'dark';

  const textColor = isDark ? '#FFFFFF' : '#000000';
  const subColor = isDark ? '#9BA1A6' : '#6B7280';
  const cardBg = isDark ? '#1C1C1E' : '#F5F5F5';
  const bgColor = isDark ? '#0D0D0D' : '#FCFCFC';
  const barBg = isDark ? '#3A3A3C' : '#E5E5EA';
  const barFill = '#3B82F6';

  const models = useStore((s) => s.models);
  const downloadedModels = useStore((s) => s.downloadedModels);
  const activeDownloads = useStore((s) => s.activeDownloads);
  const downloadProgress = useStore((s) => s.downloadProgress);
  const downloadStats = useStore((s) => s.downloadStats);
  const cancelDownload = useStore((s) => s.cancelDownload);
  const pauseDownload = useStore((s) => s.pauseDownload);
  const resumeDownload = useStore((s) => s.resumeDownload);
  const deletePartialDownload = useStore((s) => s.deletePartialDownload);
  const rescanResumableDownloads = useStore((s) => s.rescanResumableDownloads);
  const resumableDownloads = useStore((s) => s.resumableDownloads);
  const deleteModel = useStore((s) => s.deleteModel);
  const selectedModel = useStore((s) => s.selectedModel);
  const setBatteryOptPromptShown = useStore((s) => s.setBatteryOptPromptShown);

  const activeList = activeDownloads instanceof Set ? [...activeDownloads] : [];

  // Live state for the two Android-only background-permission rows.
  // Refreshed on mount and every time the page regains focus, since the
  // user may have toggled either permission in system settings.
  const [batteryOptIgnored, setBatteryOptIgnored] = useState<boolean | null>(null);
  const [notifPermGranted, setNotifPermGranted] = useState<boolean | null>(null);

  const refreshPermissionStates = useCallback(async () => {
    if (Platform.OS !== 'android') return;
    try {
      if (ExpoDownloadManager) {
        setBatteryOptIgnored(ExpoDownloadManager.isBatteryOptimizationIgnored());
      }
    } catch {}
    try {
      const status = await Notifications.getPermissionsAsync();
      setNotifPermGranted(status.granted);
    } catch {}
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshPermissionStates();
      rescanResumableDownloads().catch(() => {});
    }, [refreshPermissionStates, rescanResumableDownloads]),
  );

  const onPressBatteryOpt = useCallback(() => {
    if (!ExpoDownloadManager) return;
    if (batteryOptIgnored) return;
    try {
      ExpoDownloadManager.requestBatteryOptimizationExemption();
      setBatteryOptPromptShown(true);
    } catch {}
  }, [batteryOptIgnored, setBatteryOptPromptShown]);

  const onPressNotif = useCallback(async () => {
    if (notifPermGranted) return;
    try {
      const res = await Notifications.requestPermissionsAsync();
      setNotifPermGranted(res.granted);
    } catch {}
  }, [notifPermGranted]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: bgColor }}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 12,
        }}
      >
        <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
        <Text style={{ fontSize: 20, fontWeight: 'bold', color: textColor }}>
          Downloads
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}>

        {/* ─── Background download settings (Android only) ─── */}
        {Platform.OS === 'android' && (
          <>
            <Text
              style={{
                fontSize: 13,
                fontWeight: '700',
                color: subColor,
                marginBottom: 8,
                marginTop: 4,
                letterSpacing: 0.5,
              }}
            >
              BACKGROUND DOWNLOADS
            </Text>

            {/* Battery optimization */}
            <TouchableOpacity
              activeOpacity={batteryOptIgnored ? 1 : 0.7}
              onPress={onPressBatteryOpt}
              style={{
                backgroundColor: cardBg,
                borderRadius: 12,
                padding: 14,
                marginBottom: 6,
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <Ionicons
                name="battery-charging-outline"
                size={20}
                color={textColor}
                style={{ marginRight: 12 }}
              />
              <View style={{ flex: 1 }}>
                <Text style={{ color: textColor, fontWeight: '600', fontSize: 14 }}>
                  Keep downloads alive in background
                </Text>
                <Text style={{ color: subColor, fontSize: 12, marginTop: 2 }}>
                  {batteryOptIgnored === null
                    ? 'Checking…'
                    : batteryOptIgnored
                    ? 'Allowed — downloads can run when screen is off'
                    : 'Tap to allow unrestricted battery for this app'}
                </Text>
              </View>
              {batteryOptIgnored === true && (
                <Ionicons name="checkmark-circle" size={20} color="#10B981" />
              )}
              {batteryOptIgnored === false && (
                <Ionicons name="chevron-forward" size={20} color={subColor} />
              )}
            </TouchableOpacity>

            {/* Notification permission */}
            <TouchableOpacity
              activeOpacity={notifPermGranted ? 1 : 0.7}
              onPress={onPressNotif}
              style={{
                backgroundColor: cardBg,
                borderRadius: 12,
                padding: 14,
                marginBottom: 16,
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <Ionicons
                name="notifications-outline"
                size={20}
                color={textColor}
                style={{ marginRight: 12 }}
              />
              <View style={{ flex: 1 }}>
                <Text style={{ color: textColor, fontWeight: '600', fontSize: 14 }}>
                  Notify me when downloads finish
                </Text>
                <Text style={{ color: subColor, fontSize: 12, marginTop: 2 }}>
                  {notifPermGranted === null
                    ? 'Checking…'
                    : notifPermGranted
                    ? 'Allowed — you’ll get a notification on completion'
                    : 'Tap to enable download-complete notifications'}
                </Text>
              </View>
              {notifPermGranted === true && (
                <Ionicons name="checkmark-circle" size={20} color="#10B981" />
              )}
              {notifPermGranted === false && (
                <Ionicons name="chevron-forward" size={20} color={subColor} />
              )}
            </TouchableOpacity>
          </>
        )}

        {/* ─── Active Downloads ─── */}
        {activeList.length > 0 && (
          <>
            <Text style={{ fontSize: 13, fontWeight: '700', color: subColor, marginBottom: 8, marginTop: 4, letterSpacing: 0.5 }}>
              DOWNLOADING
            </Text>
            {activeList.map((modelName: string) => {
              const raw = downloadProgress?.[modelName] ?? 0;
              const indeterminate = raw < 0;
              const fraction = indeterminate ? 0 : Math.max(0, Math.min(1, raw));
              const pct = indeterminate ? '' : `${Math.round(fraction * 100)}%`;
              const stats = downloadStats?.[modelName];
              const speed = stats?.bytesPerSec && stats.bytesPerSec > 1024
                ? `${formatBytes(stats.bytesPerSec)}/s`
                : '';
              const received = stats?.bytesReceived ? formatBytes(stats.bytesReceived) : '';
              const total = stats?.bytesTotal ? formatBytes(stats.bytesTotal) : '';
              const eta = stats?.etaSeconds != null
                ? stats.etaSeconds > 60
                  ? `${Math.round(stats.etaSeconds / 60)}m left`
                  : `${Math.round(stats.etaSeconds)}s left`
                : '';

              return (
                <View
                  key={modelName}
                  style={{
                    backgroundColor: cardBg,
                    borderRadius: 12,
                    padding: 14,
                    marginBottom: 8,
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text
                      style={{ color: textColor, fontWeight: '600', fontSize: 15, flex: 1 }}
                      numberOfLines={1}
                    >
                      {modelName}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <TouchableOpacity
                        onPress={() => pauseDownload(modelName)}
                        accessibilityLabel="Pause download"
                      >
                        <Ionicons name="pause-circle" size={26} color={barFill} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => {
                          themedAlert('Cancel Download', `Cancel downloading ${modelName}?\n\nThe partial file will be deleted.`, [
                            { text: 'Keep', style: 'cancel' },
                            { text: 'Cancel', style: 'destructive', onPress: () => cancelDownload(modelName) },
                          ]);
                        }}
                        accessibilityLabel="Cancel download"
                      >
                        <Ionicons name="close-circle" size={24} color="#EF4444" />
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* Progress bar */}
                  <View style={{ height: 5, backgroundColor: barBg, borderRadius: 3, overflow: 'hidden', marginTop: 10 }}>
                    <View
                      style={{
                        height: '100%',
                        borderRadius: 3,
                        width: indeterminate ? '35%' : `${Math.round(fraction * 100)}%`,
                        backgroundColor: barFill,
                        opacity: indeterminate ? 0.5 : 1,
                      }}
                    />
                  </View>

                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
                    <Text style={{ fontSize: 12, color: subColor }}>
                      {received && total ? `${received} / ${total}` : received || 'Starting...'}{' '}
                      {pct}
                    </Text>
                    <Text style={{ fontSize: 12, color: subColor }}>
                      {speed}{speed && eta ? ' · ' : ''}{eta}
                    </Text>
                  </View>
                </View>
              );
            })}
          </>
        )}

        {/* ─── Paused / Resumable ─── */}
        {resumableDownloads.length > 0 && (
          <>
            <Text
              style={{
                fontSize: 13,
                fontWeight: '700',
                color: subColor,
                marginBottom: 8,
                marginTop: activeList.length > 0 ? 16 : 4,
                letterSpacing: 0.5,
              }}
            >
              PAUSED ({resumableDownloads.length})
            </Text>
            {resumableDownloads.map((r) => {
              const catalogModel = models.find((m: any) => m.name === r.modelName);
              const meta = useStore.getState().pendingDownloadMeta?.[r.modelName];
              // For the mmproj phase, use the projector's expected size,
              // not the main weights size, so the progress math matches.
              const sizeStr = r.mmprojOnly
                ? (catalogModel?.mmProjSize ?? meta?.mmProjSize)
                : (catalogModel?.size ?? meta?.size);
              const expectedTotal = parseSizeStringToBytes(sizeStr);
              const fraction = expectedTotal > 0
                ? Math.min(0.999, r.bytesOnDisk / expectedTotal)
                : 0;
              const pct = expectedTotal > 0 ? `${Math.round(fraction * 100)}%` : '';

              const subtitle = r.orphan
                ? "Can't resume — original URL unknown"
                : r.mmprojOnly
                ? 'Vision projector'
                : 'Paused';

              return (
                <View
                  key={r.fileName}
                  style={{
                    backgroundColor: cardBg,
                    borderRadius: 12,
                    padding: 14,
                    marginBottom: 8,
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text
                      style={{ color: textColor, fontWeight: '600', fontSize: 15, flex: 1 }}
                      numberOfLines={1}
                    >
                      {r.modelName}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      {!r.orphan && (
                        <TouchableOpacity
                          onPress={() => resumeDownload(r.modelName)}
                          accessibilityLabel="Resume download"
                        >
                          <Ionicons name="play-circle" size={26} color={barFill} />
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        onPress={() => {
                          themedAlert(
                            'Delete Partial',
                            `Delete the partial download of "${r.modelName}"?\n\n${formatBytes(r.bytesOnDisk)} on disk will be removed.`,
                            [
                              { text: 'Keep', style: 'cancel' },
                              { text: 'Delete', style: 'destructive', onPress: () => deletePartialDownload(r.modelName) },
                            ],
                          );
                        }}
                        accessibilityLabel="Delete partial"
                      >
                        <Ionicons name="trash-outline" size={20} color={isDark ? '#6B7280' : '#9CA3AF'} />
                      </TouchableOpacity>
                    </View>
                  </View>

                  {expectedTotal > 0 && (
                    <View style={{ height: 5, backgroundColor: barBg, borderRadius: 3, overflow: 'hidden', marginTop: 10 }}>
                      <View
                        style={{
                          height: '100%',
                          borderRadius: 3,
                          width: `${Math.round(fraction * 100)}%`,
                          backgroundColor: barFill,
                          opacity: 0.6,
                        }}
                      />
                    </View>
                  )}

                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
                    <Text style={{ fontSize: 12, color: subColor }}>
                      {expectedTotal > 0
                        ? `${formatBytes(r.bytesOnDisk)} / ${formatBytes(expectedTotal)} ${pct}`
                        : `${formatBytes(r.bytesOnDisk)} downloaded`}
                    </Text>
                    <Text style={{ fontSize: 12, color: subColor }}>{subtitle}</Text>
                  </View>
                </View>
              );
            })}
          </>
        )}

        {/* ─── Downloaded Models ─── */}
        <Text
          style={{
            fontSize: 13,
            fontWeight: '700',
            color: subColor,
            marginBottom: 8,
            marginTop: (activeList.length > 0 || resumableDownloads.length > 0) ? 16 : 4,
            letterSpacing: 0.5,
          }}
        >
          ON DEVICE ({downloadedModels.length})
        </Text>

        {downloadedModels.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 32 }}>
            <Ionicons name="cloud-download-outline" size={40} color={subColor} style={{ opacity: 0.5 }} />
            <Text style={{ color: subColor, marginTop: 12, fontSize: 14 }}>
              No models downloaded yet
            </Text>
            <Text style={{ color: subColor, marginTop: 4, fontSize: 12, opacity: 0.7 }}>
              Download models from the home screen
            </Text>
          </View>
        ) : (
          downloadedModels.map((fileName: string) => {
            const baseName = fileName.replace(/\.(gguf|safetensors|ckpt|zip)$/i, '');
            // Match catalog model by: exact name, filename, or stripping -MNN/-NPU suffix
            const model = models.find(
              (m: any) =>
                m.name === baseName ||
                m.name === `${baseName}-MNN` ||
                m.name === `${baseName}-NPU` ||
                getModelFileName(m) === fileName,
            );
            const isActive = selectedModel?.name === baseName
              || selectedModel?.name === `${baseName}-MNN`
              || selectedModel?.name === `${baseName}-NPU`;
            const isImgGen = model ? isImageGenModel(model) : false;
            // Detect MNN dir (has unet.mnn) vs QNN dir (has unet.bin)
            // When the directory has no extension in downloadedModels, it's an MNN/QNN dir
            const isMnnOrQnn = fileName === baseName; // dirs have no extension
            const isQnn = baseName.includes('-NPU') || (model?.name?.includes('-NPU') ?? false);

            // Determine type label
            let typeLabel = 'Text LLM';
            let typeBg = isDark ? '#1F2937' : '#F3F4F6';
            let typeColor = isDark ? '#9CA3AF' : '#6B7280';
            if (isQnn) {
              typeLabel = 'NPU';
              typeBg = isDark ? '#3E1F5E' : '#F5E8FF';
              typeColor = isDark ? '#C084FC' : '#9333EA';
            } else if (isMnnOrQnn && !isQnn) {
              typeLabel = 'GPU';
              typeBg = isDark ? '#1E3A5F' : '#EFF6FF';
              typeColor = isDark ? '#60A5FA' : '#2563EB';
            } else if (isImgGen) {
              typeLabel = 'Image Gen';
              typeBg = isDark ? '#3B1E4E' : '#F5E8FF';
              typeColor = isDark ? '#D8B4FE' : '#9333EA';
            } else if (model?.mmProjUrl) {
              typeLabel = 'Vision';
              typeBg = isDark ? '#1E293B' : '#EFF6FF';
              typeColor = isDark ? '#93C5FD' : '#2563EB';
            }

            return (
              <View
                key={fileName}
                style={{
                  backgroundColor: cardBg,
                  borderRadius: 12,
                  padding: 14,
                  marginBottom: 6,
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{ color: textColor, fontWeight: '600', fontSize: 15 }}
                      numberOfLines={1}
                    >
                      {baseName}
                    </Text>
                    {/* Badges row */}
                    <View style={{ flexDirection: 'row', gap: 5, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <View style={{ backgroundColor: typeBg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: typeColor }}>
                          {typeLabel}
                        </Text>
                      </View>
                      {isActive && (
                        <View style={{
                          backgroundColor: isDark ? '#064E3B' : '#ECFDF5',
                          paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5,
                        }}>
                          <Text style={{ fontSize: 10, fontWeight: '700', color: isDark ? '#34D399' : '#059669' }}>
                            Active
                          </Text>
                        </View>
                      )}
                      {model?.size && (
                        <Text style={{ fontSize: 11, color: isDark ? '#4B5563' : '#D1D5DB' }}>
                          {model.size}
                        </Text>
                      )}
                    </View>
                    {/* Description */}
                    {model?.description && (
                      <Text
                        style={{ color: subColor, fontSize: 12, marginTop: 4, opacity: 0.8 }}
                        numberOfLines={1}
                      >
                        {model.description}
                      </Text>
                    )}
                  </View>

                  {/* Delete */}
                  <TouchableOpacity
                    onPress={() => {
                      themedAlert(
                        'Delete Model',
                        `Delete "${baseName}"?\n\nThe model file will be permanently removed from your device.`,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Delete',
                            style: 'destructive',
                            onPress: () => deleteModel(baseName),
                          },
                        ],
                      );
                    }}
                    style={{ padding: 4, marginLeft: 8 }}
                  >
                    <Ionicons name="trash-outline" size={20} color={isDark ? '#6B7280' : '#9CA3AF'} />
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}

        {/* Storage info */}
        <View style={{ marginTop: 16, alignItems: 'center' }}>
          <Text style={{ fontSize: 11, color: subColor, opacity: 0.5 }}>
            Models are stored in Downloads/MicroGPT
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
