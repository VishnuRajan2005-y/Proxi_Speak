import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SERVER = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
const WIDTH = 1000, HEIGHT = 600, EARSHOT = 100, STEP = 8;
const initialRooms = [
  { x: 40, y: 40, w: 230, h: 150, label: 'FOCUS ROOM' },
  { x: 355, y: 45, w: 285, h: 135, label: 'TEAM NORTH' },
  { x: 725, y: 40, w: 230, h: 190, label: 'MEETING ROOM' },
  { x: 55, y: 375, w: 275, h: 170, label: 'DESIGN STUDIO' },
  { x: 390, y: 400, w: 220, h: 140, label: 'LOUNGE' },
  { x: 690, y: 360, w: 265, h: 185, label: 'TEAM SOUTH' }
];

export default function App() {
  const canvasRef = useRef(null), socketRef = useRef(null), usersRef = useRef(new Map());
  const pcsRef = useRef(new Map()), audioElsRef = useRef(new Map()), audioCtxRef = useRef(null), gainsRef = useRef(new Map());
  const selfIdRef = useRef(null), positionRef = useRef({ x: 310, y: 285 }), keysRef = useRef(new Set());
  const [name, setName] = useState(() => `Guest${Math.floor(100 + Math.random() * 900)}`);
  const [joined, setJoined] = useState(false), [connected, setConnected] = useState(false), [micOn, setMicOn] = useState(false);
  const [status, setStatus] = useState('Not connected'), [nearby, setNearby] = useState([]), [debug, setDebug] = useState({ count: 0, elapsedMs: '—' });
  const [muted, setMuted] = useState(false), [hint, setHint] = useState('Join the office from another browser tab to test proximity audio.');
  const localStreamRef = useRef(null);

  const ensureAudioContext = useCallback(async () => {
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtxRef.current.state === 'suspended') await audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  const closePeer = useCallback(id => {
    const pc = pcsRef.current.get(id); if (pc) pc.close();
    pcsRef.current.delete(id);
    const el = audioElsRef.current.get(id); if (el) { el.srcObject = null; el.remove(); }
    audioElsRef.current.delete(id);
    const gain = gainsRef.current.get(id); if (gain) { try { gain.disconnect(); } catch {} }
    gainsRef.current.delete(id);
  }, []);

  const createPeer = useCallback((peerId, initiator) => {
    if (pcsRef.current.has(peerId)) return pcsRef.current.get(peerId);
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pcsRef.current.set(peerId, pc);
    if (localStreamRef.current) localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current));
    pc.onicecandidate = e => { if (e.candidate) socketRef.current?.emit('rtc:ice', { targetId: peerId, candidate: e.candidate }); };
    pc.ontrack = async e => {
      try {
        const ctx = await ensureAudioContext();
        const source = ctx.createMediaStreamSource(e.streams[0]);
        const gain = ctx.createGain(); gain.gain.value = 0;
        const panner = ctx.createStereoPanner();
        source.connect(gain); gain.connect(panner); panner.connect(ctx.destination);
        gainsRef.current.set(peerId, { gain, panner, source });
      } catch (err) { console.warn('Audio setup failed', err); }
    };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) closePeer(peerId); };
    if (initiator) pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => socketRef.current?.emit('rtc:offer', { targetId: peerId, offer: pc.localDescription })).catch(console.error);
    return pc;
  }, [closePeer, ensureAudioContext]);

  useEffect(() => {
    const socket = io(SERVER, { autoConnect: false }); socketRef.current = socket;
    socket.on('connect', () => setStatus('Connected to signaling server'));
    socket.on('disconnect', () => { setConnected(false); setStatus('Disconnected from server'); });
    socket.on('world:init', ({ selfId, users, earshot }) => {
      selfIdRef.current = selfId; usersRef.current.clear();
      users.forEach(u => usersRef.current.set(u.id, { ...u, self: u.id === selfId }));
      setConnected(true); setJoined(true); setStatus(`Online · ${users.length} in office`); setHint(`Earshot radius: ${earshot}px. Move near another avatar to connect audio.`);
    });
    socket.on('user:joined', u => { usersRef.current.set(u.id, u); setStatus('A colleague joined the office'); });
    socket.on('user:moved', ({ id, x, y }) => { const u = usersRef.current.get(id); if (u) usersRef.current.set(id, { ...u, x, y }); });
    socket.on('user:left', ({ id }) => { usersRef.current.delete(id); closePeer(id); setNearby(prev => prev.filter(u => u.id !== id)); });
    socket.on('proximity:update', ({ nearby: list }) => {
      setNearby(list);
      const eligible = new Set(list.map(u => u.id));
      // Initiate a connection once per pair. Socket IDs provide a deterministic initiator to avoid glare.
      for (const peer of list) if (selfIdRef.current && selfIdRef.current.localeCompare(peer.id) < 0 && !pcsRef.current.has(peer.id)) createPeer(peer.id, true);
      for (const id of [...pcsRef.current.keys()]) if (!eligible.has(id)) closePeer(id);
    });
    socket.on('proximity:debug', data => setDebug({ count: data.count, elapsedMs: data.elapsedMs ?? '—' }));
    socket.on('rtc:offer', async ({ fromId, offer }) => {
      try { const pc = createPeer(fromId, false); await pc.setRemoteDescription(new RTCSessionDescription(offer)); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); socket.emit('rtc:answer', { targetId: fromId, answer: pc.localDescription }); } catch (e) { console.error(e); }
    });
    socket.on('rtc:answer', async ({ fromId, answer }) => { const pc = pcsRef.current.get(fromId); if (pc && pc.signalingState !== 'stable') await pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(console.error); });
    socket.on('rtc:ice', async ({ fromId, candidate }) => { const pc = pcsRef.current.get(fromId); if (pc && candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {}); });
    socket.on('server:error', ({ message }) => setHint(message));
    return () => { socket.disconnect(); for (const id of [...pcsRef.current.keys()]) closePeer(id); localStreamRef.current?.getTracks().forEach(t => t.stop()); audioCtxRef.current?.close(); };
  }, [closePeer, createPeer]);

  const join = async () => {
    if (!name.trim()) { setHint('Please enter a display name.'); return; }
    socketRef.current.connect();
    socketRef.current.once('connect', () => socketRef.current.emit('user:join', { name: name.trim(), ...positionRef.current }));
    setStatus('Connecting…');
  };
  const toggleMic = async () => {
    try {
      if (!localStreamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        localStreamRef.current = stream; await ensureAudioContext();
        for (const [id, pc] of pcsRef.current) stream.getTracks().forEach(track => pc.addTrack(track, stream));
      } else {
        const track = localStreamRef.current.getAudioTracks()[0]; track.enabled = !track.enabled; setMicOn(track.enabled); return;
      }
      setMicOn(true); setHint('Microphone enabled. Browser permission is required for live audio.');
    } catch (e) { setHint(`Microphone unavailable: ${e.message}. Allow microphone access and use localhost/HTTPS.`); }
  };

  useEffect(() => {
    let raf;
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      const keys = keysRef.current; let { x, y } = positionRef.current; let moved = false;
      if (joined) {
        if (keys.has('ArrowLeft') || keys.has('a')) { x -= STEP; moved = true; }
        if (keys.has('ArrowRight') || keys.has('d')) { x += STEP; moved = true; }
        if (keys.has('ArrowUp') || keys.has('w')) { y -= STEP; moved = true; }
        if (keys.has('ArrowDown') || keys.has('s')) { y += STEP; moved = true; }
        x = Math.max(18, Math.min(WIDTH - 18, x)); y = Math.max(18, Math.min(HEIGHT - 18, y));
        if (moved) { positionRef.current = { x, y }; const me = usersRef.current.get(selfIdRef.current); if (me) usersRef.current.set(selfIdRef.current, { ...me, x, y }); socketRef.current?.emit('user:move', { x, y }); }
      }
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = '#111b2b'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.strokeStyle = 'rgba(145,170,205,.08)'; ctx.lineWidth = 1;
      for (let gx = 0; gx <= WIDTH; gx += 25) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, HEIGHT); ctx.stroke(); }
      for (let gy = 0; gy <= HEIGHT; gy += 25) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(WIDTH, gy); ctx.stroke(); }
      initialRooms.forEach((r, i) => {
        ctx.fillStyle = i % 2 ? 'rgba(47,75,104,.35)' : 'rgba(43,67,94,.35)'; ctx.strokeStyle = 'rgba(127,164,201,.48)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, 10); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#8da8c5'; ctx.font = '600 11px Inter, sans-serif'; ctx.fillText(r.label, r.x + 14, r.y + 22);
        // Simple furniture blocks
        ctx.fillStyle = 'rgba(119,148,179,.22)';
        ctx.fillRect(r.x + 18, r.y + 42, Math.min(68, r.w - 35), 28); ctx.fillRect(r.x + 95, r.y + 42, Math.min(60, r.w - 110), 28);
      });
      const me = positionRef.current;
      ctx.beginPath(); ctx.arc(me.x, me.y, EARSHOT, 0, Math.PI * 2); ctx.fillStyle = 'rgba(54,211,153,.07)'; ctx.fill(); ctx.strokeStyle = 'rgba(54,211,153,.45)'; ctx.setLineDash([5, 6]); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
      for (const u of usersRef.current.values()) {
        const isMe = u.id === selfIdRef.current; const dist = Math.hypot(me.x - u.x, me.y - u.y); const isNear = !isMe && dist <= EARSHOT;
        ctx.beginPath(); ctx.arc(u.x, u.y, isMe ? 13 : 11, 0, Math.PI * 2); ctx.fillStyle = isMe ? '#35d6a0' : isNear ? '#67b8ff' : '#7d8ba1'; ctx.fill();
        ctx.strokeStyle = '#e8f4ff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#eef5ff'; ctx.font = '600 12px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(isMe ? `${u.name} (you)` : u.name, u.x, u.y - 20); ctx.textAlign = 'left';
      }
      // update volume and stereo panning according to relative position
      const current = usersRef.current.get(selfIdRef.current);
      if (current) for (const [id, audio] of gainsRef.current) {
        const peer = usersRef.current.get(id); if (!peer) continue;
        const distance = Math.hypot(current.x - peer.x, current.y - peer.y);
        const volume = distance >= EARSHOT || muted ? 0 : Math.pow(1 - distance / EARSHOT, 1.5);
        audio.gain.gain.setTargetAtTime(volume, audioCtxRef.current?.currentTime || 0, 0.08);
        audio.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, (peer.x - current.x) / EARSHOT)), audioCtxRef.current?.currentTime || 0, 0.08);
      }
      raf = requestAnimationFrame(draw);
    };
    draw(); return () => cancelAnimationFrame(raf);
  }, [joined, muted]);

  useEffect(() => {
    const down = e => { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' '].includes(e.key)) e.preventDefault(); keysRef.current.add(e.key.toLowerCase()); };
    const up = e => keysRef.current.delete(e.key.toLowerCase());
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  const leave = () => { socketRef.current?.disconnect(); setJoined(false); setConnected(false); setNearby([]); setMicOn(false); for (const id of [...pcsRef.current.keys()]) closePeer(id); localStreamRef.current?.getTracks().forEach(t => t.stop()); localStreamRef.current = null; usersRef.current.clear(); setStatus('Left office'); };

  return <div className="app-shell">
    <header className="topbar"><div className="brand-mark">◉</div><div><div className="brand">ProxiSpeak</div><div className="tagline">SPATIAL AUDIO · VIRTUAL OFFICE</div></div><div className={`connection-pill ${connected ? 'online' : ''}`}><span className="status-dot" />{connected ? 'LIVE' : 'OFFLINE'}</div></header>
    <main className="layout">
      <section className="world-panel"><div className="panel-heading"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>Office floor plan</h1></div><div className="legend"><span><i className="legend-self" />You</span><span><i className="legend-near" />In earshot</span><span><i className="legend-far" />Nearby users</span></div></div>
        <div className="canvas-wrap"><canvas ref={canvasRef} width={WIDTH} height={HEIGHT} aria-label="Virtual office map" /><div className="map-badge"><span className="pulse" /> LIVE MAP</div></div>
        <div className="movement-tip"><span className="keycap">W</span><span className="keycap">A</span><span className="keycap">S</span><span className="keycap">D</span><span className="tip-text">Move around · Arrow keys also work</span><span className="radius-label">◌ 100px earshot</span></div>
      </section>
      <aside className="sidebar">
        <section className="card join-card"><div className="card-title-row"><h2>Join the office</h2><span className="step-tag">STEP 01</span></div><label htmlFor="displayName">Display name</label><input id="displayName" value={name} onChange={e => setName(e.target.value)} maxLength={24} disabled={joined} placeholder="Enter your name" onKeyDown={e => e.key === 'Enter' && !joined && join()} />
          {!joined ? <button className="primary-btn" onClick={join}>Enter workspace <span>↗</span></button> : <button className="secondary-btn" onClick={leave}>Leave workspace</button>}
          <div className="status-line"><span className={`status-dot ${connected ? 'green' : ''}`} />{status}</div>
        </section>
        <section className="card audio-card"><div className="card-title-row"><h2>Audio controls</h2><span className="step-tag">STEP 02</span></div><p className="muted-copy">Enable your mic, then move close to a teammate to talk naturally.</p><button className={`control-btn ${micOn ? 'active' : ''}`} onClick={toggleMic} disabled={!joined}><span className="control-icon">{micOn ? '🎙' : '♩'}</span><span><strong>{micOn ? 'Microphone on' : 'Enable microphone'}</strong><small>{micOn ? 'Your voice can be shared' : 'Browser permission required'}</small></span><span className="toggle"><i /></span></button><button className={`control-btn ${muted ? 'active' : ''}`} onClick={() => setMuted(v => !v)}><span className="control-icon">{muted ? '◌' : '♫'}</span><span><strong>{muted ? 'Spatial audio muted' : 'Spatial audio on'}</strong><small>{muted ? 'All incoming audio is silent' : 'Volume adapts to distance'}</small></span><span className="toggle"><i /></span></button></section>
        <section className="card proximity-card"><div className="card-title-row"><h2>In your earshot</h2><span className="count-badge">{nearby.length}</span></div><p className="muted-copy">People within 100 pixels of your avatar.</p>{nearby.length ? <div className="people-list">{nearby.map(p => <div className="person-row" key={p.id}><div className="avatar">{p.name.slice(0,1).toUpperCase()}</div><div className="person-info"><strong>{p.name}</strong><small>{Math.round(Math.hypot((usersRef.current.get(selfIdRef.current)?.x || 0)-p.x,(usersRef.current.get(selfIdRef.current)?.y || 0)-p.y))} px away</small></div><span className="audio-wave">)))</span></div>)}</div> : <div className="empty-state"><div className="empty-icon">⌁</div><strong>No one nearby yet</strong><span>Move toward a teammate to connect.</span></div>}</section>
        <section className="metrics-row"><div className="metric-card"><span>IN EARSHOT</span><strong>{debug.count}</strong><small>users detected</small></div><div className="metric-card"><span>RANGE</span><strong>100<span className="metric-unit">px</span></strong><small>proximity radius</small></div></section>
      </aside>
    </main>
    <footer><span>PROXISPEAK <b>·</b> WEEK 2 PROTOTYPE</span><span>{hint}</span><span>REACT CANVAS + SOCKET.IO + WEBRTC</span></footer>
  </div>;
}
