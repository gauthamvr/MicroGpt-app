// app/(root)/(tabs)/explore.tsx

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  TouchableOpacity,
  Modal,
  Text,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { themedAlert } from '@/components/ThemedAlert';
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
  let lastParsed = '';
  let lastModelId = '';

  function postList(items) {
    const key = JSON.stringify(items);
    if (key === lastParsed) return;
    lastParsed = key;
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'ggufList',
      items: items
    }));
  }

  // Scrape any .gguf anchors on the current page (works when the user HAS
  // manually navigated to the Files tab, without triggering the nav ourselves).
  function scrapeGGUFLinks() {
    const results = [];
    const linkEls = document.querySelectorAll('li a[href*=".gguf?download=true"]');
    linkEls.forEach(a => {
      const fullUrl = a.href || '';
      let fileName = fullUrl.split('/').pop() || '';
      fileName = fileName.replace('?download=true','');
      let fileSize = '';
      const sizeSpan = a.querySelector('span.truncate');
      if (sizeSpan) { fileSize = sizeSpan.innerText.trim(); }
      results.push({ href: fullUrl, fileName, fileSize });
    });
    if (results.length === 0) {
      const allAnchors = document.querySelectorAll('a[href*=".gguf"]');
      allAnchors.forEach(a => {
        const fullUrl = a.href || '';
        if (!fullUrl.includes('.gguf')) return;
        let fileName = fullUrl.split('/').pop() || '';
        fileName = fileName.replace('?download=true','');
        if (!fileName.endsWith('.gguf')) return;
        const downloadUrl = fullUrl.includes('?download=true') ? fullUrl : fullUrl + '?download=true';
        results.push({ href: downloadUrl, fileName, fileSize: '' });
      });
    }
    if (results.length > 0) postList(results);
  }

  // Detect whether we're currently looking at a model card page on HF.
  // Returns the modelId (org/name) or null. Excludes hub sub-routes like
  // /datasets, /spaces, /docs, /login etc that are not actual model pages.
  function getCurrentModelId() {
    const path = window.location.pathname;
    const match = path.match(/^\\/([^\\/?#]+)\\/([^\\/?#]+)/);
    if (!match) return null;
    const org = match[1];
    const name = match[2];
    const reserved = [
      'datasets','spaces','models','docs','organizations','settings',
      'pricing','login','join','blog','posts','enterprise','api',
      'chat','new','tasks','events','search','collections','papers',
      'tools','privacy','terms'
    ];
    if (reserved.indexOf(org) !== -1) return null;
    if (!org || !name) return null;
    return org + '/' + name;
  }

  // Fetch GGUF file listing via HuggingFace's public API — works on the
  // model card page WITHOUT needing to navigate to the Files tab. This is
  // the primary detection path; DOM scraping is only a fallback for edge
  // cases where the API is blocked or rate-limited.
  function tryApiFetch() {
    const modelId = getCurrentModelId();
    if (!modelId) {
      // Not on a model page — clear any stale items so the floating
      // button reverts to its default state.
      if (lastModelId !== '') {
        lastModelId = '';
        postList([]);
      }
      return;
    }
    // Skip if we've already fetched for this exact model
    if (modelId === lastModelId) return;
    lastModelId = modelId;

    fetch('https://huggingface.co/api/models/' + modelId + '/tree/main')
      .then(r => r.json())
      .then(files => {
        if (!Array.isArray(files)) {
          postList([]);
          return;
        }
        // Detect ALL supported model files: .gguf, .safetensors, .ckpt, .zip
        var supportedExts = ['.gguf', '.safetensors', '.ckpt', '.zip'];
        var modelFiles = files.filter(function(f) {
          if (!f.path) return false;
          var lower = f.path.toLowerCase();
          return supportedExts.some(function(ext) { return lower.endsWith(ext); });
        });
        // Also detect MNN model directories (look for unet.mnn)
        var hasMnnFiles = files.some(function(f) {
          return f.path && (f.path.endsWith('.mnn') || f.path === 'unet.mnn');
        });
        if (modelFiles.length === 0 && !hasMnnFiles) {
          postList([]);
          return;
        }
        var items = modelFiles.map(function(f) {
          var sizeBytes = f.lfs ? f.lfs.size : f.size;
          var sizeGB = sizeBytes ? (sizeBytes / 1024 / 1024 / 1024).toFixed(2) + ' GB' : '';
          var sizeMB = sizeBytes && sizeBytes < 1024*1024*1024 ? (sizeBytes / 1024 / 1024).toFixed(0) + ' MB' : sizeGB;
          var lower = f.path.toLowerCase();
          // Repo name suggests image gen — used by both the safetensors/ckpt
          // and gguf branches below, so it's computed once up front (it used
          // to be declared inside the safetensors/ckpt branch only, which
          // left it undefined on the gguf branch and silently disabled the
          // SD/flux/sdxl repo-name check for every .gguf file).
          var repoLower = modelId.toLowerCase();
          // Classify the file type for badge display
          var fileType = 'text'; // default
          if (lower.endsWith('.zip')) {
            fileType = lower.includes('qnn') ? 'npu' : 'gpu';
          } else if (lower.endsWith('.safetensors') || lower.endsWith('.ckpt')) {
            // Check if repo name suggests image gen
            if (repoLower.includes('stable-diffusion') || repoLower.includes('sd-') ||
                repoLower.includes('dreamshaper') || repoLower.includes('realistic') ||
                repoLower.includes('anything') || repoLower.includes('meina') ||
                repoLower.includes('chillout') || repoLower.includes('diffusion')) {
              fileType = 'imagegen-cpu';
            }
          } else if (lower.endsWith('.gguf')) {
            // Check if it's an SD GGUF
            if (repoLower.includes('stable-diffusion') || repoLower.includes('sd-') ||
                repoLower.includes('flux') || repoLower.includes('sdxl')) {
              fileType = 'imagegen-cpu';
            }
          }
          // Check for mmproj (vision)
          if (lower.includes('mmproj') || lower.includes('projector') ||
              (lower.includes('clip') && lower.includes('vit'))) {
            fileType = 'vision';
          }
          return {
            href: 'https://huggingface.co/' + modelId + '/resolve/main/' + f.path + '?download=true',
            fileName: f.path,
            fileSize: sizeBytes >= 1024*1024*1024 ? sizeGB : sizeMB,
            fileType: fileType
          };
        });
        postList(items);
      })
      .catch(() => { postList([]); });
  }

  // Intercept clicks on HuggingFace's native download anchors. If the
  // user taps HF's own download arrow inside the Files tab, the
  // browser starts a system download — landing the file outside our
  // app's directory where we can't auto-process or load it. Catch
  // the click, post a message to RN, and let RN show a "use the
  // in-app download button instead" prompt.
  function interceptHfDownloadButtons() {
    const anchors = document.querySelectorAll(
      'a[href*=".gguf?download=true"], a[href*=".safetensors?download=true"], a[href*=".zip?download=true"], a[href*=".ckpt?download=true"], a[href*="resolve/main"][download]'
    );
    anchors.forEach(function(a) {
      if (a.dataset.mgptIntercept === '1') return;
      a.dataset.mgptIntercept = '1';
      a.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const href = a.href || '';
        const fileName = (href.split('/').pop() || '').split('?')[0];
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'hfNativeDownloadIntercept',
          url: href,
          fileName: fileName,
        }));
        return false;
      }, true);
    });
  }

  function refresh() {
    tryApiFetch();
    // Only scrape DOM links when we're actually on a model page; on
    // search/listing pages there can be stray .gguf hits in featured
    // model cards that would falsely populate the floating button.
    if (getCurrentModelId()) {
      scrapeGGUFLinks();
      interceptHfDownloadButtons();
    }
  }

  // Always run refresh on each injection (HF navigation fires a new inject)
  refresh();

  // The rest — listeners, history wrappers, extra timers — is stateful
  // page-level plumbing that MUST be installed exactly once. Android's
  // WebView re-runs injectedJavaScript on every onLoad, so without this
  // guard each SPA navigation stacked a new click listener, a new
  // popstate listener, and a new wrapped pushState/replaceState on top
  // of the previous wrap. After 5 page hops every click fired 6 times.
  if (window.__microgpt_hf_scrape_installed) return;
  window.__microgpt_hf_scrape_installed = true;

  // Short delayed follow-ups to cover HF's async card rendering
  setTimeout(refresh, 500);
  setTimeout(refresh, 1500);

  let debounceTimer = null;
  function debouncedRefresh() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 400);
  }

  // Re-run whenever the user navigates within HuggingFace (SPA-style routes)
  document.addEventListener('click', debouncedRefresh);
  const origPushState = history.pushState;
  history.pushState = function() {
    origPushState.apply(this, arguments);
    debouncedRefresh();
  };
  const origReplaceState = history.replaceState;
  history.replaceState = function() {
    origReplaceState.apply(this, arguments);
    debouncedRefresh();
  };
  window.addEventListener('popstate', debouncedRefresh);
})();
true;
`;

type GgufItem = {
  href: string;
  fileName: string;
  fileSize: string;
};

export default function Explore() {
  // Per-field selectors — a bare useStore() here made this tab
  // re-render on every chatHistory update while the user was
  // streaming on Home. Bottom tabs stay mounted after first visit.
  const hasAcceptedHuggingFaceTOS = useStore((s) => s.hasAcceptedHuggingFaceTOS);
  const acceptHuggingFaceTOS = useStore((s) => s.acceptHuggingFaceTOS);
  const isDownloading = useStore((s) => s.isDownloading);
  const downloadProgress = useStore((s) => s.downloadProgress);
  const currentDownloadModelName = useStore((s) => s.currentDownloadModelName);
  const cancelDownload = useStore((s) => s.cancelDownload);

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
      themedAlert(
        'Note',
        'Please use the floating button once .gguf files are detected.'
      );
      return false;
    }
    if (url.includes('resolve/main/') && !url.endsWith('.gguf')) {
      themedAlert('Unsupported file', 'Only .gguf files can be downloaded.');
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
      } else if (data.type === 'hfNativeDownloadIntercept') {
        // User tapped HuggingFace's own download arrow. Their browser
        // would normally start a system download — landing the file in
        // /Downloads where the app can't auto-detect or load it. Pop
        // a clear explanation and steer them to our in-app button.
        const fileName: string = String(data.fileName || 'file');
        themedAlert(
          'Use the in-app download button',
          `If you let the browser download "${fileName}", the file lands in your phone's Downloads folder and won't be picked up by the app — you'd have to load it manually later.\n\n` +
          `Tap the floating download button at the bottom of this screen instead. The app will pick a good filename, track progress, validate the file, and load it for you.`,
          [{ text: 'OK' }],
        );
      }
    } catch (err) {
      // ignore errors
    }
  };

  const handleNavStateChange = (navState: WebViewNavigation) => {
    setCanGoBack(navState.canGoBack);
    // Clear stale gguf items the moment we leave a model page so the
    // floating button reverts immediately. The injected JS will repopulate
    // when we land on a new model. This is a belt-and-braces guard in
    // case the JS-side debounce hasn't fired yet.
    try {
      const url = navState.url || '';
      const u = new URL(url);
      const path = u.pathname;
      const m = path.match(/^\/([^\/?#]+)\/([^\/?#]+)/);
      const reserved = new Set([
        'datasets','spaces','models','docs','organizations','settings',
        'pricing','login','join','blog','posts','enterprise','api',
        'chat','new','tasks','events','search','collections','papers',
        'tools','privacy','terms',
      ]);
      const isModelPage = !!m && !reserved.has(m[1]) && !!m[2];
      if (!isModelPage && ggufItems.length > 0) {
        setGgufItems([]);
      }
    } catch {
      // ignore URL parsing failures
    }
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
      themedAlert(
        'No .gguf Files Detected',
        'Open a model page on HuggingFace. The bottom icon will turn into a download icon automatically once .gguf files are detected — you don\u2019t need to open the Files tab.'
      );
    }
  };

  // Handle question mark press to show instructions
  const handleQuestionPress = () => {
    themedAlert(
      'Instructions',
      'Browse HuggingFace and open any model page. If the model has .gguf files, the bottom icon automatically turns into a download button — tap it to pick a quantization. You don\u2019t need to open the Files tab yourself.'
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
                backgroundColor: isDark ? '#FFFFFF' : '#000000',
              }}
            >
              <Ionicons name="checkmark" size={20} color={isDark ? '#000000' : '#FFFFFF'} />
              <Text
                style={{ marginLeft: 8, color: isDark ? '#000000' : '#FFFFFF', fontWeight: 'bold' }}
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
          {isDownloading && (() => {
            const raw = overallDownloadProgress();
            const indeterminate = raw < 0;
            const fraction = indeterminate ? 0 : Math.max(0, Math.min(1, raw));
            const pct = indeterminate ? '' : `${Math.round(fraction * 100)}%`;
            return (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {indeterminate ? (
                  <>
                    <ActivityIndicator size="small" color={topBarIconColor} />
                    <Text style={{ marginLeft: 6, color: loadingTextColor, fontSize: 11 }}>
                      background
                    </Text>
                  </>
                ) : (
                  <Text style={{ color: loadingTextColor, fontSize: 12, fontWeight: '600' }}>
                    {pct}
                  </Text>
                )}
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
            );
          })()}
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
