import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SERVER = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
const WIDTH = 1000;
const HEIGHT = 600;
const EARSHOT = 100;
const STEP = 8;
const MIN_X = 18;
const MAX_X = WIDTH - 18;
const MIN_Y = 18;
const MAX_Y = HEIGHT - 18;
const initialRooms = [
  { x: 40, y: 40, w: 230, h: 150, label: 'FOCUS ROOM' },
  { x: 355, y: 45, w: 285, h: 135, label: 'TEAM NORTH' },
  { x: 725, y: 40, w: 230, h: 190, label: 'MEETING ROOM' },
  { x: 55, y: 375, w: 275, h: 170, label: 'DESIGN STUDIO' },
  { x: 390, y: 400, w: 220, h: 140, label: 'LOUNGE' },
  { x: 690, y: 360, w: 265, h: 185, label: 'TEAM SOUTH' }
];

export default function App() {
  const canvasRef = useRef(null);
  const socketRef = useRef(null);
  const usersRef = useRef(new Map());
  const pcsRef = useRef(new Map());
  const peerStatesRef = useRef(new Map());
  const audioCtxRef = useRef(null);
  const gainsRef = useRef(new Map());
  const selfIdRef = useRef(null);
  const positionRef = useRef({ x: 310, y: 285 });
  const keysRef = useRef(new Set());
  const localStreamRef = useRef(null);

  const [name, setName] = useState(() => `Guest${Math.floor(100 + Math.random() * 900)}`);
  const [joined, setJoined] = useState(false);
  const [connected, setConnected] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [status, setStatus] = useState('Not connected');
  const [nearby, setNearby] = useState([]);
  const [debug, setDebug] = useState({ count: 0, elapsedMs: '—' });
  const [muted, setMuted] = useState(false);
  const [hint, setHint] = useState('Join the office from another browser tab to test proximity audio.');

  const ensureAudioContext = useCallback(async () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtxRef.current.state === 'suspended') await audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  const disconnectPeerAudio = useCallback(peerId => {
    const audio = gainsRef.current.get(peerId);
    if (!audio) return;
    for (const node of Object.values(audio)) {
      try {
        node.disconnect();
      } catch {
        // The node may already be disconnected during a peer teardown.
      }
    }
    gainsRef.current.delete(peerId);
  }, []);

  const closePeer = useCallback(peerId => {
    const pc = pcsRef.current.get(peerId);
    pcsRef.current.delete(peerId);
    peerStatesRef.current.delete(peerId);
    disconnectPeerAudio(peerId);
    if (pc) {
      pc.onicecandidate = null;
      pc.onnegotiationneeded = null;
      pc.ontrack = null;
      pc.close();
    }
  }, [disconnectPeerAudio]);

  const addLocalTracks = useCallback(pc => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const existingTracks = new Set(pc.getSenders().map(sender => sender.track).filter(Boolean));
    for (const track of stream.getTracks()) {
      if (!existingTracks.has(track)) pc.addTrack(track, stream);
    }
  }, []);

  const createPeer = useCallback((peerId, shouldAddLocalTracks = true) => {
    const existing = pcsRef.current.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const peerState = { makingOffer: false, ignoreOffer: false, pendingCandidates: [] };
    pcsRef.current.set(peerId, pc);
    peerStatesRef.current.set(peerId, peerState);

    pc.onicecandidate = event => {
      if (event.candidate) socketRef.current?.emit('rtc:ice', { targetId: peerId, candidate: event.candidate });
    };
    pc.onnegotiationneeded = async () => {
      if (pc.signalingState !== 'stable') return;
      try {
        peerState.makingOffer = true;
        const offer = await pc.createOffer();
        if (pc.signalingState !== 'stable') return;
        await pc.setLocalDescription(offer);
        socketRef.current?.emit('rtc:offer', { targetId: peerId, offer: pc.localDescription });
      } catch (error) {
        console.error('Could not create WebRTC offer', error);
      } finally {
        peerState.makingOffer = false;
      }
    };
    pc.ontrack = async event => {
      const stream = event.streams[0];
      if (!stream) return;

      try {
        disconnectPeerAudio(peerId);
        const context = await ensureAudioContext();
        const source = context.createMediaStreamSource(stream);
        const gain = context.createGain();
        const panner = context.createStereoPanner();
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(panner);
        panner.connect(context.destination);
        gainsRef.current.set(peerId, { source, gain, panner });
      } catch (error) {
        console.warn('Audio setup failed', error);
      }
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) closePeer(peerId);
    };

    if (shouldAddLocalTracks) addLocalTracks(pc);
    return pc;
  }, [addLocalTracks, closePeer, disconnectPeerAudio, ensureAudioContext]);

  useEffect(() => {
    const socket = io(SERVER, { autoConnect: false });
    socketRef.current = socket;

    const flushPendingCandidates = async (peerId, pc) => {
      const peerState = peerStatesRef.current.get(peerId);
      if (!peerState || !pc.remoteDescription) return;

      const candidates = peerState.pendingCandidates.splice(0);
      for (const candidate of candidates) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    };

    socket.on('connect', () => setStatus('Connected to signaling server'));
    socket.on('disconnect', () => {
      setConnected(false);
      setJoined(false);
      setNearby([]);
      setStatus('Disconnected from server');
      for (const peerId of [...pcsRef.current.keys()]) closePeer(peerId);
    });
    socket.on('world:init', ({ selfId, users, earshot }) => {
      selfIdRef.current = selfId;
      usersRef.current.clear();
      users.forEach(user => usersRef.current.set(user.id, { ...user, self: user.id === selfId }));
      setConnected(true);
      setJoined(true);
      setStatus(`Online · ${users.length} in office`);
      setHint(`Earshot radius: ${earshot}px. Move near another avatar to connect audio.`);
    });
    socket.on('user:joined', user => {
      usersRef.current.set(user.id, user);
      setStatus('A colleague joined the office');
    });
    socket.on('user:moved', ({ id, x, y }) => {
      const user = usersRef.current.get(id);
      if (user) usersRef.current.set(id, { ...user, x, y });
    });
    socket.on('user:left', ({ id }) => {
      usersRef.current.delete(id);
      closePeer(id);
      setNearby(previous => previous.filter(user => user.id !== id));
    });
    socket.on('proximity:update', ({ nearby: list }) => {
      const peers = Array.isArray(list) ? list : [];
      setNearby(peers);
      const eligible = new Set(peers.map(peer => peer.id));
      if (localStreamRef.current) {
        for (const peer of peers) {
          if (!pcsRef.current.has(peer.id)) createPeer(peer.id);
        }
      }
      for (const peerId of [...pcsRef.current.keys()]) {
        if (!eligible.has(peerId)) closePeer(peerId);
      }
    });
    socket.on('proximity:debug', data => {
      setDebug({ count: data.count, elapsedMs: data.elapsedMs ?? '—' });
    });
    socket.on('rtc:offer', async ({ fromId, offer }) => {
      try {
        const pc = createPeer(fromId, false);
        const peerState = peerStatesRef.current.get(fromId);
        if (!peerState) return;

        const polite = (selfIdRef.current?.localeCompare(fromId) ?? -1) > 0;
        const offerCollision = peerState.makingOffer || pc.signalingState !== 'stable';
        peerState.ignoreOffer = !polite && offerCollision;
        if (peerState.ignoreOffer) return;

        if (offerCollision && pc.signalingState !== 'stable') {
          await pc.setLocalDescription({ type: 'rollback' });
        }
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        addLocalTracks(pc);
        await flushPendingCandidates(fromId, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('rtc:answer', { targetId: fromId, answer: pc.localDescription });
      } catch (error) {
        console.error('Could not accept WebRTC offer', error);
      }
    });
    socket.on('rtc:answer', async ({ fromId, answer }) => {
      const pc = pcsRef.current.get(fromId);
      const peerState = peerStatesRef.current.get(fromId);
      if (!pc || !peerState || pc.signalingState !== 'have-local-offer') return;

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        peerState.ignoreOffer = false;
        await flushPendingCandidates(fromId, pc);
      } catch (error) {
        console.error('Could not accept WebRTC answer', error);
      }
    });
    socket.on('rtc:ice', async ({ fromId, candidate }) => {
      const pc = pcsRef.current.get(fromId);
      const peerState = peerStatesRef.current.get(fromId);
      if (!pc || !peerState || !candidate || peerState.ignoreOffer) return;

      try {
        if (!pc.remoteDescription) {
          peerState.pendingCandidates.push(candidate);
          return;
        }
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.warn('Could not add ICE candidate', error);
      }
    });
    socket.on('server:error', ({ message }) => setHint(message));

    return () => {
      socket.disconnect();
      for (const peerId of [...pcsRef.current.keys()]) closePeer(peerId);
      localStreamRef.current?.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
      const context = audioCtxRef.current;
      audioCtxRef.current = null;
      if (context && context.state !== 'closed') context.close().catch(() => {});
    };
  }, [addLocalTracks, closePeer, createPeer]);

  const join = () => {
    if (!name.trim()) {
      setHint('Please enter a display name.');
      return;
    }

    const socket = socketRef.current;
    if (!socket) {
      setHint('The signaling client is still starting. Please try again.');
      return;
    }

    const sendJoin = () => socket.emit('user:join', { name: name.trim(), ...positionRef.current });
    if (socket.connected) sendJoin();
    else {
      socket.once('connect', sendJoin);
      socket.connect();
    }
    setStatus('Connecting…');
  };

  const toggleMic = async () => {
    try {
      if (!localStreamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false
        });
        localStreamRef.current = stream;
        await ensureAudioContext();

        for (const pc of pcsRef.current.values()) addLocalTracks(pc);
        for (const peer of nearby) {
          if (!pcsRef.current.has(peer.id)) createPeer(peer.id);
        }
        setMicOn(true);
        setHint('Microphone enabled. Browser permission is required for live audio.');
        return;
      }

      const track = localStreamRef.current.getAudioTracks()[0];
      if (!track) throw new Error('No audio track is available');
      track.enabled = !track.enabled;
      setMicOn(track.enabled);
    } catch (error) {
      setHint(`Microphone unavailable: ${error.message}. Allow microphone access and use localhost/HTTPS.`);
    }
  };

  useEffect(() => {
    let animationFrame;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');

    const draw = () => {
      const keys = keysRef.current;
      let { x, y } = positionRef.current;
      let moved = false;
      if (joined) {
        if (keys.has('ArrowLeft') || keys.has('a')) { x -= STEP; moved = true; }
        if (keys.has('ArrowRight') || keys.has('d')) { x += STEP; moved = true; }
        if (keys.has('ArrowUp') || keys.has('w')) { y -= STEP; moved = true; }
        if (keys.has('ArrowDown') || keys.has('s')) { y += STEP; moved = true; }
        x = Math.max(MIN_X, Math.min(MAX_X, x));
        y = Math.max(MIN_Y, Math.min(MAX_Y, y));
        if (moved) {
          positionRef.current = { x, y };
          const self = usersRef.current.get(selfIdRef.current);
          if (self) usersRef.current.set(selfIdRef.current, { ...self, x, y });
          socketRef.current?.emit('user:move', { x, y });
        }
      }

      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.fillStyle = '#111b2b';
      context.fillRect(0, 0, WIDTH, HEIGHT);
      context.strokeStyle = 'rgba(145,170,205,.08)';
      context.lineWidth = 1;
      for (let gridX = 0; gridX <= WIDTH; gridX += 25) {
        context.beginPath();
        context.moveTo(gridX, 0);
        context.lineTo(gridX, HEIGHT);
        context.stroke();
      }
      for (let gridY = 0; gridY <= HEIGHT; gridY += 25) {
        context.beginPath();
        context.moveTo(0, gridY);
        context.lineTo(WIDTH, gridY);
        context.stroke();
      }
      initialRooms.forEach((room, index) => {
        context.fillStyle = index % 2 ? 'rgba(47,75,104,.35)' : 'rgba(43,67,94,.35)';
        context.strokeStyle = 'rgba(127,164,201,.48)';
        context.lineWidth = 2;
        context.beginPath();
        context.roundRect(room.x, room.y, room.w, room.h, 10);
        context.fill();
        context.stroke();
        context.fillStyle = '#8da8c5';
        context.font = '600 11px Inter, sans-serif';
        context.fillText(room.label, room.x + 14, room.y + 22);
        context.fillStyle = 'rgba(119,148,179,.22)';
        context.fillRect(room.x + 18, room.y + 42, Math.min(68, room.w - 35), 28);
        context.fillRect(room.x + 95, room.y + 42, Math.min(60, room.w - 110), 28);
      });

      const self = positionRef.current;
      context.beginPath();
      context.arc(self.x, self.y, EARSHOT, 0, Math.PI * 2);
      context.fillStyle = 'rgba(54,211,153,.07)';
      context.fill();
      context.strokeStyle = 'rgba(54,211,153,.45)';
      context.setLineDash([5, 6]);
      context.lineWidth = 1.5;
      context.stroke();
      context.setLineDash([]);

      for (const user of usersRef.current.values()) {
        const isSelf = user.id === selfIdRef.current;
        const userDistance = Math.hypot(self.x - user.x, self.y - user.y);
        const isNear = !isSelf && userDistance <= EARSHOT;
        context.beginPath();
        context.arc(user.x, user.y, isSelf ? 13 : 11, 0, Math.PI * 2);
        context.fillStyle = isSelf ? '#35d6a0' : isNear ? '#67b8ff' : '#7d8ba1';
        context.fill();
        context.strokeStyle = '#e8f4ff';
        context.lineWidth = 2;
        context.stroke();
        context.fillStyle = '#eef5ff';
        context.font = '600 12px Inter, sans-serif';
        context.textAlign = 'center';
        context.fillText(isSelf ? `${user.name} (you)` : user.name, user.x, user.y - 20);
        context.textAlign = 'left';
      }

      const currentUser = usersRef.current.get(selfIdRef.current);
      if (currentUser) {
        for (const [peerId, audio] of gainsRef.current) {
          const peer = usersRef.current.get(peerId);
          if (!peer) continue;
          const userDistance = Math.hypot(currentUser.x - peer.x, currentUser.y - peer.y);
          const volume = userDistance >= EARSHOT || muted ? 0 : Math.pow(1 - userDistance / EARSHOT, 1.5);
          const now = audioCtxRef.current?.currentTime || 0;
          audio.gain.gain.setTargetAtTime(volume, now, 0.08);
          audio.panner.pan.setTargetAtTime(
            Math.max(-1, Math.min(1, (peer.x - currentUser.x) / EARSHOT)),
            now,
            0.08
          );
        }
      }

      animationFrame = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animationFrame);
  }, [joined, muted]);

  useEffect(() => {
    const down = event => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) event.preventDefault();
      keysRef.current.add(event.key.toLowerCase());
    };
    const up = event => keysRef.current.delete(event.key.toLowerCase());
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const leave = () => {
    socketRef.current?.disconnect();
    for (const peerId of [...pcsRef.current.keys()]) closePeer(peerId);
    localStreamRef.current?.getTracks().forEach(track => track.stop());
    localStreamRef.current = null;
    usersRef.current.clear();
    selfIdRef.current = null;
    setJoined(false);
    setConnected(false);
    setNearby([]);
    setMicOn(false);
    setStatus('Left office');
  };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark">◉</div>
      <div><div className="brand">ProxiSpeak</div><div className="tagline">SPATIAL AUDIO · VIRTUAL OFFICE</div></div>
      <div className={`connection-pill ${connected ? 'online' : ''}`}><span className="status-dot" />{connected ? 'LIVE' : 'OFFLINE'}</div>
    </header>
    <main className="layout">
      <section className="world-panel">
        <div className="panel-heading"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>Office floor plan</h1></div><div className="legend"><span><i className="legend-self" />You</span><span><i className="legend-near" />In earshot</span><span><i className="legend-far" />Nearby users</span></div></div>
        <div className="canvas-wrap"><canvas ref={canvasRef} width={WIDTH} height={HEIGHT} aria-label="Virtual office map" /><div className="map-badge"><span className="pulse" /> LIVE MAP</div></div>
        <div className="movement-tip"><span className="keycap">W</span><span className="keycap">A</span><span className="keycap">S</span><span className="keycap">D</span><span className="tip-text">Move around · Arrow keys also work</span><span className="radius-label">◌ 100px earshot</span></div>
      </section>
      <aside className="sidebar">
        <section className="card join-card">
          <div className="card-title-row"><h2>Join the office</h2><span className="step-tag">STEP 01</span></div>
          <label htmlFor="displayName">Display name</label>
          <input id="displayName" value={name} onChange={event => setName(event.target.value)} maxLength={24} disabled={joined} placeholder="Enter your name" onKeyDown={event => event.key === 'Enter' && !joined && join()} />
          {!joined ? <button className="primary-btn" onClick={join}>Enter workspace <span>↗</span></button> : <button className="secondary-btn" onClick={leave}>Leave workspace</button>}
          <div className="status-line"><span className={`status-dot ${connected ? 'green' : ''}`} />{status}</div>
        </section>
        <section className="card audio-card">
          <div className="card-title-row"><h2>Audio controls</h2><span className="step-tag">STEP 02</span></div>
          <p className="muted-copy">Enable your mic, then move close to a teammate to talk naturally.</p>
          <button className={`control-btn ${micOn ? 'active' : ''}`} onClick={toggleMic} disabled={!joined}><span className="control-icon">{micOn ? '🎙' : '♩'}</span><span><strong>{micOn ? 'Microphone on' : 'Enable microphone'}</strong><small>{micOn ? 'Your voice can be shared' : 'Browser permission required'}</small></span><span className="toggle"><i /></span></button>
          <button className={`control-btn ${muted ? 'active' : ''}`} onClick={() => setMuted(value => !value)}><span className="control-icon">{muted ? '◌' : '♫'}</span><span><strong>{muted ? 'Spatial audio muted' : 'Spatial audio on'}</strong><small>{muted ? 'All incoming audio is silent' : 'Volume adapts to distance'}</small></span><span className="toggle"><i /></span></button>
        </section>
        <section className="card proximity-card">
          <div className="card-title-row"><h2>In your earshot</h2><span className="count-badge">{nearby.length}</span></div>
          <p className="muted-copy">People within 100 pixels of your avatar.</p>
          {nearby.length ? <div className="people-list">{nearby.map(person => <div className="person-row" key={person.id}><div className="avatar">{person.name.slice(0, 1).toUpperCase()}</div><div className="person-info"><strong>{person.name}</strong><small>{Math.round(Math.hypot((usersRef.current.get(selfIdRef.current)?.x || 0) - person.x, (usersRef.current.get(selfIdRef.current)?.y || 0) - person.y))} px away</small></div><span className="audio-wave">)))</span></div>)}</div> : <div className="empty-state"><div className="empty-icon">⌁</div><strong>No one nearby yet</strong><span>Move toward a teammate to connect.</span></div>}
        </section>
        <section className="metrics-row"><div className="metric-card"><span>IN EARSHOT</span><strong>{debug.count}</strong><small>users detected</small></div><div className="metric-card"><span>RANGE</span><strong>100<span className="metric-unit">px</span></strong><small>proximity radius</small></div></section>
      </aside>
    </main>
    <footer><span>PROXISPEAK <b>·</b> WEEK 2 PROTOTYPE</span><span>{hint}</span><span>REACT CANVAS + SOCKET.IO + WEBRTC</span></footer>
  </div>;
}
