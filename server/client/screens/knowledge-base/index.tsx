import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useFocusEffect } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createFormDataFile } from '@/utils';

const EXPO_PUBLIC_BACKEND_BASE_URL = process.env.EXPO_PUBLIC_BACKEND_BASE_URL || 'http://localhost:9091';

interface KBDocument {
  id: number;
  title: string;
  content_preview: string;
  file_type: string;
  created_at: string;
}

export default function KnowledgeBasePage() {
  const [documents, setDocuments] = useState<KBDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const router = useSafeRouter();

  // 获取设备ID（与chat页面一致）
  useEffect(() => {
    (async () => {
      const key = 'device_id';
      let stored = await AsyncStorage.getItem(key);
      if (!stored) {
        stored = Crypto.randomUUID();
        await AsyncStorage.setItem(key, stored);
      }
      setDeviceId(stored);
    })();
  }, []);

  const fetchDocs = useCallback(async () => {
    if (!deviceId) return;
    try {
      const res = await fetch(`${EXPO_PUBLIC_BACKEND_BASE_URL}/api/v1/knowledge/list?device_id=${deviceId}`);
      const data = await res.json();
      if (data.documents) {
        setDocuments(data.documents);
      }
    } catch (err) {
      console.warn('Failed to fetch KB docs:', err);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useFocusEffect(
    useCallback(() => {
      if (deviceId) fetchDocs();
    }, [deviceId])
  );

  const handleUpload = async () => {
    if (uploading) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/plain', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/csv'],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) return;

      const file = result.assets[0];
      setUploading(true);

      const docFile = await createFormDataFile(file.uri, file.name, file.mimeType || 'application/octet-stream');
      const formData = new FormData();
      formData.append('doc', docFile as any);

      const res = await fetch(`${EXPO_PUBLIC_BACKEND_BASE_URL}/api/v1/knowledge/upload?device_id=${deviceId}`, {
        method: 'POST',
        body: formData as any,
      });

      const data = await res.json();
      setUploading(false);

      if (data.error) {
        Alert.alert('上传失败', data.error);
        return;
      }

      Alert.alert('上传成功', `"${data.title}" 已添加到知识库`);
      fetchDocs();
    } catch (err) {
      setUploading(false);
      Alert.alert('上传失败', '请检查网络后重试');
    }
  };

  const handleDelete = async (doc: KBDocument) => {
    Alert.alert(
      '删除文档',
      `确定删除「${doc.title}」吗？`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            try {
              await fetch(`${EXPO_PUBLIC_BACKEND_BASE_URL}/api/v1/knowledge/delete?id=${doc.id}&device_id=${deviceId}`, {
                method: 'DELETE',
              });
              fetchDocs();
            } catch (err) {
              console.warn('Delete failed:', err);
            }
          },
        },
      ]
    );
  };

  const renderItem = ({ item }: { item: KBDocument }) => (
    <View style={styles.docCard}>
      <View style={styles.docHeader}>
        <Text style={styles.docTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.docType}>{item.file_type.toUpperCase()}</Text>
      </View>
      <Text style={styles.docPreview} numberOfLines={3}>{item.content_preview}</Text>
      <View style={styles.docFooter}>
        <Text style={styles.docDate}>{new Date(item.created_at).toLocaleDateString('zh-CN')}</Text>
        <TouchableOpacity onPress={() => handleDelete(item)} style={styles.deleteBtn}>
          <Text style={styles.deleteBtnText}>删除</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <Screen>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← 返回</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>知识库</Text>
        <View style={styles.placeholder} />
      </View>

      <View style={styles.statsBar}>
        <Text style={styles.statsText}>已收录 {documents.length} 篇文档</Text>
        <TouchableOpacity onPress={handleUpload} disabled={uploading} style={styles.uploadBtn}>
          {uploading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.uploadBtnText}>+ 上传文档</Text>
          )}
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}><ActivityIndicator size="large" color="#1A73E8" /></View>
      ) : documents.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>知识库为空</Text>
          <Text style={styles.emptySubtitle}>上传文档后，AI可基于知识库内容回答问题</Text>
          <TouchableOpacity onPress={handleUpload} style={styles.emptyUploadBtn}>
            <Text style={styles.emptyUploadBtnText}>上传第一篇文档</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={documents}
          renderItem={renderItem}
          keyExtractor={item => String(item.id)}
          contentContainerStyle={styles.listContent}
          nestedScrollEnabled
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  backBtn: { padding: 4 },
  backBtnText: { color: '#1A73E8', fontSize: 14 },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  placeholder: { width: 50 },
  statsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#1A1A1A',
    borderRadius: 10,
  },
  statsText: { color: '#888', fontSize: 12 },
  uploadBtn: {
    backgroundColor: '#1A73E8',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    minWidth: 90,
    alignItems: 'center',
  },
  uploadBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  docCard: {
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  docHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  docTitle: { flex: 1, color: '#fff', fontSize: 14, fontWeight: '600' },
  docType: {
    color: '#1A73E8',
    fontSize: 10,
    fontWeight: '700',
    backgroundColor: 'rgba(26,115,232,0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 8,
    overflow: 'hidden',
  },
  docPreview: { color: '#888', fontSize: 12, lineHeight: 18, marginBottom: 10 },
  docFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  docDate: { color: '#555', fontSize: 11 },
  deleteBtn: { padding: 4 },
  deleteBtnText: { color: '#E53935', fontSize: 12 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  emptySubtitle: { color: '#666', fontSize: 13, textAlign: 'center', marginBottom: 20 },
  emptyUploadBtn: {
    backgroundColor: '#1A73E8',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  emptyUploadBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
