// app/(root)/(tabs)/explore.tsx

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  Alert,
  View,
  TouchableOpacity,
  Modal,
  Text,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebView, {
  WebViewMessageEvent,
  WebViewNavigation,
} from 'react-native-webview';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useStore } from '@/store';
import HuggingfaceDownloadModel from '../../../components/HuggingfaceDownloadModel';
import { useColorScheme } from 'react-native';

const HUGGINGFACE_MODELS_URL =
  'https://huggingface.co/models?sort=downloads&search=gguf';

const injectedJavaScript = `
(function() {
  function parseGGUFItems() {
    const results = [];
    const linkEls = document.querySelectorAll('li a[href*=".gguf?download=true"]');
    
    linkEls.forEach(a => {
      const fullUrl = a.href || '';
      let fileName = fullUrl.split('/').pop() || ''; 
      fileName = fileName.replace('?download=true','');

      let fileSize = '';
      const sizeSpan = a.querySelector('span.truncate');
      if (sizeSpan) {
        fileSize = sizeSpan.innerText.trim();
      }

      results.push({
        href: fullUrl,
        fileName,
        fileSize,
      });
    });

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'ggufList',
      items: results
    }));
  }

  setTimeout(parseGGUFItems, 2000);
  document.addEventListener('click', () => {
    setTimeout(parseGGUFItems, 1500);
  });
  const origPushState = history.pushState;
  history.pushState = function() {
    origPushState.apply(this, arguments);
    setTimeout(parseGGUFItems, 2000);
  };
  window.addEventListener('popstate', () => {
    setTimeout(parseGGUFItems, 2000);
  });
})();
true;
`;

type GgufItem = {
  href: string;
  fileName: string;
  fileSize: string;
};

export default function Explore() {
  const {
    hasAcceptedHuggingFaceTOS,
    acceptHuggingFaceTOS,
    isDownloading,
    downloadProgress,
    currentDownloadModelName,
    cancelDownload,
  } = useStore();

  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const topBarBg = isDark ? '#0D0D0D' : 'transparent';
  const topBarIconColor = isDark ? '#E6E6E6' : '#0D0D0D';
  const topBarTextColor = topBarIconColor;
  const loadingTextColor = isDark ? '#E6E6E6' : '#0D0D0D';

  // Floating button colors based on mode
  const floatingButtonBg = isDark ? '#fff' : '#000';
  const floatingButtonIconColor = isDark ? '#000' : '#fff';

  // TOS, .gguf items, download modal
  const [showTOSModal, setShowTOSModal] = useState(!hasAcceptedHuggingFaceTOS);
  const [ggufItems, setGgufItems] = useState<GgufItem[]>([]);
  const [showDownloadModal, setShowDownloadModal] = useState(false);

  // WebView
  const webViewRef = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [isWebViewLoading, setIsWebViewLoading] = useState(false);

  const hasItems = ggufItems.length > 0;
  const containerScale = useRef(new Animated.Value(1)).current;
  const [iconType, setIconType] = useState<'star' | 'download'>('star');

  useEffect(() => {
    if (hasItems && iconType === 'star') {
      Animated.timing(containerScale, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start(() => {
        setIconType('download');
        Animated.timing(containerScale, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }).start();
      });
    } else if (!hasItems && iconType === 'download') {
      Animated.timing(containerScale, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start(() => {
        setIconType('star');
        Animated.timing(containerScale, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }).start();
      });
    }
  }, [hasItems, iconType, containerScale]);

  const handleAcceptTOS = () => {
    acceptHuggingFaceTOS();
    setShowTOSModal(false);
  };

  const handleShouldStartLoad = useCallback((navState: any) => {
    const { url } = navState;
    if (url.endsWith('.gguf')) {
      Alert.alert(
        'Note',
        'Please use the floating button once .gguf files are detected.'
      );
      return false;
    }
    if (url.includes('resolve/main/') && !url.endsWith('.gguf')) {
      Alert.alert('Unsupported file', 'Only .gguf files can be downloaded.');
      return false;
    }
    return true;
  }, []);

  const handleOnMessage = (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'ggufList') {
        const raw: GgufItem[] = data.items || [];
        const uniqueMap: Record<string, GgufItem> = {};
        raw.forEach((item) => {
          if (!uniqueMap[item.fileName]) {
            uniqueMap[item.fileName] = item;
          }
        });
        setGgufItems(Object.values(uniqueMap));
      }
    } catch (err) {
      // ignore errors
    }
  };

  const handleNavStateChange = (navState: WebViewNavigation) => {
    setCanGoBack(navState.canGoBack);
  };

  const overallDownloadProgress = () => {
    if (!currentDownloadModelName) return 0;
    return downloadProgress[currentDownloadModelName] || 0;
  };
  const downloadPercent = (overallDownloadProgress() * 100).toFixed(0) + '%';

  const handleCancelDownload = () => {
    if (currentDownloadModelName) {
      cancelDownload(currentDownloadModelName);
    }
  };

  const handleGoBack = () => {
    if (canGoBack) {
      webViewRef.current?.goBack();
    }
  };

  const handleFloatingButtonPress = () => {
    if (hasItems) {
      setShowDownloadModal(true);
    } else {
      Alert.alert(
        'No .gguf Files Detected',
        'The icon will turn into a download icon once .gguf files are found.\n\nGo to the "Files" tab of the model and wait a few seconds for the button to change.'
      );
    }
  };

  // Handle question mark press to show instructions
  const handleQuestionPress = () => {
    Alert.alert(
      'Instructions',
      'Browse HuggingFace for gguf files, check the modal card details and find the perfect model. Then go to the Files tab of the model. If gguf files are detected, the bottom icon will turn into a download icon. You can also download the models directly, although this is not recommended.'
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-theme-light-background dark:bg-theme-dark-background">
      {/* TOS Modal */}
      <Modal visible={showTOSModal} transparent>
        <View className="flex-1 bg-theme-light-background dark:bg-theme-dark-background bg-opacity-50 justify-center items-center p-4">
          <View className="w-11/12 max-h-[90%] rounded-lg p-4 bg-theme-light-input-background dark:bg-theme-dark-input-background">
            <Text className="text-lg font-bold text-theme-light-text-primary dark:text-theme-dark-text-primary mb-3">
              Hugging Face Terms & Conditions
            </Text>
            <Text className="text-theme-light-text-secondary dark:text-theme-dark-text-secondary mb-3">
              By proceeding, you agree to Hugging Face T&C. Only .gguf files can
              be downloaded.
            </Text>
            <TouchableOpacity
              onPress={handleAcceptTOS}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 999,
                paddingVertical: 12,
                backgroundColor: '#000',
              }}
            >
              <Ionicons name="checkmark" size={20} color="#fff" />
              <Text
                style={{ marginLeft: 8, color: '#fff', fontWeight: 'bold' }}
              >
                I Agree
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Header Row */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingVertical: 8,
          backgroundColor: topBarBg,
        }}
      >
        {/* Left: Back + Loading */}
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity
            onPress={handleGoBack}
            disabled={!canGoBack}
            style={{ flexDirection: 'row', alignItems: 'center' }}
          >
            <Ionicons
              name="arrow-back-circle"
              size={22}
              color={canGoBack ? topBarIconColor : '#666666'}
            />
            {canGoBack && (
              <Text
                style={{
                  marginLeft: 6,
                  fontWeight: 'bold',
                  color: topBarTextColor,
                }}
              >
                Back
              </Text>
            )}
          </TouchableOpacity>

          {isWebViewLoading && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                marginLeft: 12,
              }}
            >
              <ActivityIndicator size="small" color={topBarIconColor} />
              <Text style={{ marginLeft: 6, color: loadingTextColor }}>
                Loading...
              </Text>
            </View>
          )}
        </View>

        {/* Right: Question Mark and Download in-progress */}
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity
            onPress={handleQuestionPress}
            style={{ marginRight: 12 }}
          >
            <Ionicons
              name="help-circle-outline"
              size={22}
              color={topBarIconColor}
            />
          </TouchableOpacity>
          {isDownloading && (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <ActivityIndicator size="small" color={topBarIconColor} />
              <Text style={{ marginLeft: 6, color: loadingTextColor }}>
                {downloadPercent}
              </Text>
              <TouchableOpacity
                onPress={handleCancelDownload}
                style={{
                  marginLeft: 8,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons
                  name="close-circle"
                  size={20}
                  color={topBarIconColor}
                />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      {/* The WebView */}
      <WebView
        ref={webViewRef}
        source={{ uri: HUGGINGFACE_MODELS_URL }}
        onShouldStartLoadWithRequest={handleShouldStartLoad}
        injectedJavaScript={injectedJavaScript}
        onMessage={handleOnMessage}
        onNavigationStateChange={handleNavStateChange}
        onLoadStart={() => setIsWebViewLoading(true)}
        onLoadEnd={() => setIsWebViewLoading(false)}
        style={{ flex: 1 }}
      />

      {/* Floating button: star or download */}
      <Animated.View
        style={{
          position: 'absolute',
          right: 16,
          bottom: 24,
          width: 56,
          height: 56,
          borderRadius: 999,
          overflow: 'hidden',
          transform: [{ scale: containerScale }],
        }}
      >
        <TouchableOpacity
          onPress={handleFloatingButtonPress}
          activeOpacity={0.9}
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: floatingButtonBg,
          }}
        >
          {iconType === 'star' ? (
            <MaterialCommunityIcons
              name="star-four-points"
              size={22}
              color={floatingButtonIconColor}
            />
          ) : (
            <Ionicons
              name="download"
              size={22}
              color={floatingButtonIconColor}
            />
          )}
        </TouchableOpacity>
      </Animated.View>

      {/* .gguf items => HuggingfaceDownloadModel */}
      <HuggingfaceDownloadModel
        visible={showDownloadModal}
        onClose={() => setShowDownloadModal(false)}
        ggufItems={ggufItems}
      />
    </SafeAreaView>
  );
}
