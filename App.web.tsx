import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

type RelayMessage = {
  type?: string;
  requestId?: string;
  accepted?: boolean;
  message?: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
};

const SAVED_NUMBER_KEY = 'camera-link-phone-number';
const RELAY_URL = process.env.EXPO_PUBLIC_SIGNALING_URL ??
  (process.env.EXPO_PUBLIC_SIGNALING_HOST
    ? `wss://${process.env.EXPO_PUBLIC_SIGNALING_HOST}`
    : 'ws://localhost:8787');

export default function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const candidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const [deviceId, setDeviceId] = useState(() =>
    typeof localStorage === 'undefined' ? '' : localStorage.getItem(SAVED_NUMBER_KEY) ?? '',
  );
  const [rememberNumber, setRememberNumber] = useState(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(SAVED_NUMBER_KEY) !== null,
  );
  const [status, setStatus] = useState('Enter the phone number to begin.');
  const [pending, setPending] = useState(false);
  const [active, setActive] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      peerRef.current?.close();
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!videoRef.current || !remoteStream) return;
    videoRef.current.srcObject = remoteStream;
    void videoRef.current.play().catch(() => setStatus('Tap the video to start playback.'));
  }, [remoteStream]);

  function disposeCall() {
    peerRef.current?.close();
    peerRef.current = null;
    setRemoteStream(null);
    requestIdRef.current = null;
    candidatesRef.current = [];
    setPending(false);
    setActive(false);
  }

  function disconnect() {
    if (requestIdRef.current) {
      socketRef.current?.send(JSON.stringify({ type: 'disconnect', requestId: requestIdRef.current }));
    }
    disposeCall();
    socketRef.current?.close();
    socketRef.current = null;
    setStatus('Disconnected. Enter a phone number to connect again.');
  }

  function requestCamera() {
    const cleanedId = deviceId.replace(/\D/g, '');
    if (!/^\d{8}$/.test(cleanedId)) {
      setStatus('Enter the 8-digit phone number.');
      return;
    }
    if (rememberNumber) localStorage.setItem(SAVED_NUMBER_KEY, cleanedId);
    else localStorage.removeItem(SAVED_NUMBER_KEY);

    socketRef.current?.close();
    disposeCall();
    requestIdRef.current = null;
    setStatus('Connecting to phone…');
    setPending(true);
    const socket = new WebSocket(RELAY_URL);
    socketRef.current = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'request', deviceId: cleanedId }));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as RelayMessage;
      if (message.requestId) requestIdRef.current = message.requestId;
      if (message.type === 'queued') setStatus('Request sent. Approve it on the phone.');
      if (message.type === 'response') {
        setPending(false);
        if (message.accepted) {
          setActive(true);
          setStatus('Approved. Connecting to the live camera…');
        } else {
          disposeCall();
          setStatus(message.message ?? 'The request was declined.');
          socket.close();
        }
      }
      if (message.type === 'offer' && message.description && message.requestId) {
        void answerOffer(socket, message.requestId, message.description);
      }
      if (message.type === 'candidate' && message.candidate && peerRef.current) {
        if (peerRef.current.remoteDescription) void peerRef.current.addIceCandidate(message.candidate);
        else candidatesRef.current.push(message.candidate);
      }
      if (message.type === 'disconnect' || message.type === 'closed') {
        disposeCall();
        setStatus(message.message ?? 'The phone ended the camera session.');
        socket.close();
      }
      if (message.type === 'error') {
        disposeCall();
        setStatus(message.message ?? 'Could not reach that phone.');
        socket.close();
      }
    };
    socket.onerror = () => {
      disposeCall();
      setStatus('Could not connect to the relay. Check the public relay URL.');
    };
    socket.onclose = () => {
      if (socketRef.current === socket) {
        setPending(false);
        if (requestIdRef.current) disposeCall();
      }
    };
  }

  async function answerOffer(socket: WebSocket, requestId: string, description: RTCSessionDescriptionInit) {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peerRef.current = peer;
    peer.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) {
        setRemoteStream(stream);
        setStatus('Live camera connected.');
      }
    };
    peer.onicecandidate = (event) => {
      if (event.candidate && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'candidate', requestId, candidate: event.candidate.toJSON() }));
      }
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed') setStatus('The network could not connect the camera. Check TURN support.');
    };
    try {
      await peer.setRemoteDescription(description);
      for (const candidate of candidatesRef.current) await peer.addIceCandidate(candidate);
      candidatesRef.current = [];
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.send(JSON.stringify({ type: 'answer', requestId, description: peer.localDescription }));
    } catch {
      setStatus('Could not establish the camera connection. Disconnect and try again.');
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.topline}><Text style={styles.brand}>LANTERN / CAMERA LINK</Text><Text style={styles.webTag}>BROWSER VIEWER</Text></View>
        <Text style={styles.eyebrow}>REMOTE CAMERA</Text>
        <Text style={styles.title}>Ask first.{ '\n' }See live.</Text>
        <Text style={styles.subtitle}>Enter the phone number. The camera appears here only after the person holding it accepts.</Text>
        <View style={styles.panel}>
          <Text style={styles.label}>PHONE NUMBER</Text>
          <TextInput value={deviceId} onChangeText={setDeviceId} keyboardType="number-pad" maxLength={8} placeholder="8-digit number" placeholderTextColor="#738078" style={styles.input} />
          <View style={styles.rememberRow}>
            <Text style={styles.rememberLabel}>Remember this number on this browser</Text>
            <Switch value={rememberNumber} onValueChange={setRememberNumber} trackColor={{ false: '#59645b', true: '#829d49' }} thumbColor={rememberNumber ? '#c9f36a' : '#d8ded9'} />
          </View>
          <View style={styles.buttonRow}>
            <Pressable accessibilityRole="button" disabled={pending || active} style={[styles.requestButton, (pending || active) && styles.disabled]} onPress={requestCamera}>
              <Text style={styles.requestText}>{pending ? 'Request pending' : active ? 'Camera connected' : 'Request camera access'}</Text>
              <Text style={styles.requestArrow}>&gt;</Text>
            </Pressable>
            {(pending || active) && <Pressable accessibilityRole="button" style={styles.disconnectButton} onPress={disconnect}><Text style={styles.disconnectText}>Disconnect</Text></Pressable>}
          </View>
          <Text accessibilityRole="status" style={styles.status}>{status}</Text>
        </View>
        {active && (
          <View style={styles.videoPanel}>
            <View style={styles.videoTopline}><View style={styles.liveIndicator} /><Text style={styles.videoLabel}>{remoteStream ? 'LIVE CAMERA' : 'WAITING FOR VIDEO'}</Text></View>
            <View style={styles.videoFrame}>
              {remoteStream
                ? <video ref={videoRef} autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#050706' }} />
                : <Text style={styles.waitText}>Waiting for the phone to start sharing…</Text>}
            </View>
          </View>
        )}
        <View style={styles.infoLine}><Text style={styles.infoIndex}>01</Text><Text style={styles.infoText}>The phone must approve each request before its camera is shared.</Text></View>
        <View style={styles.infoLine}><Text style={styles.infoIndex}>02</Text><Text style={styles.infoText}>Either person can end the session with Disconnect or Stop sharing.</Text></View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101714' },
  content: { flexGrow: 1, paddingHorizontal: 28, paddingTop: 34, paddingBottom: 50, maxWidth: 900, width: '100%', alignSelf: 'center' },
  topline: { minHeight: 34, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 58 },
  brand: { color: '#c9f36a', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  webTag: { color: '#a4afa7', fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  eyebrow: { color: '#c9f36a', fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginBottom: 12 },
  title: { color: '#f1f4ef', fontSize: 48, lineHeight: 51, fontWeight: '700', marginBottom: 16 },
  subtitle: { color: '#a8b2aa', fontSize: 16, lineHeight: 24, maxWidth: 600, marginBottom: 32 },
  panel: { borderWidth: 1, borderColor: '#3b463e', backgroundColor: '#171f1a', padding: 22, borderRadius: 6, marginBottom: 28 },
  label: { color: '#91a095', fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  input: { minHeight: 52, borderBottomWidth: 1, borderBottomColor: '#59645b', color: '#f2f5f0', fontSize: 18, paddingHorizontal: 2 },
  rememberRow: { minHeight: 54, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: '#303b33' },
  rememberLabel: { flex: 1, color: '#c1cbc3', fontSize: 13 },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 22 },
  requestButton: { flex: 1, minHeight: 56, backgroundColor: '#c9f36a', borderRadius: 4, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  disabled: { opacity: 0.55 },
  requestText: { color: '#182016', fontSize: 15, fontWeight: '800' },
  requestArrow: { color: '#182016', fontSize: 20, fontWeight: '700' },
  disconnectButton: { minHeight: 56, paddingHorizontal: 20, borderColor: '#718076', borderWidth: 1, justifyContent: 'center', borderRadius: 4 },
  disconnectText: { color: '#edf1ec', fontSize: 13, fontWeight: '700' },
  status: { color: '#a8b2aa', fontSize: 12, lineHeight: 18, marginTop: 16, minHeight: 18 },
  videoPanel: { backgroundColor: '#171f1a', borderWidth: 1, borderColor: '#39443c', padding: 12, borderRadius: 6, marginBottom: 24 },
  videoTopline: { height: 30, flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveIndicator: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#c9f36a' },
  videoLabel: { color: '#c1cbc3', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  videoFrame: { width: '100%', aspectRatio: 16 / 9, maxHeight: 580, backgroundColor: '#050706', justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  waitText: { color: '#a8b2aa', fontSize: 13 },
  infoLine: { flexDirection: 'row', gap: 16, paddingVertical: 15, borderTopWidth: 1, borderTopColor: '#303b33' },
  infoIndex: { color: '#c9f36a', fontSize: 11, fontWeight: '800', paddingTop: 2 },
  infoText: { color: '#c1cbc3', fontSize: 13, lineHeight: 19, flex: 1 },
});