import { useRef, useEffect, useState, useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity, Text, Alert, StatusBar, Modal, TextInput, FlatList, ScrollView, KeyboardAvoidingView, Platform, InteractionManager } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { keepLocalCopy, pick, types } from '@react-native-documents/picker';
import { launchImageLibrary } from 'react-native-image-picker';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DEFAULT_IP = '192.168.1.100:8080';
const DEFAULT_TOKEN = 'D6E0311D-0880-4D8C-8884-3B1AD1F93491';
const KEYBOARD_ASSET_VERSION = '20260421-traditional';
const buildHttpBaseUrl = (ip) => `http://${ip}`;

export default function TerminalScreen() {
  const insets = useSafeAreaInsets();
  const webview = useRef(null);
  const deleteRepeatTimeoutRef = useRef(null);
  const deleteRepeatIntervalRef = useRef(null);
  const suppressNextDeleteTapRef = useRef(false);
  const preferredConsoleRef = useRef('');
  const [connected, setConnected] = useState(false);
  const [showExtraKeys, setShowExtraKeys] = useState(true);
  const [showCommandModal, setShowCommandModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showKeyboardModal, setShowKeyboardModal] = useState(false);
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [showConsoleModal, setShowConsoleModal] = useState(false);
  const [selectedModifiers, setSelectedModifiers] = useState([]);
  const [serverIp, setServerIp] = useState(DEFAULT_IP);
  const [token, setToken] = useState(DEFAULT_TOKEN);
  const [activeConsole, setActiveConsole] = useState('');
  const [consoleSessions, setConsoleSessions] = useState([]);
  const [consoleListLoading, setConsoleListLoading] = useState(false);
  const [consoleListError, setConsoleListError] = useState('');
  const [fontSize, setFontSize] = useState(12);
  const [imeModeEnabled, setImeModeEnabled] = useState(false);
  const [showImeKeyboard, setShowImeKeyboard] = useState(false);
  const [imeKeyboardInitialized, setImeKeyboardInitialized] = useState(false);
  const httpBaseUrl = buildHttpBaseUrl(serverIp);
  const terminalUrl = `${httpBaseUrl}/terminal?fontSize=${fontSize}&token=${encodeURIComponent(token)}`;
  const imeBottomInset = Math.max(insets.bottom, 16);
  const imeKeyboardUrl = `${httpBaseUrl}/keyboard?embedded=1&bottomInset=${imeBottomInset}&kbv=${KEYBOARD_ASSET_VERSION}&token=${encodeURIComponent(token)}`;
  const [tempIp, setTempIp] = useState(DEFAULT_IP);
  const [tempToken, setTempToken] = useState(DEFAULT_TOKEN);
  const [tempFontSize, setTempFontSize] = useState('12');
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [editingCommand, setEditingCommand] = useState({ id: '', name: '', command: '' });
  const [currentPath, setCurrentPath] = useState('');
  const [directoryItems, setDirectoryItems] = useState([]);
  const [connectionError, setConnectionError] = useState(false);
  const [terminalLoaded, setTerminalLoaded] = useState(false);
  const [customCommands, setCustomCommands] = useState([
    { id: '1', name: 'claude root', command: 'claude --dangerously-skip-permissions' },
    { id: '2', name: 'list files', command: 'ls -la' },
    { id: '3', name: 'clear screen', command: 'clear' },
  ]);

  // Load persisted settings on mount
  useEffect(() => {
    AsyncStorage.multiGet(['serverIp', 'token', 'fontSize', 'customCommands', 'activeConsole']).then(pairs => {
      const map = Object.fromEntries(pairs.map(([k, v]) => [k, v]));
      if (map.serverIp) setServerIp(map.serverIp);
      if (map.token) setToken(map.token);
      if (map.fontSize) setFontSize(parseInt(map.fontSize, 10));
      if (map.activeConsole) {
        preferredConsoleRef.current = map.activeConsole;
        setActiveConsole(map.activeConsole);
      }
      if (map.customCommands) {
        try { setCustomCommands(JSON.parse(map.customCommands)); } catch {}
      }
      setSettingsLoaded(true);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (deleteRepeatTimeoutRef.current) {
        clearTimeout(deleteRepeatTimeoutRef.current);
      }
      if (deleteRepeatIntervalRef.current) {
        clearInterval(deleteRepeatIntervalRef.current);
      }
    };
  }, []);

  const sendToTerminal = useCallback((message) => {
    const script = `
      if (window.terminalWS && window.terminalWS.readyState === 1) {
        window.terminalWS.send(${JSON.stringify(JSON.stringify(message))});
      }
    `;
    webview.current?.injectJavaScript(script);
  }, []);

  const uploadFilePayload = useCallback((fileName, ext, content) => {
    sendToTerminal({
      type: 'upload_file',
      ext,
      content,
      fileName,
    });

    setTimeout(() => {
      Alert.alert('文件上传成功', `${fileName} 已发送到终端`);
    }, 100);
  }, [sendToTerminal]);

  const fetchConsoleList = useCallback(async () => {
    setConsoleListLoading(true);
    setConsoleListError('');

    try {
      const response = await fetch(`${httpBaseUrl}/api/tmux/sessions?token=${encodeURIComponent(token)}`);
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      setConsoleSessions(data.sessions || []);
      if (data.active) {
        setActiveConsole(data.active);
      }
    } catch (error) {
      setConsoleListError(error.message || '控制台列表加载失败');
      sendToTerminal({ type: 'tmux_ctrl', action: 'list_sessions' });
    } finally {
      setConsoleListLoading(false);
    }
  }, [httpBaseUrl, sendToTerminal, token]);

  const requestConsoleList = useCallback(() => {
    sendToTerminal({ type: 'tmux_ctrl', action: 'list_sessions' });
    fetchConsoleList();
  }, [fetchConsoleList, sendToTerminal]);

  const openConsoleModal = useCallback(() => {
    setShowConsoleModal(true);
    requestConsoleList();
  }, [requestConsoleList]);

  const switchConsole = useCallback((sessionName) => {
    if (!sessionName || sessionName === activeConsole) {
      setShowConsoleModal(false);
      return;
    }

    sendToTerminal({ type: 'tmux_ctrl', action: 'switch_session', session: sessionName });
    preferredConsoleRef.current = sessionName;
    AsyncStorage.setItem('activeConsole', sessionName);
    setShowConsoleModal(false);
  }, [activeConsole, sendToTerminal]);

  const closeConsole = useCallback((sessionName) => {
    if (!sessionName) {
      return;
    }

    Alert.alert(
      '关闭控制台',
      `确定要彻底关闭 ${sessionName} 吗？这会结束对应的 tmux 会话。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '关闭',
          style: 'destructive',
          onPress: () => {
            sendToTerminal({ type: 'tmux_ctrl', action: 'close_session', session: sessionName });
          }
        }
      ]
    );
  }, [sendToTerminal]);

  const pickDocumentFile = useCallback(async () => {
    try {
      const result = await pick({
        type: [types.allFiles],
      });
      const file = result[0];
      const ext = file.name?.split('.').pop() || 'txt';
      const safeName = (file.name || `upload.${ext}`).replace(/[^\w.-]/g, '_');
      const tempPath = `${RNFS.CachesDirectoryPath}/${Date.now()}-${safeName}`;
      let readablePath = tempPath;

      if (Platform.OS === 'android') {
        const localCopies = await keepLocalCopy({
          destination: 'cachesDirectory',
          files: [
            {
              uri: file.uri,
              fileName: `${Date.now()}-${safeName}`,
              ...(file.isVirtual && file.convertibleToMimeTypes?.[0]
                ? { convertVirtualFileToType: file.convertibleToMimeTypes[0] }
                : {}),
            },
          ],
        });
        const localCopy = localCopies[0];

        if (!localCopy || localCopy.status !== 'success' || !localCopy.localUri) {
          throw new Error(localCopy?.copyError || '无法读取 Android 文档提供器中的文件');
        }

        readablePath = decodeURIComponent(localCopy.localUri.replace(/^file:\/\//, ''));
      } else {
        const sourceUri = decodeURIComponent(file.uri.replace(/^file:\/\//, ''));
        await RNFS.copyFile(sourceUri, tempPath);
      }

      const content = await RNFS.readFile(readablePath, 'base64');
      await RNFS.unlink(readablePath).catch(() => {});

      uploadFilePayload(file.name, ext, content);
    } catch (err) {
      if (err?.code !== 'OPERATION_CANCELED') {
        console.error('文件上传错误:', err);
        setTimeout(() => {
          Alert.alert('错误', '文件上传失败: ' + err.message);
        }, 100);
      }
    }
  }, [uploadFilePayload]);

  const pickPhotoFromLibrary = useCallback(async () => {
    try {
      const response = await launchImageLibrary({
        mediaType: 'photo',
        selectionLimit: 1,
        includeBase64: true,
        presentationStyle: 'fullScreen',
      });

      if (response.didCancel) {
        return;
      }

      if (response.errorMessage) {
        throw new Error(response.errorMessage);
      }

      const asset = response.assets?.[0];
      if (!asset) {
        throw new Error('未获取到相册文件');
      }

      const fileName = asset.fileName || `photo-${Date.now()}.jpg`;
      const ext = fileName.split('.').pop() || 'jpg';

      if (asset.base64) {
        uploadFilePayload(fileName, ext, asset.base64);
        return;
      }

      if (!asset.uri) {
        throw new Error('相册文件缺少可读取路径');
      }

      const localPath = decodeURIComponent(asset.uri.replace(/^file:\/\//, ''));
      const content = await RNFS.readFile(localPath, 'base64');
      uploadFilePayload(fileName, ext, content);
    } catch (err) {
      console.error('相册上传错误:', err);
      setTimeout(() => {
        Alert.alert('错误', '相册上传失败: ' + err.message);
      }, 100);
    }
  }, [uploadFilePayload]);

  const pickFile = useCallback(() => {
    if (Platform.OS !== 'ios') {
      pickDocumentFile();
      return;
    }

    Alert.alert(
      '选择上传来源',
      '请选择文件来源',
      [
        { text: '取消', style: 'cancel' },
        { text: '文件', onPress: () => pickDocumentFile() },
        { text: '相册', onPress: () => pickPhotoFromLibrary() },
      ],
    );
  }, [pickDocumentFile, pickPhotoFromLibrary]);

  const sendKey = useCallback((key) => {
    sendToTerminal({ type: 'claude_action', action: key });
  }, [sendToTerminal]);

  const stopRepeatingDelete = useCallback(() => {
    if (deleteRepeatTimeoutRef.current) {
      clearTimeout(deleteRepeatTimeoutRef.current);
      deleteRepeatTimeoutRef.current = null;
    }

    if (deleteRepeatIntervalRef.current) {
      clearInterval(deleteRepeatIntervalRef.current);
      deleteRepeatIntervalRef.current = null;
    }
  }, []);

  const handleDeletePressIn = useCallback(() => {
    stopRepeatingDelete();
    suppressNextDeleteTapRef.current = false;

    deleteRepeatTimeoutRef.current = setTimeout(() => {
      suppressNextDeleteTapRef.current = true;
      sendKey('delete');

      deleteRepeatIntervalRef.current = setInterval(() => {
        sendKey('delete');
      }, 70);
    }, 300);
  }, [sendKey, stopRepeatingDelete]);

  const handleDeletePressOut = useCallback(() => {
    stopRepeatingDelete();
  }, [stopRepeatingDelete]);

  const handleDeletePress = useCallback(() => {
    if (suppressNextDeleteTapRef.current) {
      suppressNextDeleteTapRef.current = false;
      return;
    }

    sendKey('delete');
  }, [sendKey]);

  const handleNewSession = useCallback(() => {
    Alert.alert(
      '新建会话',
      '确定要创建新的tmux会话吗？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '创建',
          onPress: () => {
            sendToTerminal({ type: 'tmux_ctrl', action: 'new_session' });
            setShowConsoleModal(false);
          }
        }
      ]
    );
  }, [sendToTerminal]);

  const handleOpenConfig = useCallback(() => {
    setTempIp(serverIp);
    setTempToken(token);
    setTempFontSize(String(fontSize));
    setShowConfigModal(true);
  }, [serverIp, token, fontSize]);

  const handleSaveConfig = useCallback(() => {
    if (!tempIp.trim()) {
      Alert.alert('错误', '服务器地址不能为空');
      return;
    }
    if (!tempToken.trim()) {
      Alert.alert('错误', '密钥不能为空');
      return;
    }
    const newSize = parseInt(tempFontSize, 10);
    if (isNaN(newSize) || newSize < 8 || newSize > 32) {
      Alert.alert('错误', '字体大小需在 8~32 之间');
      return;
    }
    const ipChanged = tempIp !== serverIp || tempToken !== token;
    setServerIp(tempIp);
    setToken(tempToken);
    setFontSize(newSize);
    setConnectionError(false);
    AsyncStorage.multiSet([['serverIp', tempIp], ['token', tempToken], ['fontSize', String(newSize)]]);
    setShowConfigModal(false);
    if (ipChanged) {
      webview.current?.reload();
    } else {
      webview.current?.injectJavaScript(`
        if (window.term) { window.term.options.fontSize = ${newSize}; }
        true;
      `);
    }
  }, [tempIp, tempToken, tempFontSize, serverIp, token]);

  const toggleModifier = useCallback((modifier) => {
    setSelectedModifiers(prev => {
      if (prev.includes(modifier)) {
        return prev.filter(m => m !== modifier);
      } else {
        return [...prev, modifier];
      }
    });
  }, []);

  const scrollPageUp = useCallback(() => {
    sendToTerminal({ type: 'tmux_scroll', action: 'page_up' });
  }, [sendToTerminal]);

  const scrollPageDown = useCallback(() => {
    sendToTerminal({ type: 'tmux_scroll', action: 'page_down' });
  }, [sendToTerminal]);

  const sendComboKey = useCallback((key) => {
    let sequence = '';

    // Build escape sequence based on modifiers
    if (selectedModifiers.includes('ctrl')) {
      // Ctrl combinations
      const ctrlMap = {
        'a': '\x01', 'b': '\x02', 'c': '\x03', 'd': '\x04', 'e': '\x05',
        'f': '\x06', 'g': '\x07', 'h': '\x08', 'i': '\x09', 'j': '\x0a',
        'k': '\x0b', 'l': '\x0c', 'm': '\x0d', 'n': '\x0e', 'o': '\x0f',
        'p': '\x10', 'q': '\x11', 'r': '\x12', 's': '\x13', 't': '\x14',
        'u': '\x15', 'v': '\x16', 'w': '\x17', 'x': '\x18', 'y': '\x19',
        'z': '\x1a', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e',
        '_': '\x1f', '?': '\x7f',
        '1': '1', '2': '2', '3': '3', '4': '4', '5': '5',
        '6': '6', '7': '7', '8': '8', '9': '9', '0': '0'
      };
      sequence = ctrlMap[key.toLowerCase()] || key;
    } else if (selectedModifiers.includes('alt')) {
      // Alt/Option combinations (ESC + key)
      sequence = '\x1b' + key;
    } else if (selectedModifiers.includes('cmd')) {
      // Command key (Super key in terminal)
      sequence = '\x1b[' + key;
    } else {
      sequence = key;
    }

    // Handle Ctrl+Alt combinations
    if (selectedModifiers.includes('ctrl') && selectedModifiers.includes('alt')) {
      sequence = '\x1b' + sequence;
    }

    // Handle Shift (uppercase for letters)
    if (selectedModifiers.includes('shift') && key.match(/[a-z]/)) {
      sequence = sequence.toUpperCase();
    }

    sendToTerminal({ type: 'input', data: sequence });
    setSelectedModifiers([]);
    setShowKeyboardModal(false);
  }, [selectedModifiers, sendToTerminal]);

  const executeCommand = useCallback((command) => {
    setShowCommandModal(false);
    setTimeout(() => {
      sendToTerminal({ type: 'input', data: command + '\r' });
    }, 300);
  }, [sendToTerminal]);

  const refreshTerminalLayout = useCallback(() => {
    webview.current?.injectJavaScript(`
      if (typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new Event('resize'));
      }
      true;
    `);
  }, []);

  const toggleImeKeyboard = useCallback(() => {
    setImeModeEnabled(prev => {
      const nextValue = !prev;

      if (!nextValue) {
        setShowImeKeyboard(false);
      }

      return nextValue;
    });
  }, []);

  const handleImeKeyboardMessage = useCallback((event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'keyboard_close') {
        setShowImeKeyboard(false);
        return;
      }

      if (data.type === 'keyboard_input' && typeof data.text === 'string' && data.text) {
        sendToTerminal({ type: 'input', data: data.text });
      }
    } catch (_error) {
      // Ignore non-JSON bridge messages from the keyboard panel.
    }
  }, [sendToTerminal]);

  useEffect(() => {
    const timer = setTimeout(() => {
      refreshTerminalLayout();
    }, 60);

    return () => clearTimeout(timer);
  }, [refreshTerminalLayout, showExtraKeys, showImeKeyboard]);

  useEffect(() => {
    if (showImeKeyboard || imeModeEnabled) {
      setImeKeyboardInitialized(true);
    }
  }, [imeModeEnabled, showImeKeyboard]);

  useEffect(() => {
    if (!terminalLoaded) {
      return;
    }

    webview.current?.injectJavaScript(`
      if (typeof window.fireflySetImeMode === 'function') {
        window.fireflySetImeMode(${imeModeEnabled ? 'true' : 'false'});
      }
      true;
    `);
  }, [imeModeEnabled, terminalLoaded]);

  useEffect(() => {
    if (!settingsLoaded || connectionError || terminalLoaded === false || imeKeyboardInitialized) {
      return undefined;
    }

    const task = InteractionManager.runAfterInteractions(() => {
      setTimeout(() => {
        setImeKeyboardInitialized(true);
      }, 400);
    });

    return () => {
      task.cancel();
    };
  }, [connectionError, imeKeyboardInitialized, settingsLoaded, terminalLoaded]);

  const deleteCommand = useCallback((id) => {
    Alert.alert(
      '删除命令',
      '确定要删除这个命令吗？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            const updated = customCommands.filter(cmd => cmd.id !== id);
            setCustomCommands(updated);
            AsyncStorage.setItem('customCommands', JSON.stringify(updated));
          }
        }
      ]
    );
  }, [customCommands]);

  const editCommand = useCallback((cmd) => {
    setEditingCommand(cmd);
    setShowCommandModal(false);
    setShowEditModal(true);
  }, []);

  const saveCommand = useCallback(() => {
    if (!editingCommand.name.trim() || !editingCommand.command.trim()) {
      Alert.alert('错误', '命令名称和内容不能为空');
      return;
    }

    let updated;
    if (editingCommand.id) {
      updated = customCommands.map(cmd => cmd.id === editingCommand.id ? editingCommand : cmd);
    } else {
      updated = [...customCommands, { ...editingCommand, id: Date.now().toString() }];
    }
    setCustomCommands(updated);
    AsyncStorage.setItem('customCommands', JSON.stringify(updated));
    setShowEditModal(false);
    setEditingCommand({ id: '', name: '', command: '' });
  }, [editingCommand, customCommands]);

  const addNewCommand = useCallback(() => {
    setEditingCommand({ id: '', name: '', command: '' });
    setShowCommandModal(false);
    setShowEditModal(true);
  }, []);

  const moveCommand = useCallback((index, dir) => {
    const newIndex = index + dir;
    if (newIndex < 0 || newIndex >= customCommands.length) return;
    const updated = [...customCommands];
    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    setCustomCommands(updated);
    AsyncStorage.setItem('customCommands', JSON.stringify(updated));
  }, [customCommands]);

  const openFileBrowser = useCallback(() => {
    setShowFileBrowser(true);
    sendToTerminal({ type: 'get_cwd' });
  }, [sendToTerminal]);

  const navigateToDirectory = useCallback((path) => {
    sendToTerminal({ type: 'list_directory', path });
  }, [sendToTerminal]);

  const navigateUp = useCallback(() => {
    if (currentPath && currentPath !== '/') {
      const parentPath = currentPath.split('/').slice(0, -1).join('/') || '/';
      navigateToDirectory(parentPath);
    }
  }, [currentPath, navigateToDirectory]);

  const selectPath = useCallback((path) => {
    // Send path to terminal
    sendToTerminal({ type: 'input', data: path });
    setShowFileBrowser(false);
  }, [sendToTerminal]);

  const handleItemPress = useCallback((item) => {
    if (item.isDirectory) {
      navigateToDirectory(item.path);
    }
  }, [navigateToDirectory]);

  const handleMessage = useCallback((event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'connected') {
        setConnected(true);
        setConnectionError(false);
        if (data.tmux) {
          const preferredConsole = preferredConsoleRef.current;
          if (preferredConsole && preferredConsole !== data.tmux) {
            sendToTerminal({ type: 'tmux_ctrl', action: 'switch_session', session: preferredConsole });
          } else {
            setActiveConsole(data.tmux);
            AsyncStorage.setItem('activeConsole', data.tmux);
          }
        }
      } else if (data.type === 'disconnected') {
        setConnected(false);
      } else if (data.type === 'session_created') {
        if (data.success) {
          preferredConsoleRef.current = data.session;
          setActiveConsole(data.session);
          AsyncStorage.setItem('activeConsole', data.session);
          setTimeout(() => {
            Alert.alert('成功', `会话 ${data.session} 已创建`);
          }, 100);
        } else {
          setTimeout(() => {
            Alert.alert('错误', `创建会话失败: ${data.error}`);
          }, 100);
        }
      } else if (data.type === 'session_switched') {
        if (data.success) {
          preferredConsoleRef.current = data.session;
          setActiveConsole(data.session);
          AsyncStorage.setItem('activeConsole', data.session);
        } else {
          setTimeout(() => {
            Alert.alert('错误', `切换控制台失败: ${data.error}`);
          }, 100);
        }
      } else if (data.type === 'session_closed') {
        if (data.success) {
          if (data.active) {
            preferredConsoleRef.current = data.active;
            setActiveConsole(data.active);
            AsyncStorage.setItem('activeConsole', data.active);
          } else if (data.session === activeConsole) {
            preferredConsoleRef.current = '';
            setActiveConsole('');
            AsyncStorage.removeItem('activeConsole');
          }
          setConsoleSessions(prev => prev.filter(item => item.name !== data.session));
          setTimeout(() => {
            Alert.alert('已关闭', `控制台 ${data.session} 已关闭`);
          }, 100);
        } else {
          setTimeout(() => {
            Alert.alert('错误', `关闭控制台失败: ${data.error}`);
          }, 100);
        }
      } else if (data.type === 'tmux_sessions') {
        setConsoleSessions(data.sessions || []);
        if (data.active) {
          setActiveConsole(data.active);
        }
      } else if (data.type === 'cwd_response') {
        if (data.path) {
          setCurrentPath(data.path);
          // Send list_directory request
          const script = `
            if (window.terminalWS && window.terminalWS.readyState === 1) {
              window.terminalWS.send(${JSON.stringify(JSON.stringify({ type: 'list_directory', path: data.path }))});
            }
          `;
          webview.current?.injectJavaScript(script);
        }
      } else if (data.type === 'directory_list') {
        if (data.error) {
          setTimeout(() => {
            Alert.alert('错误', `无法读取目录: ${data.error}`);
          }, 100);
        } else {
          setCurrentPath(data.path);
          setDirectoryItems(data.items || []);
        }
      } else if (data.type === 'request_ime_keyboard' && imeModeEnabled) {
        setShowImeKeyboard(true);
      }
    } catch (e) {
      // Ignore non-JSON messages
    }
  }, [activeConsole, imeModeEnabled, sendToTerminal]);

  const renderTerminalFallback = useCallback(() => (
    <View style={styles.webviewFallback} />
  ), []);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="light-content" backgroundColor="#1e1e1e" />
      <KeyboardAvoidingView
        style={styles.keyboardAvoider}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Connection Status Bar */}
        <View style={styles.statusBar}>
          <View style={styles.statusLeft}>
            <View style={[styles.statusDot, connected ? styles.statusConnected : styles.statusDisconnected]} />
            <Text style={styles.statusText}>
              {connected ? '已连接' : (connectionError ? '请在配置中修改IP' : '连接中...')}
            </Text>
            <TouchableOpacity style={styles.consoleChip} onPress={openConsoleModal}>
              <Text style={styles.consoleChipText} numberOfLines={1}>
                {activeConsole || '默认控制台'}
              </Text>
            </TouchableOpacity>
          </View>
          <View style={styles.statusRight}>
            <TouchableOpacity onPress={openConsoleModal} style={styles.statusBtn}>
              <Svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <Rect x="3" y="4" width="18" height="14" rx="2" stroke="#aaa" strokeWidth="2"/>
                <Path d="M8 21h8M12 18v3M7 9h4M7 13h7" stroke="#aaa" strokeWidth="2" strokeLinecap="round"/>
              </Svg>
              <Text style={styles.statusText}>控制台</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={openFileBrowser} style={styles.statusBtn}>
              <Svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <Path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" stroke="#aaa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </Svg>
              <Text style={styles.statusText}>目录</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleOpenConfig} style={styles.statusBtn}>
              <Svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <Circle cx="12" cy="12" r="3" stroke="#aaa" strokeWidth="2"/>
                <Path d="M12 1v3m0 14v3M23 12h-3m-14 0H1" stroke="#aaa" strokeWidth="2" strokeLinecap="round"/>
                <Path d="M20.5 20.5l-2-2m-13 0l-2 2m15-15l-2 2m-11 0l-2-2" stroke="#aaa" strokeWidth="2" strokeLinecap="round"/>
              </Svg>
              <Text style={styles.statusText}>配置</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowExtraKeys(!showExtraKeys)} style={styles.statusBtn}>
              <Svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <Rect x="2" y="6" width="20" height="12" rx="2" stroke="#aaa" strokeWidth="2"/>
                <Path d="M6 10h1m3 0h1m3 0h1m3 0h1M7 14h10" stroke="#aaa" strokeWidth="2" strokeLinecap="round"/>
              </Svg>
              <Text style={styles.statusText}>{showExtraKeys ? '隐藏' : '显示'}按键</Text>
            </TouchableOpacity>
          </View>
        </View>

        {settingsLoaded && connectionError && (
          <TouchableOpacity style={styles.connectionConfigHint} onPress={handleOpenConfig}>
            <Text style={styles.connectionConfigHintText}>点击此处配置服务器IP</Text>
          </TouchableOpacity>
        )}

        <View style={styles.mainContent}>
          {settingsLoaded && !connectionError && (
            <WebView
              ref={webview}
              source={{ uri: terminalUrl }}
              style={styles.terminal}
              onMessage={handleMessage}
              javaScriptEnabled
              originWhitelist={['*']}
              mixedContentMode="always"
              domStorageEnabled
              allowFileAccess
              allowFileAccessFromFileURLs
              allowUniversalAccessFromFileURLs
              cacheEnabled
              scalesPageToFit={false}
              startInLoadingState
              renderLoading={renderTerminalFallback}
              onError={() => setConnectionError(true)}
              onHttpError={() => setConnectionError(true)}
              onLoadStart={() => {
                setConnectionError(false);
                setTerminalLoaded(false);
              }}
              onLoad={() => {
                setConnectionError(false);
                setTerminalLoaded(true);
              }}
            />
          )}
          {settingsLoaded && connectionError && <View style={styles.terminalPlaceholder} />}
        </View>

        {!showImeKeyboard && (
          <>
            {/* Extra Keys Row */}
            {showExtraKeys && (
              <View style={styles.extraKeys}>
                <View style={styles.extraKeysRow}>
                  <TouchableOpacity style={styles.keyBtn} onPress={() => sendKey('esc')}>
                    <Text style={styles.keyText} numberOfLines={1}>ESC</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.keyBtn} onPress={() => sendKey('tab')}>
                    <Text style={styles.keyText} numberOfLines={1}>TAB</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.keyBtn} onPress={() => sendKey('ctrl_c')}>
                    <Text style={styles.keyText} numberOfLines={1}>^C</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.keyBtn} onPress={() => sendKey('up')}>
                    <Text style={styles.keyText} numberOfLines={1}>↑</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.keyBtn} onPress={() => sendKey('down')}>
                    <Text style={styles.keyText} numberOfLines={1}>↓</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.keyBtn} onPress={() => sendKey('left')}>
                    <Text style={styles.keyText} numberOfLines={1}>←</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.keyBtn} onPress={() => sendKey('right')}>
                    <Text style={styles.keyText} numberOfLines={1}>→</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.extraKeysRow}>
                  <TouchableOpacity style={styles.keyBtn} onPress={() => setShowKeyboardModal(true)}>
                    <Text style={styles.keyText} numberOfLines={1}>组合键</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.keyBtn,
                      styles.keyboardToggleBtn,
                      imeModeEnabled && styles.keyboardToggleBtnActive,
                    ]}
                    onPress={toggleImeKeyboard}
                  >
                    <Text
                      style={[
                        styles.keyText,
                        imeModeEnabled && styles.keyboardToggleBtnTextActive,
                      ]}
                      numberOfLines={1}
                    >
                      键盘
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.keyBtn} onPress={() => sendToTerminal({ type: 'input', data: '/' })}>
                    <Text style={styles.keyText} numberOfLines={1}>/</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.keyBtn}
                    onPress={handleDeletePress}
                    onPressIn={handleDeletePressIn}
                    onPressOut={handleDeletePressOut}
                  >
                    <Text style={styles.keyText} numberOfLines={1}>删除</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.keyBtn, styles.spaceKeyBtn]}
                    onPress={() => sendToTerminal({ type: 'input', data: ' ' })}
                  >
                    <Text style={styles.keyText} numberOfLines={1}>空格</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Main Toolbar */}
            <View style={[styles.toolbar, { paddingBottom: Math.max(insets.bottom, 10) + 6 }]}>
              <TouchableOpacity style={styles.toolbarBtn} onPress={pickFile}>
                <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <Path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke="#aaa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </Svg>
                <Text style={styles.toolbarLabel}>文件</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolbarBtn} onPress={() => sendKey('ctrl_c')}>
                <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <Rect x="6" y="6" width="12" height="12" rx="1" stroke="#aaa" strokeWidth="2" fill="#aaa"/>
                </Svg>
                <Text style={styles.toolbarLabel}>中断</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolbarBtn} onPress={() => setShowCommandModal(true)}>
                <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <Path d="M4 17l6-6-6-6M12 19h8" stroke="#aaa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </Svg>
                <Text style={styles.toolbarLabel}>命令</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolbarBtn} onPress={scrollPageUp}>
                <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <Path d="M18 15l-6-6-6 6" stroke="#aaa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </Svg>
                <Text style={styles.toolbarLabel}>上翻</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolbarBtn} onPress={scrollPageDown}>
                <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <Path d="M6 9l6 6 6-6" stroke="#aaa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </Svg>
                <Text style={styles.toolbarLabel}>下翻</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolbarBtn} onPress={() => sendKey('enter')}>
                <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <Path d="M9 10v5h5M9 15l5-5" stroke="#aaa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <Path d="M20 4v7a4 4 0 01-4 4H9" stroke="#aaa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </Svg>
                <Text style={styles.toolbarLabel}>回车</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {imeKeyboardInitialized && (
          <View
            pointerEvents={showImeKeyboard ? 'auto' : 'none'}
            style={[
              styles.imeKeyboardDock,
              !showImeKeyboard && styles.imeKeyboardDockHidden,
              showImeKeyboard && {
                height: 376 + imeBottomInset,
                minHeight: 340 + imeBottomInset,
              },
            ]}
          >
            <WebView
              source={{ uri: imeKeyboardUrl }}
              style={styles.imeKeyboardWebview}
              onMessage={handleImeKeyboardMessage}
              javaScriptEnabled
              domStorageEnabled
              mixedContentMode="always"
              cacheEnabled
              cacheMode="LOAD_CACHE_ELSE_NETWORK"
              startInLoadingState
              renderLoading={renderTerminalFallback}
              onError={() => {
                setShowImeKeyboard(false);
                setTimeout(() => {
                  Alert.alert('错误', '中文键盘加载失败，请检查服务端是否已重启');
                }, 100);
              }}
            />
          </View>
        )}
      </KeyboardAvoidingView>

      {/* Custom Commands Modal */}
      <Modal
        visible={showCommandModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCommandModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>自定义命令</Text>
              <TouchableOpacity onPress={() => setShowCommandModal(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={customCommands}
              keyExtractor={(item) => item.id}
              renderItem={({ item, index }) => (
                <View style={styles.commandItem}>
                  <View style={styles.commandRow}>
                    <Text style={styles.commandName} numberOfLines={1} adjustsFontSizeToFit>{item.name}</Text>
                    <TouchableOpacity style={styles.actionBtn} onPress={() => editCommand(item)}>
                      <Text style={styles.actionBtnText}>编辑</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.actionBtn, styles.deleteBtn]} onPress={() => deleteCommand(item.id)}>
                      <Text style={[styles.actionBtnText, styles.deleteBtnText]}>删除</Text>
                    </TouchableOpacity>
                    <View style={styles.sortBtns}>
                      <TouchableOpacity onPress={() => moveCommand(index, -1)} disabled={index === 0}>
                        <Svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                          <Path d="M18 15l-6-6-6 6" stroke={index === 0 ? '#444' : '#aaa'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </Svg>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => moveCommand(index, 1)} disabled={index === customCommands.length - 1}>
                        <Svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                          <Path d="M6 9l6 6 6-6" stroke={index === customCommands.length - 1 ? '#444' : '#aaa'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </Svg>
                      </TouchableOpacity>
                    </View>
                  </View>
                  <View style={styles.commandRow}>
                    <Text style={styles.commandText} numberOfLines={1} adjustsFontSizeToFit>{item.command}</Text>
                    <TouchableOpacity style={styles.execBtn} onPress={() => executeCommand(item.command)}>
                      <Text style={styles.execBtnText}>执行</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              contentContainerStyle={styles.commandList}
            />
            <TouchableOpacity style={styles.addCommandBtn} onPress={addNewCommand}>
              <Text style={styles.addCommandText}>+ 添加新命令</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Edit Command Modal */}
      <Modal
        visible={showEditModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowEditModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.editModalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingCommand.id ? '编辑命令' : '添加命令'}
              </Text>
              <TouchableOpacity onPress={() => setShowEditModal(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.editForm}>
              <Text style={styles.inputLabel}>命令名称</Text>
              <TextInput
                style={styles.input}
                value={editingCommand.name}
                onChangeText={(text) => setEditingCommand(prev => ({ ...prev, name: text }))}
                placeholder="例如: Git Status"
                placeholderTextColor="#666"
              />
              <Text style={styles.inputLabel}>命令内容</Text>
              <TextInput
                style={[styles.input, styles.commandInput]}
                value={editingCommand.command}
                onChangeText={(text) => setEditingCommand(prev => ({ ...prev, command: text }))}
                placeholder="例如: git status"
                placeholderTextColor="#666"
                multiline
              />
            </View>
            <View style={styles.editActions}>
              <TouchableOpacity
                style={[styles.editActionBtn, styles.cancelBtn]}
                onPress={() => setShowEditModal(false)}
              >
                <Text style={styles.cancelBtnText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.editActionBtn, styles.saveBtn]}
                onPress={saveCommand}
              >
                <Text style={styles.saveBtnText}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Keyboard Combo Modal */}
      <Modal
        visible={showKeyboardModal}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setShowKeyboardModal(false);
          setSelectedModifiers([]);
        }}
      >
        <View style={styles.keyboardModalOverlay}>
          <View style={styles.keyboardModalContent}>
            <View style={styles.keyboardHeader}>
              <Text style={styles.keyboardTitle}>组合键面板</Text>
              <TouchableOpacity onPress={() => {
                setShowKeyboardModal(false);
                setSelectedModifiers([]);
              }}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Selected Modifiers Display */}
            <View style={styles.selectedModifiersContainer}>
              <Text style={styles.selectedModifiersLabel}>已选修饰键：</Text>
              <View style={styles.selectedModifiersList}>
                {selectedModifiers.length === 0 ? (
                  <Text style={styles.noModifiersText}>无</Text>
                ) : (
                  selectedModifiers.map(mod => (
                    <View key={mod} style={styles.selectedModifierChip}>
                      <Text style={styles.selectedModifierText}>{mod.toUpperCase()}</Text>
                    </View>
                  ))
                )}
              </View>
            </View>

            {/* Modifier Keys Section */}
            <View style={styles.keyboardSection}>
              <Text style={styles.sectionTitle}>修饰键（可多选）</Text>
              <View style={styles.modifierRow}>
                <TouchableOpacity
                  style={[
                    styles.modifierBtn,
                    selectedModifiers.includes('ctrl') && styles.modifierBtnActive
                  ]}
                  onPress={() => toggleModifier('ctrl')}
                >
                  <Text style={[
                    styles.modifierSymbol,
                    selectedModifiers.includes('ctrl') && styles.modifierBtnTextActive
                  ]}>⌃</Text>
                  <Text style={[
                    styles.modifierBtnText,
                    selectedModifiers.includes('ctrl') && styles.modifierBtnTextActive
                  ]}>Ctrl</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.modifierBtn,
                    selectedModifiers.includes('shift') && styles.modifierBtnActive
                  ]}
                  onPress={() => toggleModifier('shift')}
                >
                  <Text style={[
                    styles.modifierSymbol,
                    selectedModifiers.includes('shift') && styles.modifierBtnTextActive
                  ]}>⇧</Text>
                  <Text style={[
                    styles.modifierBtnText,
                    selectedModifiers.includes('shift') && styles.modifierBtnTextActive
                  ]}>Shift</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.modifierBtn,
                    selectedModifiers.includes('alt') && styles.modifierBtnActive
                  ]}
                  onPress={() => toggleModifier('alt')}
                >
                  <Text style={[
                    styles.modifierSymbol,
                    selectedModifiers.includes('alt') && styles.modifierBtnTextActive
                  ]}>⌥</Text>
                  <Text style={[
                    styles.modifierBtnText,
                    selectedModifiers.includes('alt') && styles.modifierBtnTextActive
                  ]}>Alt/Opt</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.modifierBtn,
                    selectedModifiers.includes('cmd') && styles.modifierBtnActive
                  ]}
                  onPress={() => toggleModifier('cmd')}
                >
                  <Text style={[
                    styles.modifierSymbol,
                    selectedModifiers.includes('cmd') && styles.modifierBtnTextActive
                  ]}>⌘</Text>
                  <Text style={[
                    styles.modifierBtnText,
                    selectedModifiers.includes('cmd') && styles.modifierBtnTextActive
                  ]}>Cmd</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Number Keys Section */}
            <View style={styles.keyboardSection}>
              <Text style={styles.sectionTitle}>数字键</Text>
              <View style={styles.numberKeyRow}>
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map(num => (
                  <TouchableOpacity
                    key={num}
                    style={styles.numberKeyBtn}
                    onPress={() => sendComboKey(num)}
                  >
                    <Text style={styles.numberKeyText}>{num}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Character Keys Section */}
            {selectedModifiers.length > 0 && (
              <View style={styles.keyboardSection}>
                <Text style={styles.sectionTitle}>字母键</Text>
                <View style={styles.qwertyRow}>
                  {'qwertyuiop'.split('').map(char => (
                    <TouchableOpacity
                      key={char}
                      style={styles.charKeyBtn}
                      onPress={() => sendComboKey(char)}
                    >
                      <Text style={styles.charKeyText}>{char.toUpperCase()}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.qwertyRow}>
                  {'asdfghjkl'.split('').map(char => (
                    <TouchableOpacity
                      key={char}
                      style={styles.charKeyBtn}
                      onPress={() => sendComboKey(char)}
                    >
                      <Text style={styles.charKeyText}>{char.toUpperCase()}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.qwertyRow}>
                  {'zxcvbnm'.split('').map(char => (
                    <TouchableOpacity
                      key={char}
                      style={styles.charKeyBtn}
                      onPress={() => sendComboKey(char)}
                    >
                      <Text style={styles.charKeyText}>{char.toUpperCase()}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={[styles.sectionTitle, styles.sectionTitleSpaced]}>符号键</Text>
                <View style={styles.symbolRow}>
                  {['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '{', '}', '|', ':', '"', '<', '>', '?'].map(char => (
                    <TouchableOpacity
                      key={char}
                      style={styles.symbolKeyBtn}
                      onPress={() => sendComboKey(char)}
                    >
                      <Text style={styles.charKeyText}>{char}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* Config Modal */}
      <Modal
        visible={showConfigModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowConfigModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.editModalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>应用配置</Text>
              <TouchableOpacity onPress={() => setShowConfigModal(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.editForm}>
              <Text style={styles.inputLabel}>服务器地址</Text>
              <TextInput
                style={styles.input}
                value={tempIp}
                onChangeText={setTempIp}
                placeholder="192.168.1.100:8080"
                placeholderTextColor="#666"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={styles.configHint}>格式: IP:端口</Text>
              <Text style={styles.inputLabel}>密钥</Text>
              <TextInput
                style={styles.input}
                value={tempToken}
                onChangeText={setTempToken}
                placeholder="token"
                placeholderTextColor="#666"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={styles.inputLabel}>终端字体大小</Text>
              <View style={styles.fontSizeRow}>
                <TouchableOpacity
                  style={styles.fontSizeBtn}
                  onPress={() => setTempFontSize(s => String(Math.max(8, parseInt(s, 10) - 1)))}
                >
                  <Text style={styles.fontSizeBtnText}>−</Text>
                </TouchableOpacity>
                <TextInput
                  style={[styles.input, styles.fontSizeInput]}
                  value={tempFontSize}
                  onChangeText={setTempFontSize}
                  keyboardType="number-pad"
                  placeholderTextColor="#666"
                />
                <TouchableOpacity
                  style={styles.fontSizeBtn}
                  onPress={() => setTempFontSize(s => String(Math.min(32, parseInt(s, 10) + 1)))}
                >
                  <Text style={styles.fontSizeBtnText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>
            <View style={styles.editActions}>
              <TouchableOpacity
                style={[styles.editActionBtn, styles.cancelBtn]}
                onPress={() => setShowConfigModal(false)}
              >
                <Text style={styles.cancelBtnText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.editActionBtn, styles.saveBtn]}
                onPress={handleSaveConfig}
              >
                <Text style={styles.saveBtnText}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Console Switcher Modal */}
      <Modal
        visible={showConsoleModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowConsoleModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>控制台</Text>
              <TouchableOpacity onPress={() => setShowConsoleModal(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <FlatList
              data={consoleSessions}
              keyExtractor={(item) => item.name}
              contentContainerStyle={styles.consoleList}
              renderItem={({ item }) => {
                const isActive = item.name === activeConsole;

                return (
                  <View
                    style={[styles.consoleItem, isActive && styles.consoleItemActive]}
                  >
                    <TouchableOpacity
                      style={styles.consoleItemMain}
                      onPress={() => switchConsole(item.name)}
                    >
                      <View style={[styles.consoleIndicator, isActive && styles.consoleIndicatorActive]} />
                      <View style={styles.consoleTextBlock}>
                        <Text style={styles.consoleName} numberOfLines={1}>
                          {item.name}
                        </Text>
                        <Text style={styles.consoleMeta}>
                          {item.windows || 0} 个窗口 · {item.attached || 0} 个连接
                        </Text>
                      </View>
                    </TouchableOpacity>
                    <View style={styles.consoleItemActions}>
                      {isActive && <Text style={styles.consoleActiveText}>当前</Text>}
                      <TouchableOpacity
                        style={styles.consoleCloseBtn}
                        onPress={() => closeConsole(item.name)}
                      >
                        <Text style={styles.consoleCloseText}>关闭</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              }}
              ListEmptyComponent={
                <View style={styles.emptyList}>
                  <Text style={styles.emptyText}>
                    {consoleListLoading
                      ? '正在加载控制台...'
                      : (consoleListError ? `加载失败：${consoleListError}` : '暂无可切换控制台')}
                  </Text>
                </View>
              }
            />

            <View style={styles.consoleActions}>
              <TouchableOpacity style={styles.consoleActionBtn} onPress={requestConsoleList}>
                <Text style={styles.consoleActionText}>刷新列表</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.consoleActionBtn, styles.consoleCreateBtn]} onPress={handleNewSession}>
                <Text style={styles.consoleCreateText}>新建控制台</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* File Browser Modal */}
      <Modal
        visible={showFileBrowser}
        transparent
        animationType="fade"
        onRequestClose={() => setShowFileBrowser(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>文件浏览器</Text>
              <TouchableOpacity onPress={() => setShowFileBrowser(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Current Path and Navigation */}
            <View style={styles.pathBar}>
              <TouchableOpacity
                style={styles.upButton}
                onPress={navigateUp}
                disabled={!currentPath || currentPath === '/'}
              >
                <Svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <Path d="M19 12H5M12 19l-7-7 7-7" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </Svg>
                <Text style={styles.upButtonText}>上级</Text>
              </TouchableOpacity>
              <ScrollView horizontal style={styles.pathScroll}>
                <Text style={styles.pathText}>{currentPath || '/'}</Text>
              </ScrollView>
            </View>

            {/* Directory Items List */}
            <FlatList
              data={directoryItems}
              keyExtractor={(item, index) => `${item.path}-${index}`}
              renderItem={({ item }) => (
                <View style={styles.fileItem}>
                  <TouchableOpacity
                    style={styles.fileItemContent}
                    onPress={() => handleItemPress(item)}
                  >
                    <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      {item.isDirectory ? (
                        <Path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" stroke="#ffa500" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      ) : (
                        <Path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9l-7-7z" stroke="#aaa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      )}
                    </Svg>
                    <Text style={styles.fileName} numberOfLines={1}>
                      {item.name}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.selectButton}
                    onPress={() => selectPath(item.path)}
                  >
                    <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      <Circle cx="12" cy="12" r="10" stroke="#007AFF" strokeWidth="2"/>
                      <Path d="M9 12l2 2 4-4" stroke="#007AFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </Svg>
                  </TouchableOpacity>
                </View>
              )}
              contentContainerStyle={styles.fileList}
              ListEmptyComponent={
                <View style={styles.emptyList}>
                  <Text style={styles.emptyText}>目录为空</Text>
                </View>
              }
            />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1e1e1e',
  },
  keyboardAvoider: {
    flex: 1,
  },
  mainContent: {
    flex: 1,
    position: 'relative',
  },
  connectionConfigHint: {
    backgroundColor: '#171717',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#2b2b2b',
    alignItems: 'center',
  },
  connectionConfigHintText: {
    color: '#9a9a9a',
    fontSize: 12,
  },
  statusBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 15,
    paddingVertical: 8,
    backgroundColor: '#2d2d2d',
    borderBottomWidth: 1,
    borderBottomColor: '#3d3d3d',
    gap: 10,
  },
  statusLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  statusRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0,
  },
  statusBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusConnected: {
    backgroundColor: '#34c759',
  },
  statusDisconnected: {
    backgroundColor: '#6f6f6f',
  },
  statusText: {
    color: '#aaa',
    fontSize: 12,
  },
  consoleChip: {
    flexShrink: 1,
    maxWidth: 130,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: '#1d1d1d',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#424242',
  },
  consoleChipText: {
    color: '#d8d8d8',
    fontSize: 11,
    fontWeight: '600',
  },
  terminal: {
    flex: 1,
    marginBottom: 10,
    backgroundColor: '#1e1e1e',
  },
  webviewFallback: {
    flex: 1,
    marginBottom: 10,
    backgroundColor: '#1e1e1e',
  },
  terminalPlaceholder: {
    flex: 1,
    marginBottom: 10,
    backgroundColor: '#1e1e1e',
  },
  extraKeys: {
    gap: 8,
    paddingTop: 8,
    paddingBottom: 10,
    paddingHorizontal: 10,
    backgroundColor: '#252525',
    borderTopWidth: 1,
    borderTopColor: '#3d3d3d',
  },
  extraKeysRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  keyBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#3a3a3a',
    borderRadius: 4,
    minWidth: 40,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  keyboardToggleBtn: {
    minWidth: 54,
  },
  keyboardToggleBtnActive: {
    backgroundColor: '#157347',
    borderWidth: 1,
    borderColor: '#2fb36f',
  },
  keyboardToggleBtnTextActive: {
    color: '#e9fff0',
  },
  spaceKeyBtn: {
    minWidth: 88,
  },
  keyText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 0,
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 16,
    paddingHorizontal: 15,
    backgroundColor: '#2d2d2d',
    borderTopWidth: 1,
    borderTopColor: '#3d3d3d',
  },
  toolbarBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  toolbarLabel: {
    color: '#aaa',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 4,
  },
  imeKeyboardDock: {
    height: 376,
    minHeight: 340,
    width: '100%',
    alignSelf: 'stretch',
    backgroundColor: '#1a1a1a',
    borderTopWidth: 1,
    borderTopColor: '#323232',
    overflow: 'hidden',
  },
  imeKeyboardDockHidden: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
    minHeight: 1,
    opacity: 0,
    overflow: 'hidden',
    zIndex: -1,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalContent: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    width: '100%',
    maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  modalTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  modalClose: {
    color: '#666',
    fontSize: 22,
    fontWeight: '300',
  },
  commandList: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  consoleList: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  consoleItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#222',
    borderRadius: 6,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#2f2f2f',
    gap: 12,
  },
  consoleItemActive: {
    backgroundColor: '#263126',
    borderColor: '#3b6d46',
  },
  consoleItemMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
    paddingRight: 4,
  },
  consoleIndicator: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#6f6f6f',
  },
  consoleIndicatorActive: {
    backgroundColor: '#34c759',
  },
  consoleTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  consoleName: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  consoleMeta: {
    color: '#777',
    fontSize: 11,
    marginTop: 3,
  },
  consoleActiveText: {
    color: '#8edc9a',
    fontSize: 12,
    fontWeight: '600',
  },
  consoleItemActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  consoleCloseBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#332222',
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#5a3030',
  },
  consoleCloseText: {
    color: '#ff8f8f',
    fontSize: 12,
    fontWeight: '600',
  },
  consoleActions: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
  },
  consoleActionBtn: {
    flex: 1,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  consoleCreateBtn: {
    backgroundColor: '#2a2a2a',
    borderLeftWidth: 1,
    borderLeftColor: '#343434',
  },
  consoleActionText: {
    color: '#aaa',
    fontSize: 14,
    fontWeight: '500',
  },
  consoleCreateText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  commandItem: {
    backgroundColor: '#222',
    borderRadius: 6,
    marginBottom: 8,
    padding: 12,
  },
  commandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  commandName: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
    minWidth: 0,
  },
  commandText: {
    flex: 1,
    color: '#777',
    fontSize: 12,
    fontFamily: 'monospace',
    minWidth: 0,
  },
  execBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#3a3a3a',
    borderRadius: 4,
    marginLeft: 8,
    borderWidth: 1,
    borderColor: '#555',
  },
  execBtnText: {
    color: '#ccc',
    fontSize: 12,
    fontWeight: '500',
  },
  sortBtns: {
    flexDirection: 'row',
    gap: 4,
    marginLeft: 4,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtn: {
    borderLeftWidth: 1,
    borderLeftColor: '#2a2a2a',
  },
  actionBtnText: {
    color: '#aaa',
    fontSize: 13,
    fontWeight: '400',
  },
  deleteBtnText: {
    color: '#888',
  },
  addCommandBtn: {
    marginHorizontal: 12,
    marginVertical: 10,
    padding: 12,
    backgroundColor: '#2a2a2a',
    borderRadius: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  addCommandText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  editModalContent: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    width: '100%',
    maxWidth: 360,
  },
  editForm: {
    padding: 16,
  },
  inputLabel: {
    color: '#999',
    fontSize: 12,
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    backgroundColor: '#222',
    borderRadius: 6,
    padding: 10,
    color: '#fff',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  commandInput: {
    minHeight: 70,
    textAlignVertical: 'top',
  },
  urlInput: {
    minHeight: 60,
    textAlignVertical: 'top',
  },
  configHint: {
    color: '#666',
    fontSize: 11,
    marginTop: 6,
    fontStyle: 'italic',
  },
  fontSizeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  fontSizeBtn: {
    width: 36,
    height: 36,
    backgroundColor: '#3a3a3a',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fontSizeBtnText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '600',
  },
  fontSizeInput: {
    flex: 1,
    textAlign: 'center',
    minHeight: 0,
  },
  editActions: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
  },
  editActionBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: {
    borderRightWidth: 1,
    borderRightColor: '#2a2a2a',
  },
  cancelBtnText: {
    color: '#777',
    fontSize: 15,
    fontWeight: '400',
  },
  saveBtn: {
    backgroundColor: '#2a2a2a',
  },
  saveBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
  },
  keyboardModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
    justifyContent: 'flex-end',
  },
  keyboardModalContent: {
    backgroundColor: '#1a1a1a',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '90%',
    paddingBottom: 10,
  },
  imeKeyboardWebview: {
    flex: 1,
    width: '100%',
    alignSelf: 'stretch',
    backgroundColor: '#1f1f1f',
  },
  keyboardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  keyboardTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  selectedModifiersContainer: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#222',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  selectedModifiersLabel: {
    color: '#999',
    fontSize: 11,
    marginBottom: 4,
  },
  selectedModifiersList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  noModifiersText: {
    color: '#666',
    fontSize: 12,
    fontStyle: 'italic',
  },
  selectedModifierChip: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  selectedModifierText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  keyboardSection: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  sectionTitle: {
    color: '#aaa',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },
  sectionTitleSpaced: {
    marginTop: 8,
  },
  modifierRow: {
    flexDirection: 'row',
    gap: 6,
  },
  modifierBtn: {
    flex: 1,
    paddingVertical: 6,
    backgroundColor: '#2a2a2a',
    borderRadius: 6,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#2a2a2a',
  },
  modifierBtnActive: {
    backgroundColor: '#007AFF',
    borderColor: '#0066DD',
  },
  modifierSymbol: {
    color: '#aaa',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 1,
  },
  modifierBtnText: {
    color: '#aaa',
    fontSize: 9,
    fontWeight: '600',
  },
  modifierBtnTextActive: {
    color: '#fff',
  },
  numberKeyRow: {
    flexDirection: 'row',
    gap: 5,
  },
  numberKeyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  numberKeyBtn: {
    flex: 1,
    paddingVertical: 12,
    backgroundColor: '#2a2a2a',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  numberKeyText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  quickComboGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  quickComboBtn: {
    width: '31%',
    paddingVertical: 10,
    paddingHorizontal: 8,
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    alignItems: 'center',
  },
  quickComboLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  quickComboDesc: {
    color: '#888',
    fontSize: 10,
  },
  qwertyRow: {
    flexDirection: 'row',
    gap: 3,
    marginBottom: 3,
    justifyContent: 'center',
  },
  symbolRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 3,
    justifyContent: 'flex-start',
  },
  charKeyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 6,
  },
  charKeyBtn: {
    flex: 1,
    minWidth: 26,
    height: 32,
    backgroundColor: '#2a2a2a',
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  symbolKeyBtn: {
    minWidth: 28,
    height: 32,
    paddingHorizontal: 6,
    backgroundColor: '#2a2a2a',
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  charKeyText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  overlay: {
    position: 'absolute',
    bottom: 120,
    left: 15,
    right: 15,
    backgroundColor: '#2a2a2a',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#444',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 10,
  },
  overlayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  overlayTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  closeBtn: {
    padding: 4,
  },
  closeBtnText: {
    color: '#888',
    fontSize: 20,
    fontWeight: '600',
  },
  overlayMessage: {
    color: '#ccc',
    fontSize: 13,
    marginBottom: 12,
    lineHeight: 18,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: '#007AFF',
    borderRadius: 8,
    minWidth: 80,
    alignItems: 'center',
  },
  optionBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  scrollControls: {
    position: 'absolute',
    right: 10,
    top: '50%',
    transform: [{ translateY: -100 }],
    backgroundColor: 'rgba(42, 42, 42, 0.9)',
    borderRadius: 8,
    padding: 8,
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 4,
    elevation: 5,
  },
  scrollBtn: {
    width: 40,
    height: 40,
    backgroundColor: '#3a3a3a',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#4a4a4a',
  },
  scrollToggleBtn: {
    backgroundColor: '#555',
    marginTop: 4,
  },
  scrollToggleText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  showScrollBtn: {
    position: 'absolute',
    right: 10,
    top: '50%',
    transform: [{ translateY: -20 }],
    width: 40,
    height: 40,
    backgroundColor: 'rgba(42, 42, 42, 0.8)',
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 4,
    elevation: 5,
  },
  pathBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#222',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
    gap: 8,
  },
  upButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#3a3a3a',
    borderRadius: 6,
    gap: 4,
  },
  upButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
  },
  pathScroll: {
    flex: 1,
  },
  pathText: {
    color: '#aaa',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  fileList: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  fileItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#222',
    borderRadius: 6,
    marginBottom: 6,
    overflow: 'hidden',
  },
  fileItemContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 10,
  },
  fileName: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
  },
  selectButton: {
    padding: 12,
    backgroundColor: '#2a2a2a',
    borderLeftWidth: 1,
    borderLeftColor: '#333',
  },
  emptyList: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyText: {
    color: '#666',
    fontSize: 14,
    fontStyle: 'italic',
  },
});
