import { useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import {
  RTCIceCandidate,
  RTCSessionDescription,
  RTCPeerConnection,
  RTCView,
  mediaDevices,
  type MediaStream,
} from 'react-native-webrtc';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type DeviceCredentials = { deviceId: string; pairingKey: string };
type IncomingRequest = { requestId: string };
type SessionDescriptionPayload = { type: 'offer' | 'answer'; sdp: string };
type RelayMessage = {
  type?: string;
  requestId?: string;
  deviceId?: string;
  accepted?: boolean;
  message?: string;
  description?: SessionDescriptionPayload;
  candidate?: RTCIceCandidateInit | null;
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
  const socketRef = useRef<WebSocket | null>(null);
  const autoAcceptRef = useRef(false);
  const answerRequestRef = useRef<((accepted: boolean, requestId?: string) => void) | null>(null);
  const incomingRequestIdRef = useRef<string | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const candidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const promptedForPermissionRef = useRef(false);
  const [credentials, setCredentials] = useState<DeviceCredentials | null>(null);
  const [connection, setConnection] = useState('Connecting to relay');
  const [incoming, setIncoming] = useState<IncomingRequest | null>(null);
  const [autoAccept, setAutoAccept] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [previewDimensions, setPreviewDimensions] = useState<{ width: number; height: number } | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!permission || permission.granted || promptedForPermissionRef.current) return;
    promptedForPermissionRef.current = true;
    void requestPermission();
  }, [permission, requestPermission]);

  useEffect(() => {
    let mounted = true;
    async function loadCredentials() {
      const saved = await SecureStore.getItemAsync(CREDENTIALS_KEY);
      const value = saved ? (JSON.parse(saved) as DeviceCredentials) : createCredentials();
      if (!saved) await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify(value));
      if (mounted) setCredentials(value);
    }
    loadCredentials().catch(() => setNotice('Could not initialize this phone. Restart the app and try again.'));
    return () => { mounted = false; };
  }, []);

  const stopSession = useCallback((notifyPeer = false) => {
    const requestId = requestIdRef.current;
    if (notifyPeer && requestId) send(socketRef.current, { type: 'disconnect', requestId });
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    requestIdRef.current = null;
    candidatesRef.current = [];
    setLocalStream(null);
    setPreviewDimensions(null);
  }, []);

  const stopSessionRef = useRef(stopSession);
  useEffect(() => {
    stopSessionRef.current = stopSession;
  }, [stopSession]);

  useEffect(() => {
    if (!credentials) return;
    let stopped = false;
    let retryDelay = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    async function applyQueuedCandidates(peer: RTCPeerConnection, requestId: string) {
      if (peerRef.current !== peer || requestIdRef.current !== requestId) return;
      const queued = candidatesRef.current;
      candidatesRef.current = [];
      for (const candidate of queued) await peer.addIceCandidate(new RTCIceCandidate(candidate));
    }

    async function answerOffer(requestId: string, description: SessionDescriptionPayload) {
      const peer = peerRef.current;
      if (!peer || requestIdRef.current !== requestId) return;
      try {
        await peer.setRemoteDescription(new RTCSessionDescription(description));
        if (peerRef.current !== peer || requestIdRef.current !== requestId) return;
        await applyQueuedCandidates(peer, requestId);
        const answer = await peer.createAnswer();
        if (peerRef.current !== peer || requestIdRef.current !== requestId) return;
        await peer.setLocalDescription(answer);
        if (peerRef.current !== peer || requestIdRef.current !== requestId) return;
        send(socketRef.current, { type: 'answer', requestId, description: { type: 'answer', sdp: answer.sdp ?? '' } });
      } catch {
        if (peerRef.current === peer && requestIdRef.current === requestId) {
          setNotice('Could not establish the camera connection. Try again.');
          stopSessionRef.current(true);
        }
      }
    }

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
          incomingRequestIdRef.current = message.requestId;
          setIncoming({ requestId: message.requestId });
          if (autoAcceptRef.current) void answerRequestRef.current?.(true, message.requestId);
        }
        if (message.type === 'offer' && message.description && message.requestId) {
          void answerOffer(message.requestId, message.description);
        }
        if (message.type === 'answer' && message.description && peerRef.current && message.requestId === requestIdRef.current) {
          void peerRef.current.setRemoteDescription(new RTCSessionDescription(message.description))
            .then(() => {
              const peer = peerRef.current;
              const requestId = message.requestId;
              if (peer && requestId) return applyQueuedCandidates(peer, requestId);
            });
        }
        if (message.type === 'candidate' && message.candidate && peerRef.current && message.requestId === requestIdRef.current) {
          if (peerRef.current.remoteDescription) void peerRef.current.addIceCandidate(new RTCIceCandidate(message.candidate));
          else candidatesRef.current.push(message.candidate);
        }
        if (message.type === 'disconnect' || message.type === 'closed') {
          const closesSession = message.requestId === requestIdRef.current;
          const closesRequest = message.requestId === incomingRequestIdRef.current;
          if (!closesSession && !closesRequest) return;
          if (closesSession) stopSessionRef.current();
          if (closesRequest) {
            incomingRequestIdRef.current = null;
            setIncoming(null);
          }
          setNotice(message.message ?? 'The camera session ended.');
        }
        if (message.type === 'error') setNotice(message.message ?? 'Relay error');
      };
      socket.onerror = () => setConnection('Connection error');
      socket.onclose = () => {
        if (socketRef.current === socket) {
          setConnection('Disconnected');
          stopSessionRef.current();
        }
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
      stopSessionRef.current();
    };
  }, [credentials]);

  const answerRequest = useCallback(async (accepted: boolean, requestIdOverride?: string) => {
    const requestId = requestIdOverride ?? incoming?.requestId;
    if (!requestId) return;
    if (incomingRequestIdRef.current === requestId) incomingRequestIdRef.current = null;
    setIncoming(null);
    if (!accepted) {
      send(socketRef.current, { type: 'response', requestId, accepted: false });
      return;
    }

    requestIdRef.current = requestId;
    let sessionStream: MediaStream | null = null;
    let sessionPeer: RTCPeerConnection | null = null;
    try {
      const result = permission?.granted ? permission : await requestPermission();
      if (requestIdRef.current !== requestId) return;
      if (!result.granted) {
        send(socketRef.current, { type: 'response', requestId, accepted: false });
        requestIdRef.current = null;
        setNotice('Camera permission is required to start the approved session.');
        return;
      }
      const stream = await mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'environment', width: 640, height: 480, frameRate: 15 },
      });
      sessionStream = stream;
      if (requestIdRef.current !== requestId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      sessionPeer = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      streamRef.current = stream;
      peerRef.current = peer;
      peer.addEventListener('icecandidate', (event) => {
        const candidate = (event as unknown as { candidate?: RTCIceCandidate | null }).candidate;
        if (candidate) send(socketRef.current, { type: 'candidate', requestId, candidate: candidate.toJSON() });
      });
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed' && peerRef.current === peer && requestIdRef.current === requestId) {
          setNotice('The network could not connect the camera. Try again.');
          stopSession(true);
        }
      };
      setLocalStream(stream);
      setNotice('Camera is shared with the approved browser session.');
      send(socketRef.current, { type: 'response', requestId, accepted: true });
      const offer = await peer.createOffer();
      if (peerRef.current !== peer || requestIdRef.current !== requestId) return;
      await peer.setLocalDescription(offer);
      if (peerRef.current !== peer || requestIdRef.current !== requestId) return;
      send(socketRef.current, { type: 'offer', requestId, description: { type: 'offer', sdp: offer.sdp ?? '' } });
    } catch {
      if (requestIdRef.current === requestId) {
        send(socketRef.current, { type: 'response', requestId, accepted: false });
        stopSession();
        setNotice('Could not start the camera. Check permission and try again.');
      } else {
        sessionPeer?.close();
        sessionStream?.getTracks().forEach((track) => track.stop());
      }
    }
  }, [incoming, permission, requestPermission, stopSession]);
  useEffect(() => {
    answerRequestRef.current = answerRequest;
  }, [answerRequest]);

  function toggleAutoAccept() {
    const enabled = !autoAccept;
    autoAcceptRef.current = enabled;
    setAutoAccept(enabled);
    if (enabled && incoming) void answerRequest(true, incoming.requestId);
  }

  if (!credentials) {
    return <Centered><ActivityIndicator color="#c9f36a" /><Text style={styles.muted}>Preparing this phone</Text></Centered>;
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      {localStream ? (
        <View style={styles.cameraScreen}>
          <RTCView
            style={styles.camera}
            streamURL={localStream.toURL()}
            objectFit="cover"
            onDimensionsChange={({ nativeEvent }) => setPreviewDimensions(nativeEvent)}
          />
          <View style={styles.cameraOverlay}>
            <View style={styles.liveTag}><View style={styles.liveDot} /><Text style={styles.liveText}>CAMERA SHARED</Text></View>
            <Text style={styles.cameraCaption}>Your camera is visible to the approved browser.</Text>
            <Text style={styles.cameraStatus}>
              {previewDimensions
                ? `Receiving camera frames (${previewDimensions.width} x ${previewDimensions.height})`
                : 'Waiting for camera frames'}
            </Text>
            <AutoAcceptControl enabled={autoAccept} onToggle={toggleAutoAccept} />
            <Pressable style={styles.stopButton} onPress={() => stopSession(true)}><Text style={styles.stopButtonText}>Stop sharing</Text></Pressable>
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.phoneContent}>
          <View style={styles.topline}><Text style={styles.brand}>LANTERN / CAMERA LINK</Text><View style={styles.connection}><View style={[styles.connectionDot, connection === 'Connected' && styles.online]} /><Text style={styles.connectionText}>{connection}</Text></View></View>
          <Text style={styles.eyebrow}>PHONE RECEIVER</Text>
          <Text style={styles.title}>Your camera,{ '\n' }your call.</Text>
          <Text style={styles.subtitle}>Camera permission is requested on first launch. Requests need your approval unless session-only auto-accept is enabled.</Text>
          <View style={styles.identityPanel}>
            <Text style={styles.panelLabel}>THIS PHONE&apos;S NUMBER</Text>
            <Text selectable style={styles.deviceNumber}>{credentials.deviceId}</Text>
            <Text style={styles.panelFootnote}>Share this number with the person who should be able to request a session.</Text>
          </View>
          <AutoAcceptControl enabled={autoAccept} onToggle={toggleAutoAccept} />
          {incoming ? (
            <View style={styles.requestPanel}>
              <Text style={styles.requestKicker}>INCOMING REQUEST</Text>
              <Text style={styles.requestTitle}>Share live camera video with the browser?</Text>
              <Text style={styles.requestBody}>Your camera turns on only after you accept. Stop sharing here at any time.</Text>
              <View style={styles.actionRow}>
                <Pressable style={styles.acceptButton} onPress={() => void answerRequest(true)}><Text style={styles.acceptText}>Accept</Text></Pressable>
                <Pressable style={styles.declineButton} onPress={() => void answerRequest(false)}><Text style={styles.declineText}>Decline</Text></Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.waitingRow}><View style={styles.waitingPulse} /><Text style={styles.waitingText}>Waiting for a browser request</Text></View>
          )}
          {!!notice && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
          {!permission?.granted && <Pressable style={styles.permissionButton} onPress={() => void requestPermission()}><Text style={styles.permissionText}>Allow camera access</Text></Pressable>}
          <Text style={styles.footer}>The phone stays in the foreground while receiving requests.</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <SafeAreaView style={styles.screen}><View style={styles.centered}>{children}</View></SafeAreaView>;
}

function AutoAcceptControl({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <View style={styles.autoAcceptRow}>
      <View style={styles.autoAcceptCopy}>
        <Text style={styles.autoAcceptTitle}>Auto-accept requests</Text>
        <Text style={styles.autoAcceptHint}>Turns on the camera for incoming requests. Resets when the app closes.</Text>
      </View>
      <Pressable accessibilityRole="switch" accessibilityLabel="Auto-accept requests" accessibilityState={{ checked: enabled }} onPress={onToggle}>
        <View style={[styles.switchTrack, enabled && styles.switchOn]}><View style={[styles.switchThumb, enabled && styles.switchThumbOn]} /></View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101714' },
  phoneContent: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 18, paddingBottom: 36, maxWidth: 560, width: '100%', alignSelf: 'center' },
  topline: { minHeight: 34, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 58 },
  brand: { color: '#c9f36a', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  connection: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  connectionDot: { width: 7, height: 7, borderRadius: 5, backgroundColor: '#797f7b' },
  online: { backgroundColor: '#c9f36a' },
  connectionText: { color: '#9da8a0', fontSize: 11 },
  eyebrow: { color: '#c9f36a', fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginBottom: 12 },
  title: { color: '#f1f4ef', fontSize: 48, lineHeight: 51, fontWeight: '700', marginBottom: 16 },
  subtitle: { color: '#a8b2aa', fontSize: 16, lineHeight: 24, maxWidth: 530, marginBottom: 32 },
  identityPanel: { borderWidth: 1, borderColor: '#39443c', backgroundColor: '#171f1a', padding: 20, borderRadius: 6, marginBottom: 20 },
  panelLabel: { color: '#91a095', fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  deviceNumber: { color: '#f1f4ef', fontSize: 34, fontWeight: '700', letterSpacing: 2, marginTop: 8 },
  panelFootnote: { color: '#88958b', fontSize: 12, marginTop: 12 },
  autoAcceptRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#303b33', marginBottom: 18 },
  autoAcceptCopy: { flex: 1, gap: 4 },
  autoAcceptTitle: { color: '#e5ebe5', fontSize: 13, fontWeight: '700' },
  autoAcceptHint: { color: '#98a49b', fontSize: 11, lineHeight: 16 },
  switchTrack: { width: 46, height: 28, borderRadius: 14, backgroundColor: '#49554c', justifyContent: 'center', padding: 3 },
  switchOn: { backgroundColor: '#7fae3d' },
  switchThumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#f3f5f1' },
  switchThumbOn: { alignSelf: 'flex-end' },
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
  permissionButton: { alignSelf: 'flex-start', marginTop: 14, paddingVertical: 12, paddingHorizontal: 16, borderWidth: 1, borderColor: '#69766b', borderRadius: 4 },
  permissionText: { color: '#eaf0e8', fontSize: 13, fontWeight: '700' },
  footer: { color: '#78847b', fontSize: 11, lineHeight: 17, marginTop: 'auto', paddingTop: 28 },
  cameraScreen: { flex: 1, backgroundColor: '#050706' },
  camera: { flex: 1 },
  cameraOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 24, paddingTop: 32, paddingBottom: 36, backgroundColor: 'rgba(8, 13, 9, 0.78)' },
  liveTag: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#19231c', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 3 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#c9f36a' },
  liveText: { color: '#d8e5d7', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  cameraCaption: { color: '#f3f5f1', fontSize: 19, lineHeight: 25, fontWeight: '700', marginTop: 14, marginBottom: 18 },
  cameraStatus: { color: '#a8b2aa', fontSize: 12, lineHeight: 18, marginBottom: 14 },
  stopButton: { minHeight: 50, borderWidth: 1, borderColor: '#b3c0b5', borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  stopButtonText: { color: '#f3f5f1', fontSize: 14, fontWeight: '700' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  muted: { color: '#a8b2aa', fontSize: 13 },
});