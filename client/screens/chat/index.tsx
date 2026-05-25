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
import { Audio, AudioMode } from 'expo-av';
import { Screen } from '@/components/Screen';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome6 } from '@expo/vector-icons';
import { createFormDataFile } from '@/utils';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

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
       * Body 参数：text: string, device_id: string
       */
      const sendRes = await fetch(`${API_BASE}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, device_id: deviceId }),
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

          if (pollData.reply != null) {
            setIsTyping(false);
            setIsSending(false);
            setAppStatus('connected');
            const aiMsg: Message = {
              id: `ai-${sendData.id}`,
              type: 'ai',
              text: pollData.reply,
              timestamp: formatTime(new Date()),
            };
            setMessages(prev => [...prev, aiMsg]);
            return;
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
  }, [inputText, isSending, deviceId]);

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
        >
          <Text
            className={`text-sm leading-relaxed ${
              isUser ? 'text-white' : 'text-[#E0E0E0]'
            }`}
          >
            {item.text}
          </Text>
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
            Adam's AI · 抬腕说话
          </Text>
        </View>

        {/* 状态栏 */}
        <View className="h-5 flex items-center justify-center shrink-0">
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

        {/* 底部输入栏 */}
        <View
          className="px-4 pt-2 pb-3 flex flex-row items-center gap-2 shrink-0"
          style={{ paddingBottom: insets.bottom + 12 }}
        >
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
