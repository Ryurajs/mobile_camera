import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type DeviceCredentials = { deviceId: string; pairingKey: string };
type IncomingRequest = { requestId: string; browserName?: string };
type RelayMessage = {
  type?: string;
  requestId?: string;
  deviceId?: string;
  accepted?: boolean;
  message?: string;
};

const CREDENTIALS_KEY = 'camera-device-credentials';
const RELAY_URL = process.env.EXPO_PUBLIC_SIGNALING_URL ??
  (process.env.EXPO_PUBLIC_SIGNALING_HOST
    ? `wss://${process.env.EXPO_PUBLIC_SIGNALING_HOST}`
    : 'ws://localhost:8787');

function createCredentials(): DeviceCredentials {
  const bytes = Crypto.getRandomBytes(4);
  const number = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return {
    deviceId: String((number % 90_000_000) + 10_000_000),
    pairingKey: Crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase(),
  };
}

function send(socket: WebSocket | null, data: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}

export default function App() {
  return Platform.OS === 'web' ? <BrowserPanel /> : <PhonePanel />;
}

function PhonePanel() {
  const socketRef = useRef<WebSocket | null>(null);
  const [credentials, setCredentials] = useState<DeviceCredentials | null>(null);
  const [connection, setConnection] = useState('Connecting to relay');
  const [incoming, setIncoming] = useState<IncomingRequest | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [permission, requestPermission] = useCameraPermissions();

  useEffect(() => {
    let mounted = true;

    async function loadCredentials() {
      const saved = await SecureStore.getItemAsync(CREDENTIALS_KEY);
      const value = saved ? (JSON.parse(saved) as DeviceCredentials) : createCredentials();
      if (!saved) await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify(value));
      if (mounted) setCredentials(value);
    }

    loadCredentials().catch(() => setNotice('Could not initialize this device. Restart the app and try again.'));
    return () => {
      mounted = false;
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!credentials) return;
    let stopped = false;
    let retryDelay = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      if (stopped) return;
      const socket = new WebSocket(RELAY_URL);
      socketRef.current = socket;
      socket.onopen = () => {
        retryDelay = 1000;
        setConnection('Connected');
        socket.send(JSON.stringify({ type: 'register', ...credentials }));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as RelayMessage;
        if (message.type === 'request' && message.requestId) {
          setIncoming({ requestId: message.requestId, browserName: message.message });
        }
        if (message.type === 'error') setNotice(message.message ?? 'Relay error');
        if (message.type === 'closed') setCameraOpen(false);
      };
      socket.onerror = () => setConnection('Connection error');
      socket.onclose = () => {
        if (socketRef.current === socket) setConnection('Disconnected');
        if (!stopped) {
          retryTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30_000);
        }
      };
    }

    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, [credentials]);

  async function answerRequest(accepted: boolean) {
    if (!incoming) return;
    if (accepted) {
      const result = permission?.granted ? permission : await requestPermission();
      if (!result.granted) {
        send(socketRef.current, { type: 'response', requestId: incoming.requestId, accepted: false });
        setNotice('Camera permission was not granted. The request was declined.');
        setIncoming(null);
        return;
      }
      setCameraOpen(true);
      setNotice('Camera is active. The preview is visible on this phone.');
    }
    send(socketRef.current, { type: 'response', requestId: incoming.requestId, accepted });
    setIncoming(null);
  }

  if (!credentials) {
    return <Centered><ActivityIndicator color="#c9f36a" /><Text style={styles.muted}>Preparing this phone</Text></Centered>;
  }

  if (cameraOpen) {
    return (
      <SafeAreaView style={styles.cameraScreen}>
        <StatusBar style="light" />
        <CameraView style={styles.camera} facing="back" />
        <View style={styles.cameraOverlay}>
          <View style={styles.liveTag}><View style={styles.liveDot} /><Text style={styles.liveText}>CAMERA ACTIVE</Text></View>
          <Text style={styles.cameraCaption}>This phone&apos;s camera is on</Text>
          <Pressable style={styles.stopButton} onPress={() => setCameraOpen(false)}>
            <Text style={styles.stopButtonText}>Stop camera</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.phoneContent}>
        <View style={styles.topline}><Text style={styles.brand}>LANTERN / CAMERA LINK</Text><View style={styles.connection}><View style={[styles.connectionDot, connection === 'Connected' && styles.online]} /><Text style={styles.connectionText}>{connection}</Text></View></View>
        <Text style={styles.eyebrow}>PHONE RECEIVER</Text>
        <Text style={styles.title}>Your camera,{ '\n' }your call.</Text>
        <Text style={styles.subtitle}>A browser can ask to connect. Nothing opens until you approve it here.</Text>

        <View style={styles.identityPanel}>
          <Text style={styles.panelLabel}>THIS PHONE&apos;S NUMBER</Text>
          <Text selectable style={styles.deviceNumber}>{credentials.deviceId}</Text>
          <Text style={styles.panelFootnote}>Share this number with the person you want to receive a camera request from.</Text>
        </View>

        {incoming ? (
          <View style={styles.requestPanel}>
            <Text style={styles.requestKicker}>INCOMING REQUEST</Text>
            <Text style={styles.requestTitle}>Someone wants to open this camera.</Text>
            <Text style={styles.requestBody}>The camera permission prompt will appear only after you tap Accept.</Text>
            <View style={styles.actionRow}>
              <Pressable style={styles.acceptButton} onPress={() => answerRequest(true)}><Text style={styles.acceptText}>Accept</Text></Pressable>
              <Pressable style={styles.declineButton} onPress={() => answerRequest(false)}><Text style={styles.declineText}>Decline</Text></Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.waitingRow}><View style={styles.waitingPulse} /><Text style={styles.waitingText}>Waiting for a browser request</Text></View>
        )}
        {!!notice && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
        <Text style={styles.footer}>The preview stays on this phone. Use Stop camera to end it at any time.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function BrowserPanel() {
  const socketRef = useRef<WebSocket | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [status, setStatus] = useState('Enter the phone number to begin.');
  const [pending, setPending] = useState(false);

  useEffect(() => () => socketRef.current?.close(), []);

  function requestCamera() {
    const cleanedId = deviceId.replace(/\D/g, '');
    if (!/^\d{8}$/.test(cleanedId)) {
      setStatus('Enter the 8-digit phone number.');
      return;
    }
    socketRef.current?.close();
    setStatus('Connecting to phone…');
    setPending(true);
    const socket = new WebSocket(RELAY_URL);
    socketRef.current = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'request', deviceId: cleanedId }));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as RelayMessage;
      if (message.type === 'queued') setStatus('Request sent. Approve it on the phone.');
      if (message.type === 'response') {
        setStatus(message.accepted ? 'Approved on the phone. Its camera preview is open.' : 'The request was declined.');
        setPending(false);
        socket.close();
      }
      if (message.type === 'error') {
        setStatus(message.message ?? 'Could not reach that phone.');
        setPending(false);
        socket.close();
      }
    };
    socket.onerror = () => { setStatus('Could not connect to the relay. Check its address and try again.'); setPending(false); };
    socket.onclose = () => setPending(false);
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.webContent}>
        <View style={styles.topline}><Text style={styles.brand}>LANTERN / CAMERA LINK</Text><Text style={styles.webTag}>BROWSER REQUESTER</Text></View>
        <Text style={styles.eyebrow}>REMOTE CAMERA</Text>
        <Text style={styles.title}>Ask first.{ '\n' }Always.</Text>
        <Text style={styles.subtitle}>Send a request to a paired phone. The person holding it decides whether to open the camera.</Text>
        <View style={styles.formPanel}>
          <Text style={styles.panelLabel}>PHONE NUMBER</Text>
          <TextInput value={deviceId} onChangeText={setDeviceId} keyboardType="number-pad" maxLength={8} placeholder="8-digit number" placeholderTextColor="#738078" style={styles.input} />
          <Pressable accessibilityRole="button" disabled={pending} style={[styles.requestButton, pending && styles.disabledButton]} onPress={requestCamera}>
            <Text style={styles.requestButtonText}>{pending ? 'Request pending' : 'Request camera access'}</Text>
            <Text style={styles.requestArrow}>&gt;</Text>
          </Pressable>
          <Text accessibilityRole="status" style={styles.statusText}>{status}</Text>
        </View>
        <View style={styles.infoLine}><Text style={styles.infoIndex}>01</Text><Text style={styles.infoText}>The phone shows who is asking and waits for a decision.</Text></View>
        <View style={styles.infoLine}><Text style={styles.infoIndex}>02</Text><Text style={styles.infoText}>Camera permission is requested only after the phone&apos;s owner accepts.</Text></View>
        <Text style={styles.footer}>This starter opens the camera preview on the phone; it does not stream video to this page.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <SafeAreaView style={styles.screen}><View style={styles.centered}>{children}</View></SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101714' },
  phoneContent: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 18, paddingBottom: 36, maxWidth: 560, width: '100%', alignSelf: 'center' },
  webContent: { flexGrow: 1, paddingHorizontal: 28, paddingTop: 34, paddingBottom: 50, maxWidth: 760, width: '100%', alignSelf: 'center' },
  topline: { minHeight: 34, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 58 },
  brand: { color: '#c9f36a', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  connection: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  connectionDot: { width: 7, height: 7, borderRadius: 5, backgroundColor: '#797f7b' },
  online: { backgroundColor: '#c9f36a' },
  connectionText: { color: '#9da8a0', fontSize: 11 },
  webTag: { color: '#a4afa7', fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  eyebrow: { color: '#c9f36a', fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginBottom: 12 },
  title: { color: '#f1f4ef', fontSize: 48, lineHeight: 51, fontWeight: '700', letterSpacing: 0, marginBottom: 16 },
  subtitle: { color: '#a8b2aa', fontSize: 16, lineHeight: 24, maxWidth: 530, marginBottom: 32 },
  identityPanel: { borderWidth: 1, borderColor: '#39443c', backgroundColor: '#171f1a', padding: 20, borderRadius: 6, marginBottom: 20 },
  panelLabel: { color: '#91a095', fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  deviceNumber: { color: '#f1f4ef', fontSize: 34, fontWeight: '700', letterSpacing: 2, marginTop: 8 },
  panelFootnote: { color: '#88958b', fontSize: 12, marginTop: 12 },
  waitingRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4 },
  waitingPulse: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#c9f36a' },
  waitingText: { color: '#c4cdc6', fontSize: 14 },
  requestPanel: { borderLeftWidth: 3, borderLeftColor: '#c9f36a', backgroundColor: '#202a23', padding: 20, borderRadius: 4, marginBottom: 18 },
  requestKicker: { color: '#c9f36a', fontSize: 10, fontWeight: '800', letterSpacing: 1.3, marginBottom: 12 },
  requestTitle: { color: '#f3f5f1', fontSize: 20, lineHeight: 27, fontWeight: '700' },
  requestBody: { color: '#a8b2aa', fontSize: 13, lineHeight: 20, marginTop: 8, marginBottom: 20 },
  actionRow: { flexDirection: 'row', gap: 10 },
  acceptButton: { backgroundColor: '#c9f36a', minHeight: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, borderRadius: 4 },
  acceptText: { color: '#182016', fontSize: 14, fontWeight: '800' },
  declineButton: { borderWidth: 1, borderColor: '#657168', minHeight: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, borderRadius: 4 },
  declineText: { color: '#edf1ec', fontSize: 14, fontWeight: '700' },
  notice: { color: '#c9f36a', fontSize: 12, marginTop: 8, lineHeight: 18 },
  footer: { color: '#78847b', fontSize: 11, lineHeight: 17, marginTop: 'auto', paddingTop: 28 },
  formPanel: { borderWidth: 1, borderColor: '#3b463e', backgroundColor: '#171f1a', padding: 22, borderRadius: 6, marginBottom: 28 },
  input: { minHeight: 52, borderBottomWidth: 1, borderBottomColor: '#59645b', color: '#f2f5f0', fontSize: 18, paddingHorizontal: 2 },
  requestButton: { minHeight: 56, backgroundColor: '#c9f36a', borderRadius: 4, marginTop: 28, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  disabledButton: { opacity: 0.55 },
  requestButtonText: { color: '#182016', fontSize: 15, fontWeight: '800' },
  requestArrow: { color: '#182016', fontSize: 20, fontWeight: '700' },
  statusText: { color: '#a8b2aa', fontSize: 12, lineHeight: 18, marginTop: 16, minHeight: 18 },
  infoLine: { flexDirection: 'row', gap: 16, paddingVertical: 15, borderTopWidth: 1, borderTopColor: '#303b33' },
  infoIndex: { color: '#c9f36a', fontSize: 11, fontWeight: '800', paddingTop: 2 },
  infoText: { color: '#c1cbc3', fontSize: 13, lineHeight: 19, flex: 1 },
  cameraScreen: { flex: 1, backgroundColor: '#050706' },
  camera: { flex: 1 },
  cameraOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 24, paddingTop: 32, paddingBottom: 36, backgroundColor: 'rgba(8, 13, 9, 0.78)' },
  liveTag: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#19231c', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 3 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#c9f36a' },
  liveText: { color: '#d8e5d7', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  cameraCaption: { color: '#f3f5f1', fontSize: 21, fontWeight: '700', marginTop: 14, marginBottom: 18 },
  stopButton: { minHeight: 50, borderWidth: 1, borderColor: '#b3c0b5', borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  stopButtonText: { color: '#f3f5f1', fontSize: 14, fontWeight: '700' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  muted: { color: '#a8b2aa', fontSize: 13 },
});
