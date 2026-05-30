import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Animated,
  Keyboard,
  TextInput,
  Platform,
} from 'react-native';
import { Link } from 'expo-router';
import { Audio, AudioMode } from 'expo-av';
import { Screen } from '@/components/Screen';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome6 } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { createFormDataFile } from '@/utils';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';

const EXPO_PUBLIC_BACKEND_BASE_URL = process.env.EXPO_PUBLIC_BACKEND_BASE_URL || '';
const API_BASE = `${EXPO_PUBLIC_BACKEND_BASE_URL}/api/v1`;

interface Message {
  id: string;
  type: 'user' | 'ai';
  text: string;
  timestamp: string;
}

type AppStatus = 'connected' | 'listening' | 'waiting' | 'error';

function formatTime(date: Date): string {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

const DEVICE_ID_KEY = 'xiao_claw_device_id';

export default function ChatPage() {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<Message[]>([]);
  const [appStatus, setAppStatus] = useState<AppStatus>('connected');
  const [isRecording, setIsRecording] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [deviceId, setDeviceId] = useState<string>('');
  const [hasLoadedHistory, setHasLoadedHistory] = useState(false);
  const [docMode, setDocMode] = useState(false);
  const [isUploadingDoc, setIsUploadingDoc] = useState(false);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pollCountRef = useRef(0);
  const syncTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastSyncCountRef = useRef(0);

  // 初始化设备ID
  useEffect(() => {
    const initDeviceId = async () => {
      try {
        let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
        if (!id) {
          id = Crypto.randomUUID();
          await AsyncStorage.setItem(DEVICE_ID_KEY, id);
        }
        setDeviceId(id);
      } catch {
        const fallback = Crypto.randomUUID();
        setDeviceId(fallback);
      }
    };
    initDeviceId();
  }, []);

  // 加载历史消息
  const loadHistory = useCallback(async () => {
    if (!deviceId) return;
    try {
      /**
       * 服务端文件：server/src/index.ts
       * 接口：GET /api/v1/history
       * Query 参数：device_id: string
       */
      const res = await fetch(`${API_BASE}/history?device_id=${encodeURIComponent(deviceId)}`);
      if (!res.ok) throw new Error('Failed to load history');
      const data = await res.json();
      if (data.messages && Array.isArray(data.messages)) {
        const loaded: Message[] = data.messages.map((m: any) => ({
          id: m.id,
          type: m.type,
          text: m.text,
          timestamp: m.timestamp ? formatTime(new Date(m.timestamp)) : formatTime(new Date()),
        }));
        setMessages(loaded);
      }
    } catch (err) {
      console.error('Load history error', err);
    } finally {
      setHasLoadedHistory(true);
    }
  }, [deviceId]);

  useEffect(() => {
    if (deviceId && !hasLoadedHistory) {
      loadHistory();
    }
  }, [deviceId, hasLoadedHistory, loadHistory]);

  // 脉冲动画
  useEffect(() => {
    if (isRecording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.15,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isRecording, pulseAnim]);

  // 请求录音权限
  const requestPermission = useCallback(async () => {
    const { status } = await Audio.requestPermissionsAsync();
    setHasPermission(status === 'granted');
    return status === 'granted';
  }, []);

  // 初始化音频模式
  useEffect(() => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
    } as AudioMode);
    requestPermission();
  }, [requestPermission]);

  // 开始录音
  const startRecording = useCallback(async () => {
    Keyboard.dismiss();
    const permitted = hasPermission || (await requestPermission());
    if (!permitted) {
      setAppStatus('error');
      return;
    }

    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      } as AudioMode);

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.LOW_QUALITY
      );
      recordingRef.current = recording;
      setIsRecording(true);
      setAppStatus('listening');
      setInputText('');
    } catch (err) {
      console.error('Failed to start recording', err);
      setAppStatus('error');
    }
  }, [hasPermission, requestPermission]);

  // 停止录音并上传识别
  const stopRecording = useCallback(async () => {
    setIsRecording(false);
    setIsTranscribing(true);
    setAppStatus('waiting');

    try {
      const recording = recordingRef.current;
      if (!recording) {
        setIsTranscribing(false);
        setAppStatus('connected');
        return;
      }

      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      recordingRef.current = null;

      if (!uri) {
        setIsTranscribing(false);
        setAppStatus('connected');
        return;
      }

      // 上传音频到后端进行ASR识别
      /**
       * 服务端文件：server/src/index.ts
       * 接口：POST /api/v1/transcribe
       * Body：FormData，字段名 audio（音频文件）
       */
      const formData = new FormData();
      const audioFile = await createFormDataFile(uri, 'recording.m4a', 'audio/m4a');
      formData.append('audio', audioFile as any);

      const response = await fetch(`${API_BASE}/transcribe`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('ASR request failed');
      }

      const data = await response.json();
      if (data.text) {
        setInputText(data.text);
      }
    } catch (err) {
      console.error('Failed to stop/upload recording', err);
    } finally {
      setIsTranscribing(false);
      setAppStatus('connected');
    }
  }, []);

  // 文档上传与解析
  const handleUploadDoc = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'text/plain',
          'text/markdown',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'text/csv',
          'application/json',
        ],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      setIsUploadingDoc(true);
      setAppStatus('waiting');

      const formData = new FormData();
      const docFile = await createFormDataFile(asset.uri, asset.name, asset.mimeType || 'application/octet-stream');
      formData.append('doc', docFile as any);

      /**
       * 服务端文件：server/src/index.ts
       * 接口：POST /api/v1/upload-doc
       * Body：FormData，字段名 doc（文档文件）
       */
      const response = await fetch(`${API_BASE}/upload-doc`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Document upload failed');
      }

      const data = await response.json();
      if (data.text) {
        setInputText(data.text);
      }
    } catch (err) {
      console.error('Upload doc error:', err);
    } finally {
      setIsUploadingDoc(false);
      setAppStatus('connected');
    }
  }, []);

  // 发送消息
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isSending) return;

    setIsSending(true);
    setInputText('');
    setIsTyping(true);
    setAppStatus('waiting');

    const userMsg: Message = {
      id: Date.now().toString(),
      type: 'user',
      text,
      timestamp: formatTime(new Date()),
    };
    setMessages(prev => [...prev, userMsg]);

    try {
      /**
       * 服务端文件：server/src/index.ts
       * 接口：POST /api/v1/send
       * Body 参数：text: string, device_id: string, doc_mode?: boolean
       */
      const sendRes = await fetch(`${API_BASE}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, device_id: deviceId, doc_mode: docMode }),
      });

      if (!sendRes.ok) {
        throw new Error('Send failed');
      }

      const sendData = await sendRes.json();
      if (!sendData.ok || !sendData.id) {
        throw new Error('Invalid send response');
      }

      // 开始轮询
      pollCountRef.current = 0;
      const doPoll = async () => {
        if (pollCountRef.current >= 90) {
          setIsTyping(false);
          setIsSending(false);
          setAppStatus('connected');
          const timeoutMsg: Message = {
            id: `timeout-${Date.now()}`,
            type: 'ai',
            text: '等待超时，再说一遍？',
            timestamp: formatTime(new Date()),
          };
          setMessages(prev => [...prev, timeoutMsg]);
          return;
        }

        pollCountRef.current += 1;

        try {
          /**
           * 服务端文件：server/src/index.ts
           * 接口：GET /api/v1/poll
           * Query 参数：id: string
           */
          const pollRes = await fetch(`${API_BASE}/poll?id=${sendData.id}`);
          const pollData = await pollRes.json();

          if (pollData.status === 'error') {
            setIsTyping(false);
            setIsSending(false);
            setAppStatus('error');
            const errMsg: Message = {
              id: `ai-${sendData.id}`,
              type: 'ai',
              text: `【错误】${pollData.error || 'AI回复失败'}`,
              timestamp: formatTime(new Date()),
            };
            setMessages(prev => [...prev, errMsg]);
            return;
          }

          if (pollData.reply != null) {
            setAppStatus('connected');
            // 更新或添加AI消息（streaming时更新内容，done时停止轮询）
            setMessages(prev => {
              const existingIndex = prev.findIndex(m => m.id === `ai-${sendData.id}`);
              if (existingIndex >= 0) {
                const updated = [...prev];
                updated[existingIndex] = { ...updated[existingIndex], text: pollData.reply };
                return updated;
              }
              return [...prev, {
                id: `ai-${sendData.id}`,
                type: 'ai',
                text: pollData.reply,
                timestamp: formatTime(new Date()),
              }];
            });

            if (pollData.status === 'done') {
              setIsTyping(false);
              setIsSending(false);
              return;
            }
          }

          pollTimerRef.current = setTimeout(doPoll, 2000);
        } catch (err) {
          console.error('Poll error', err);
          pollTimerRef.current = setTimeout(doPoll, 2000);
        }
      };

      doPoll();
    } catch (err) {
      console.error('Send error', err);
      setIsTyping(false);
      setIsSending(false);
      setAppStatus('error');
      const errorMsg: Message = {
        id: `err-${Date.now()}`,
        type: 'ai',
        text: '网络开小差了，稍后再试',
        timestamp: formatTime(new Date()),
      };
      setMessages(prev => [...prev, errorMsg]);
    }
  }, [inputText, isSending, deviceId, docMode]);

  // 定时同步历史消息（多端准实时同步）
  const syncHistory = useCallback(async () => {
    if (!deviceId || isSending || isTyping) return;
    try {
      const res = await fetch(`${API_BASE}/history?device_id=${encodeURIComponent(deviceId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.messages && Array.isArray(data.messages)) {
        const dbCount = data.messages.length;
        if (dbCount > lastSyncCountRef.current) {
          lastSyncCountRef.current = dbCount;
          const loaded: Message[] = data.messages.map((m: any) => ({
            id: m.id,
            type: m.type,
            text: m.text,
            timestamp: m.timestamp ? formatTime(new Date(m.timestamp)) : formatTime(new Date()),
          }));
          setMessages(loaded);
        }
      }
    } catch {
      // 静默忽略同步失败
    }
  }, [deviceId, isSending, isTyping]);

  // 页面聚焦时刷新历史
  useFocusEffect(
    useCallback(() => {
      loadHistory();
      // 启动定时同步（每5秒）
      syncTimerRef.current = setInterval(syncHistory, 5000);
      return () => {
        if (syncTimerRef.current) {
          clearInterval(syncTimerRef.current);
          syncTimerRef.current = null;
        }
      };
    }, [loadHistory, syncHistory])
  );

  // 清理轮询定时器
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
      if (syncTimerRef.current) {
        clearInterval(syncTimerRef.current);
      }
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => { /* ignore */ });
      }
    };
  }, []);

  const renderMessage = useCallback(({ item }: { item: Message }) => {
    const isUser = item.type === 'user';
    return (
      <View
        className={`flex flex-col ${isUser ? 'items-end self-end' : 'items-start self-start'}`}
        style={{ maxWidth: '90%', marginBottom: 8 }}
      >
        {!isUser && (
          <Text className="text-[9px] text-accent mb-0.5 ml-1">雨润Claw</Text>
        )}
        <View
          className={`px-3 py-2 rounded-xl ${
            isUser ? 'bg-accent' : 'bg-[#1E1E1E]'
          }`}
          style={{ minWidth: isUser ? undefined : 40 }}
        >
          {isUser ? (
            <Text className="text-sm leading-relaxed text-white">
              {item.text}
            </Text>
          ) : (
            <Markdown
              style={{
                body: { color: '#E0E0E0', fontSize: 14, lineHeight: 20 },
                heading1: { color: '#E0E0E0', fontSize: 18, fontWeight: 'bold', marginVertical: 8 },
                heading2: { color: '#E0E0E0', fontSize: 16, fontWeight: 'bold', marginVertical: 6 },
                heading3: { color: '#E0E0E0', fontSize: 14, fontWeight: 'bold', marginVertical: 4 },
                strong: { color: '#ffffff', fontWeight: 'bold' },
                paragraph: { color: '#E0E0E0', fontSize: 14, lineHeight: 20, marginVertical: 2 },
                bullet_list: { marginVertical: 2 },
                ordered_list: { marginVertical: 2 },
                list_item: { marginVertical: 1 },
                link: { color: '#1A73E8' },
                code_inline: { backgroundColor: '#333', color: '#E0E0E0', paddingHorizontal: 4, borderRadius: 4, fontSize: 12 },
                code_block: { backgroundColor: '#1A1A1A', padding: 8, borderRadius: 8, fontSize: 12 },
                blockquote: { borderLeftWidth: 3, borderLeftColor: '#1A73E8', paddingLeft: 8, marginVertical: 4 },
              }}
            >
              {item.text}
            </Markdown>
          )}
        </View>
        <Text className="text-[8px] text-white/30 mt-0.5 mx-1">
          {item.timestamp}
        </Text>
      </View>
    );
  }, []);

  const getStatusDisplay = () => {
    switch (appStatus) {
      case 'connected':
        return { text: '已连接', color: '#43A047', icon: 'circle' as const };
      case 'listening':
        return { text: '聆听中', color: '#C62828', icon: 'microphone' as const };
      case 'waiting':
        return { text: '等待AI回复', color: '#f59e0b', icon: 'hourglass-half' as const };
      case 'error':
        return { text: '连接异常', color: '#C62828', icon: 'circle-exclamation' as const };
      default:
        return { text: '已连接', color: '#43A047', icon: 'circle' as const };
    }
  };

  const statusDisplay = getStatusDisplay();

  return (
    <Screen
      statusBarStyle="light"
      backgroundColor="#0D0D0D"
      safeAreaEdges={['top', 'left', 'right']}
    >
      <View className="flex-1 flex flex-col" style={{ backgroundColor: '#0D0D0D' }}>
        {/* 顶部标题栏 */}
        <View className="h-10 flex flex-col items-center justify-center shrink-0">
          <Text className="text-base font-bold text-white tracking-wide">
            雨润 Claw
          </Text>
          <Text className="text-[9px] text-[#888888] leading-tight mt-0.5">
            Adam&apos;s AI · 抬腕说话
          </Text>
        </View>

        {/* 状态栏 + 模式切换 */}
        <View className="h-5 flex flex-row items-center justify-center shrink-0 gap-2">
          <View className="flex flex-row items-center gap-1">
            <FontAwesome6
              name={statusDisplay.icon}
              size={8}
              color={statusDisplay.color}
            />
            <Text style={{ color: statusDisplay.color, fontSize: 10 }}>
              {statusDisplay.text}
            </Text>
          </View>
          <Link href="/knowledge-base" asChild>
            <TouchableOpacity
              activeOpacity={0.7}
              className="flex flex-row items-center gap-1 px-2 py-0.5 rounded-full"
              style={{ backgroundColor: 'rgba(26,115,232,0.2)' }}
            >
              <FontAwesome6
                name="book"
                size={8}
                color="#1A73E8"
              />
              <Text style={{ color: '#1A73E8', fontSize: 9 }}>
                知识库
              </Text>
            </TouchableOpacity>
          </Link>
          <TouchableOpacity
            onPress={() => setDocMode(v => !v)}
            activeOpacity={0.7}
            className="flex flex-row items-center gap-1 px-2 py-0.5 rounded-full"
            style={{ backgroundColor: docMode ? 'rgba(26,115,232,0.2)' : 'transparent' }}
          >
            <FontAwesome6
              name={docMode ? 'file-lines' : 'comment'}
              size={8}
              color={docMode ? '#1A73E8' : '#666666'}
            />
            <Text style={{ color: docMode ? '#1A73E8' : '#666666', fontSize: 9 }}>
              {docMode ? '文档' : '对话'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* 聊天记录区 */}
        <View className="flex-1 relative">
          {/* 雨润水印背景 */}
          <View className="absolute inset-0 items-center justify-center pointer-events-none" style={{ zIndex: 0 }}>
            <Text
              className="text-white/[0.03] font-bold rotate-[-15deg]"
              style={{ fontSize: 56, letterSpacing: 8 }}
            >
              雨润
            </Text>
          </View>

          <FlatList
            ref={flatListRef}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={item => item.id}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: 8,
              paddingBottom: 8,
              flexGrow: 1,
              justifyContent: 'flex-end',
            }}
            onContentSizeChange={() => {
              flatListRef.current?.scrollToEnd({ animated: true });
            }}
            onLayout={() => {
              flatListRef.current?.scrollToEnd({ animated: false });
            }}
            nestedScrollEnabled={true}
            scrollEventThrottle={16}
            className="flex-1"
            style={{ zIndex: 1 }}
          />
        </View>

        {/* 输入状态指示器 */}
        {isTyping && (
          <View className="h-[30px] flex items-center justify-center shrink-0">
            <View className="flex flex-row items-center gap-1">
              <Text className="text-[10px] text-[#888888]">正在输入</Text>
              <View className="flex flex-row items-center gap-0.5">
                <View className="w-1 h-1 rounded-full bg-[#666666] animate-bounce" />
                <View
                  className="w-1 h-1 rounded-full bg-[#666666] animate-bounce"
                  style={{ animationDelay: '200ms' }}
                />
                <View
                  className="w-1 h-1 rounded-full bg-[#666666] animate-bounce"
                  style={{ animationDelay: '400ms' }}
                />
              </View>
            </View>
          </View>
        )}

        {/* 语音识别中指示器 */}
        {isTranscribing && (
          <View className="h-[30px] flex items-center justify-center shrink-0">
            <View className="flex flex-row items-center gap-1">
              <FontAwesome6 name="spinner" size={10} color="#888888" />
              <Text className="text-[10px] text-[#888888]">语音识别中…</Text>
            </View>
          </View>
        )}

        {/* 文档上传中指示器 */}
        {isUploadingDoc && (
          <View className="h-[30px] flex items-center justify-center shrink-0">
            <View className="flex flex-row items-center gap-1">
              <FontAwesome6 name="spinner" size={10} color="#888888" />
              <Text className="text-[10px] text-[#888888]">文档解析中…</Text>
            </View>
          </View>
        )}

        {/* 底部输入栏 */}
        <View
          className="px-4 pt-2 pb-3 flex flex-row items-center gap-2 shrink-0"
          style={{ paddingBottom: insets.bottom + 12 }}
        >
          {/* 文档上传按钮 */}
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={handleUploadDoc}
            disabled={isSending || isTranscribing || isUploadingDoc}
            className="w-9 h-9 rounded-full items-center justify-center shrink-0"
            style={{
              backgroundColor: '#1A1A1A',
              borderWidth: 1,
              borderColor: '#333333',
            }}
          >
            <FontAwesome6
              name="file-arrow-up"
              size={14}
              color="#888888"
            />
          </TouchableOpacity>

          {/* 麦克风按钮 */}
          <TouchableOpacity
            activeOpacity={0.8}
            onPressIn={startRecording}
            onPressOut={stopRecording}
            disabled={isSending || isTranscribing}
            className="w-11 h-11 rounded-full items-center justify-center shrink-0"
            style={{
              backgroundColor: isRecording ? '#C62828' : '#1A1A1A',
              borderWidth: 1,
              borderColor: isRecording ? '#C62828' : '#333333',
            }}
          >
            <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
              <FontAwesome6
                name="microphone"
                size={16}
                color={isRecording ? '#ffffff' : '#888888'}
              />
            </Animated.View>
          </TouchableOpacity>

          {/* 文本输入框 */}
          <TextInput
            className="flex-1 h-11 rounded-[22px] px-4 text-sm text-white"
            style={{
              backgroundColor: '#1A1A1A',
              borderWidth: 1,
              borderColor: '#333333',
              lineHeight: Platform.OS === 'ios' ? 20 : undefined,
            }}
            placeholder="按住麦克风说话，或输入文字…"
            placeholderTextColor="#666666"
            value={inputText}
            onChangeText={setInputText}
            editable={!isSending && !isTranscribing}
            multiline={false}
            returnKeyType="send"
            onSubmitEditing={handleSend}
            selectionColor="#1A73E8"
          />

          {/* 发送按钮 */}
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={handleSend}
            disabled={!inputText.trim() || isSending}
            className="w-11 h-11 rounded-full items-center justify-center shrink-0"
            style={{
              backgroundColor:
                inputText.trim() && !isSending ? '#1A73E8' : '#333333',
            }}
          >
            <FontAwesome6
              name="arrow-right"
              size={16}
              color={inputText.trim() && !isSending ? '#ffffff' : '#888888'}
            />
          </TouchableOpacity>
        </View>
      </View>
    </Screen>
  );
}
