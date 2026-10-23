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
type CameraSnapshot = { blob: Blob; url: string };

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
  const snapshotRef = useRef<CameraSnapshot | null>(null);
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [snapshot, setSnapshot] = useState<CameraSnapshot | null>(null);

  useEffect(() => {
    return () => {
      peerRef.current?.close();
      socketRef.current?.close();
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
      if (snapshotRef.current) URL.revokeObjectURL(snapshotRef.current.url);
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
    setVideoPlaying(false);
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
      if (socketRef.current !== socket) return;
      const message = JSON.parse(String(event.data)) as RelayMessage;
      if (['offer', 'answer', 'candidate', 'disconnect', 'closed'].includes(message.type ?? '') && message.requestId !== requestIdRef.current) return;
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
      if (peerRef.current !== peer || requestIdRef.current !== requestId) return;
      const stream = event.streams[0];
      if (stream) {
        setRemoteStream(stream);
        setStatus('Camera track received. Waiting for video playback…');
      }
    };
    peer.onicecandidate = (event) => {
      if (event.candidate && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'candidate', requestId, candidate: event.candidate.toJSON() }));
      }
    };
    peer.onconnectionstatechange = () => {
      if (peerRef.current === peer && requestIdRef.current === requestId && peer.connectionState === 'failed') setStatus('The network could not connect the camera. Check TURN support.');
    };
    try {
      await peer.setRemoteDescription(description);
      if (peerRef.current !== peer || requestIdRef.current !== requestId) return;
      for (const candidate of candidatesRef.current) await peer.addIceCandidate(candidate);
      candidatesRef.current = [];
      const answer = await peer.createAnswer();
      if (peerRef.current !== peer || requestIdRef.current !== requestId) return;
      await peer.setLocalDescription(answer);
      if (peerRef.current !== peer || requestIdRef.current !== requestId) return;
      socket.send(JSON.stringify({ type: 'answer', requestId, description: peer.localDescription }));
    } catch {
      if (peerRef.current === peer && requestIdRef.current === requestId) setStatus('Could not establish the camera connection. Disconnect and try again.');
    }
  }

  function takeSnapshot() {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
      if (snapshotRef.current) URL.revokeObjectURL(snapshotRef.current.url);
      const snapshot = { blob, url: URL.createObjectURL(blob) };
      snapshotRef.current = snapshot;
      setSnapshot(snapshot);
      setStatus('Snapshot saved. It will be deleted in 1 minute.');
      snapshotTimerRef.current = setTimeout(() => {
        if (snapshotRef.current?.url !== snapshot.url) return;
        URL.revokeObjectURL(snapshot.url);
        snapshotRef.current = null;
        snapshotTimerRef.current = null;
        setSnapshot(null);
      }, 60_000);
    }, 'image/png');
  }

  async function copySnapshot() {
    const snapshot = snapshotRef.current;
    if (!snapshot) return;
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Clipboard image support unavailable');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': snapshot.blob })]);
      setStatus('Image copied.');
    } catch {
      setStatus('Could not copy the image in this browser.');
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.cameraPane}>
          <View style={styles.videoFrame}>
            {remoteStream && active
              ? <video ref={videoRef} autoPlay playsInline onPlaying={() => { setVideoPlaying(true); setStatus('Live camera connected.'); }} onWaiting={() => setVideoPlaying(false)} style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#050706' }} />
              : null}
          </View>
          <View style={styles.snapshotActions}>
            <Pressable accessibilityRole="button" disabled={!videoPlaying} style={[styles.snapButton, !videoPlaying && styles.disabled]} onPress={takeSnapshot}>
              <Text style={styles.snapButtonText}>Take snapshot</Text>
            </Pressable>
            {snapshot && (
              <View style={styles.snapshotPreview}>
                <img src={snapshot.url} alt="Camera snapshot" style={{ width: 64, height: 48, objectFit: 'cover' }} />
                <Pressable accessibilityRole="button" style={styles.copyButton} onPress={() => void copySnapshot()}>
                  <Text style={styles.copyButtonText}>Copy image</Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
        <View style={styles.controlsPane}>
          <TextInput
            accessibilityLabel="Phone number"
            value={deviceId}
            onChangeText={setDeviceId}
            keyboardType="number-pad"
            maxLength={8}
            placeholder="Phone number"
            placeholderTextColor="#738078"
            style={styles.input}
          />
          <View style={styles.rememberRow}>
            <Text style={styles.rememberLabel}>Remember number</Text>
            <Switch value={rememberNumber} onValueChange={setRememberNumber} trackColor={{ false: '#59645b', true: '#829d49' }} thumbColor={rememberNumber ? '#c9f36a' : '#d8ded9'} />
          </View>
          <View style={styles.buttonRow}>
            <Pressable accessibilityRole="button" disabled={pending || active} style={[styles.requestButton, (pending || active) && styles.disabled]} onPress={requestCamera}>
              <Text style={styles.requestText}>{pending ? 'Request pending' : active ? 'Connected' : 'Connect'}</Text>
            </Pressable>
            {(pending || active) && <Pressable accessibilityRole="button" style={styles.disconnectButton} onPress={disconnect}><Text style={styles.disconnectText}>Disconnect</Text></Pressable>}
          </View>
          <Text accessibilityRole="status" style={styles.status}>{status}</Text>
          <Text style={styles.videoStatus}>{videoPlaying ? 'Live camera' : active ? 'Waiting for video' : ''}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101714' },
  content: { flexGrow: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 20, padding: 20, width: '100%', maxWidth: 1600, alignSelf: 'center' },
  cameraPane: { flex: 1, minWidth: 300, minHeight: 360, backgroundColor: '#050706', borderRadius: 4, overflow: 'hidden' },
  videoFrame: { flex: 1, minHeight: 360, width: '100%', backgroundColor: '#050706', overflow: 'hidden' },
  snapshotActions: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: '#303b33' },
  snapButton: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 16, backgroundColor: '#c9f36a', borderRadius: 4 },
  snapButtonText: { color: '#182016', fontSize: 13, fontWeight: '800' },
  snapshotPreview: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  copyButton: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 14, borderColor: '#718076', borderWidth: 1, borderRadius: 4 },
  copyButtonText: { color: '#edf1ec', fontSize: 13, fontWeight: '700' },
  controlsPane: { width: 320, minWidth: 280, paddingTop: 4 },
  input: { minHeight: 54, borderWidth: 1, borderColor: '#59645b', borderRadius: 4, color: '#f2f5f0', fontSize: 18, paddingHorizontal: 14 },
  rememberRow: { minHeight: 52, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: '#303b33' },
  rememberLabel: { flex: 1, color: '#c1cbc3', fontSize: 13 },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 18 },
  requestButton: { flex: 1, minHeight: 52, backgroundColor: '#c9f36a', borderRadius: 4, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  disabled: { opacity: 0.55 },
  requestText: { color: '#182016', fontSize: 15, fontWeight: '800' },
  disconnectButton: { minHeight: 56, paddingHorizontal: 20, borderColor: '#718076', borderWidth: 1, justifyContent: 'center', borderRadius: 4 },
  disconnectText: { color: '#edf1ec', fontSize: 13, fontWeight: '700' },
  status: { color: '#a8b2aa', fontSize: 12, lineHeight: 18, marginTop: 14, minHeight: 18 },
  videoStatus: { color: '#a8b2aa', fontSize: 12, lineHeight: 18, marginTop: 10 },
});