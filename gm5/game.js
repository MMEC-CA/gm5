// Alberta English PAT Prep — Multiplayer Flashcard Battle
// Zero-dependency, P2P WebRTC, Signaling via Cloudflare Durable Objects.

const VERSION = '2026-05-13-aa';
const SIGNALING_URL = '/gm5/api/signal/ws';
const GW = 1280, GH = 720;

const SLOT_COLORS = ['#FF4040', '#4488FF', '#44DD44', '#FFE030'];
const MAX_SLOTS = 4;
const COUNTDOWN_DURATION = 3.0;
const HOLD_DURATION = 1.5;
const FEEDBACK_DURATION = 3.5;

const questions = [
  { q: "Which is the correct Canadian spelling?", a: ["Color", "Colour"], c: 1 },
  { q: "How do you spell this word in Alberta?", a: ["Center", "Centre"], c: 1 },
  { q: "Choose the correct spelling:", a: ["Favorite", "Favourite"], c: 1 },
  { q: "Which one is Canadian?", a: ["Theater", "Theatre"], c: 1 },
  { q: "Which is correct in Canada?", a: ["Gray", "Grey"], c: 1 },
  { q: "Choose the correct spelling:", a: ["Neighbor", "Neighbour"], c: 1 },
  { q: "Which is the Canadian spelling?", a: ["Traveled", "Travelled"], c: 1 },
  { q: "Which is correct for a bank document?", a: ["Check", "Cheque"], c: 1 },
  { q: "How do you spell 'flavor' in Canada?", a: ["Flavor", "Flavour"], c: 1 },
  { q: "Which is the correct spelling?", a: ["Defense", "Defence"], c: 1 },
  { q: "Which spelling is correct for the sport equipment?", a: ["Hockey puck", "Hocky puck"], c: 0 },
  { q: "What is the plural of 'Moose'?", a: ["Mooses", "Meese", "Moose"], c: 2 },
  { q: "Which is correct for a place where you get money?", a: ["Bank", "Banque"], c: 0 },
  { q: "How do you spell 'labour' in Canada?", a: ["Labor", "Labour"], c: 1 },
  { q: "Choose the correct Canadian spelling:", a: ["Apologize", "Apologise"], c: 0 },
  { q: "Which is a synonym for 'Vast'?", a: ["Small", "Huge", "Cold"], c: 1 },
  { q: "Which is an antonym for 'Tardy'?", a: ["Late", "Punctual", "Fast"], c: 1 },
  { q: "Correct the sentence: 'He ___ his homework already.'", a: ["did", "done", "does"], c: 0 },
  { q: "Which word is an adverb?", a: ["Quickly", "Bright", "Run"], c: 0 },
  { q: "Identify the properly spelled word:", a: ["Accomodate", "Accommodate"], c: 1 }
];

// ============================================================
// STATE
// ============================================================
let lobbyState = 'lobby'; // lobby, countdown, game, feedback, finish
let myPeerId = 'p' + Math.random().toString(36).slice(2, 9);
let mySlotIndex = -1;
let isHost = false;
let slots = Array.from({ length: MAX_SLOTS }, () => ({
  peerId: null, ready: false, progress: 0, holding: false, score: 0
}));

let currentQuestionIndex = 0;
let countdownTimer = COUNTDOWN_DURATION;
let feedbackTimer = 0;
let lastWinnerId = null;
let lastGuessCorrect = false;
let playerGuesses = new Map(); // peerId -> choice index
let questionStartTime = 0;

let sigWs = null;
let pcs = new Map();
let dcs = new Map();

// Input
let mousePos = { x: 0, y: 0 };
let mouseClicked = false;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
canvas.width = GW;
canvas.height = GH;

function resizeCanvas() {
  const scale = Math.min(window.innerWidth / GW, window.innerHeight / GH);
  canvas.style.width = (GW * scale) + 'px';
  canvas.style.height = (GH * scale) + 'px';
  canvas.style.position = 'absolute';
  canvas.style.left = ((window.innerWidth - GW * scale) / 2) + 'px';
  canvas.style.top = ((window.innerHeight - GH * scale) / 2) + 'px';
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function getCanvasMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = GW / rect.width;
  const scaleY = GH / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

canvas.addEventListener('mousemove', e => { mousePos = getCanvasMousePos(e); });
canvas.addEventListener('mousedown', e => { 
  mousePos = getCanvasMousePos(e); 
  mouseClicked = true;
  if (lobbyState === 'lobby') onFlapDown();
});
canvas.addEventListener('mouseup', e => { 
  mouseClicked = false;
  if (lobbyState === 'lobby') onFlapUp();
});
canvas.addEventListener('touchstart', e => { 
  mousePos = getCanvasMousePos(e.touches[0]); 
  mouseClicked = true;
  if (lobbyState === 'lobby') onFlapDown();
}, { passive: false });
canvas.addEventListener('touchend', e => { 
  mouseClicked = false;
  if (lobbyState === 'lobby') onFlapUp();
}, { passive: false });

// Keyboard for accessibility/desktop
document.addEventListener('keydown', e => {
  if (e.code === 'Space' || e.code === 'ArrowUp') onFlapDown();
  if (e.code >= 'Digit1' && e.code <= 'Digit4' && lobbyState === 'game') {
    submitGuess(parseInt(e.code[5]) - 1);
  }
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space' || e.code === 'ArrowUp') onFlapUp();
});

// ============================================================
// LOBBY MECHANICS
// ============================================================
let holdingFlap = false;
let holdStartTime = 0;

function onFlapDown() {
  if (lobbyState !== 'lobby') return;
  if (mySlotIndex < 0) claimSlot();
  if (mySlotIndex < 0) return;
  if (slots[mySlotIndex].ready) return;
  if (!holdingFlap) { holdingFlap = true; holdStartTime = performance.now(); slots[mySlotIndex].holding = true; }
}
function onFlapUp() {
  if (!holdingFlap) return;
  holdingFlap = false;
  if (mySlotIndex >= 0 && !slots[mySlotIndex].ready) {
    slots[mySlotIndex].holding = false; slots[mySlotIndex].progress = 0;
    broadcast({ type: 'lobby-release', peerId: myPeerId });
  }
}
function claimSlot() {
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (!slots[i].peerId) {
      mySlotIndex = i; slots[i].peerId = myPeerId;
      broadcast({ type: 'lobby-join', peerId: myPeerId, slotIndex: i });
      updateHost(); return;
    }
  }
}
function updateHost() {
  let hostId = mySlotIndex >= 0 ? myPeerId : null;
  for (let i = 0; i < MAX_SLOTS; i++) {
    const p = slots[i].peerId;
    if (p && (!hostId || p < hostId)) hostId = p;
  }
  isHost = (hostId === myPeerId);
}
function updateHold(dt) {
  if (!holdingFlap || mySlotIndex < 0 || slots[mySlotIndex].ready) return;
  const elapsed = (performance.now() - holdStartTime) / 1000;
  const progress = Math.min(100, (elapsed / HOLD_DURATION) * 100);
  slots[mySlotIndex].progress = progress;
  broadcast({ type: 'lobby-hold', peerId: myPeerId, progress });
  if (progress >= 100) {
    slots[mySlotIndex].ready = true; slots[mySlotIndex].holding = false; holdingFlap = false;
    broadcast({ type: 'lobby-ready', peerId: myPeerId });
    checkLobbyState();
  }
}
function checkLobbyState() {
  if (lobbyState !== 'lobby' || !isHost) return;
  const readyCount = slots.filter(s => s.ready).length;
  const totalPlayers = slots.filter(s => s.peerId).length;
  if (readyCount > 0 && readyCount === totalPlayers) {
    const msg = { type: 'game-start', hostPeerId: myPeerId };
    broadcast(msg);
    startGame(msg);
  }
}

// ============================================================
// GAME LOGIC
// ============================================================
function startGame(msg) {
  lobbyState = 'countdown';
  countdownTimer = COUNTDOWN_DURATION;
  currentQuestionIndex = 0;
  slots.forEach(s => s.score = 0);
  playerGuesses.clear();
}

function submitGuess(index) {
  if (lobbyState !== 'game') return;
  if (playerGuesses.has(myPeerId)) return; // Only one guess per question
  
  const q = questions[currentQuestionIndex];
  const correct = (index === q.c);
  
  broadcast({ type: 'guess', peerId: myPeerId, index, correct });
  handleGuess(myPeerId, index, correct);
}

function handleGuess(peerId, index, correct) {
  if (lobbyState !== 'game') return;
  playerGuesses.set(peerId, index);
  
  const slot = slots.find(s => s.peerId === peerId);
  if (correct) {
    if (slot) slot.score += 1;
    lastWinnerId = peerId;
    lastGuessCorrect = true;
    lobbyState = 'feedback';
    feedbackTimer = FEEDBACK_DURATION;
  } else {
    if (slot) slot.score -= 1;
    // Check if everyone has guessed wrong
    const activePeers = slots.filter(s => s.peerId).length;
    if (playerGuesses.size >= activePeers) {
      lastWinnerId = null;
      lastGuessCorrect = false;
      lobbyState = 'feedback';
      feedbackTimer = FEEDBACK_DURATION;
    }
  }
}

function nextQuestion() {
  currentQuestionIndex++;
  playerGuesses.clear();
  if (currentQuestionIndex >= questions.length) {
    lobbyState = 'finish';
  } else {
    lobbyState = 'game';
    questionStartTime = performance.now();
  }
}

// ============================================================
// NETWORKING (WebRTC + Signaling)
// ============================================================
function connect(room) {
  const params = new URLSearchParams(window.location.search);
  const r = room || params.get('room');
  const url = r
    ? `${SIGNALING_URL}?room=${encodeURIComponent(r)}&peerId=${myPeerId}`
    : `${SIGNALING_URL}?peerId=${myPeerId}`;
  
  sigWs = new WebSocket(url);
  sigWs.onmessage = onSigMsg;
}

function onSigMsg(ev) {
  const data = JSON.parse(ev.data);
  if (data.type === 'peers') {
    data.peers.forEach(id => { if (id !== myPeerId && !pcs.has(id) && myPeerId < id) createPc(id, true); });
  } else if (data.type === 'peer-joined') {
    if (data.peerId !== myPeerId && !pcs.has(data.peerId) && myPeerId < data.peerId) createPc(data.peerId, true);
  } else if (data.type === 'peer-left') {
    cleanupPeer(data.peerId);
  } else if (data.type === 'signal') {
    handleSignal(data.from, data.signal);
  }
}

function createPc(peerId, initiator) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pcs.set(peerId, pc);
  pc.onicecandidate = e => { if (e.candidate) sendSig(peerId, e.candidate.toJSON()); };
  const dc = pc.createDataChannel('game', { negotiated: true, id: 0 });
  dcs.set(peerId, dc);
  dc.onopen = () => {
    dc.send(JSON.stringify({ type: 'lobby-sync', slots: slots.map((s, i) => ({ ...s, index: i })), lobbyState, currentQuestionIndex }));
  };
  dc.onmessage = e => handleMsg(peerId, JSON.parse(e.data));
  if (initiator) pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => sendSig(peerId, pc.localDescription));
}

function handleSignal(from, sig) {
  let pc = pcs.get(from);
  if (!pc) { createPc(from, false); pc = pcs.get(from); }
  if (sig.type === 'offer') {
    pc.setRemoteDescription(new RTCSessionDescription(sig)).then(() => pc.createAnswer()).then(a => pc.setLocalDescription(a)).then(() => sendSig(from, pc.localDescription));
  } else if (sig.type === 'answer') {
    pc.setRemoteDescription(new RTCSessionDescription(sig));
  } else if (sig.candidate !== undefined) {
    pc.addIceCandidate(new RTCIceCandidate(sig));
  }
}

function sendSig(to, signal) { if (sigWs?.readyState === WebSocket.OPEN) sigWs.send(JSON.stringify({ type: 'signal', to, signal })); }
function broadcast(msg) { const s = JSON.stringify(msg); dcs.forEach(dc => { if (dc.readyState === 'open') dc.send(s); }); }

function cleanupPeer(peerId) {
  pcs.get(peerId)?.close(); pcs.delete(peerId); dcs.delete(peerId);
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (slots[i].peerId === peerId) slots[i] = { peerId: null, ready: false, progress: 0, holding: false, score: 0 };
  }
  updateHost();
}

function handleMsg(from, data) {
  switch (data.type) {
    case 'lobby-sync':
      data.slots.forEach(s => {
        if (!s.peerId || s.peerId === myPeerId) return;
        slots[s.index].peerId = s.peerId; slots[s.index].ready = s.ready; slots[s.index].score = s.score;
      });
      if (lobbyState === 'lobby' && data.lobbyState !== 'lobby') {
        lobbyState = data.lobbyState;
        currentQuestionIndex = data.currentQuestionIndex;
      }
      updateHost();
      break;
    case 'lobby-join':
      slots[data.slotIndex].peerId = data.peerId; updateHost(); break;
    case 'lobby-hold':
      slots.forEach(s => { if (s.peerId === data.peerId) { s.holding = true; s.progress = data.progress; } }); break;
    case 'lobby-ready':
      slots.forEach(s => { if (s.peerId === data.peerId) { s.ready = true; s.holding = false; } }); checkLobbyState(); break;
    case 'lobby-release':
      slots.forEach(s => { if (s.peerId === data.peerId) { s.holding = false; s.progress = 0; } }); break;
    case 'game-start':
      startGame(data); break;
    case 'sync-game':
      lobbyState = data.lobbyState;
      currentQuestionIndex = data.currentQuestionIndex;
      if (lobbyState === 'game') {
        playerGuesses.clear();
        questionStartTime = performance.now();
      }
      break;
    case 'guess':
      handleGuess(data.peerId, data.index, data.correct); break;
  }
}

// ============================================================
// DRAWING
// ============================================================
function draw() {
  ctx.clearRect(0, 0, GW, GH);
  
  if (lobbyState === 'lobby') drawLobby();
  else if (lobbyState === 'countdown') drawCountdown();
  else if (lobbyState === 'game') drawQuestion();
  else if (lobbyState === 'feedback') drawFeedback();
  else if (lobbyState === 'finish') drawFinish();
  
  drawScores();
}

function drawLobby() {
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Alberta English PAT Prep', GW / 2, 100);
  ctx.font = '24px sans-serif';
  ctx.fillText('Join a slot and HOLD to ready up!', GW / 2, 150);
  
  for (let i = 0; i < MAX_SLOTS; i++) {
    const x = GW / 2 - 300 + i * 200;
    const y = 300;
    const s = slots[i];
    
    ctx.fillStyle = s.peerId ? SLOT_COLORS[i] : '#444';
    ctx.beginPath(); ctx.roundRect(x - 80, y, 160, 200, 20); ctx.fill();
    
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(s.peerId ? (s.peerId === myPeerId ? 'YOU' : 'PLAYER') : 'EMPTY', x, y + 100);
    
    if (s.ready) {
      ctx.fillStyle = '#44FF44';
      ctx.fillText('READY', x, y + 150);
    } else if (s.holding) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 60, y + 140, 120 * (s.progress / 100), 10);
    }
    
    // Check click on slot
    if (mouseClicked && mousePos.x > x - 80 && mousePos.x < x + 80 && mousePos.y > y && mousePos.y < y + 200) {
      if (!s.peerId) {
        mySlotIndex = i; slots[i].peerId = myPeerId;
        broadcast({ type: 'lobby-join', peerId: myPeerId, slotIndex: i });
        updateHost();
      }
    }
  }
}

function drawCountdown() {
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 120px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(Math.ceil(countdownTimer), GW / 2, GH / 2);
}

function drawQuestion() {
  const q = questions[currentQuestionIndex];
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(q.q, GW / 2, 200);
  
  q.a.forEach((opt, i) => {
    const x = GW / 2 - 200;
    const y = 300 + i * 80;
    const hover = mousePos.x > x && mousePos.x < x + 400 && mousePos.y > y && mousePos.y < y + 60;
    
    ctx.fillStyle = hover ? '#4488FF' : '#333';
    ctx.beginPath(); ctx.roundRect(x, y, 400, 60, 10); ctx.fill();
    
    ctx.fillStyle = '#fff';
    ctx.font = '24px sans-serif';
    ctx.fillText(opt, GW / 2, y + 38);
    
    if (hover && mouseClicked) {
      mouseClicked = false;
      submitGuess(i);
    }
  });
}

function drawFeedback() {
  const q = questions[currentQuestionIndex];
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(q.q, GW / 2, 200);
  
  q.a.forEach((opt, i) => {
    const x = GW / 2 - 200;
    const y = 300 + i * 80;
    const isCorrect = (i === q.c);
    
    ctx.fillStyle = isCorrect ? '#44FF44' : '#FF4444';
    ctx.globalAlpha = isCorrect ? 1 : 0.3;
    ctx.beginPath(); ctx.roundRect(x, y, 400, 60, 10); ctx.fill();
    ctx.globalAlpha = 1;
    
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(opt + (isCorrect ? ' ✓' : ''), GW / 2, y + 38);
  });
  
  ctx.fillStyle = lastGuessCorrect ? '#44FF44' : '#FF4444';
  ctx.font = 'bold 32px sans-serif';
  const winner = slots.find(s => s.peerId === lastWinnerId);
  const msg = lastGuessCorrect ? (winner === slots[mySlotIndex] ? "Correct! You got a point!" : "Someone else got it first!") : "Everyone guessed wrong!";
  ctx.fillText(msg, GW / 2, 600);
}

function drawFinish() {
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 64px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Game Over!', GW / 2, 200);
  
  const sorted = [...slots].filter(s => s.peerId).sort((a, b) => b.score - a.score);
  sorted.forEach((s, i) => {
    ctx.fillStyle = SLOT_COLORS[slots.indexOf(s)];
    ctx.font = '32px sans-serif';
    ctx.fillText(`${s.peerId === myPeerId ? 'YOU' : 'PLAYER'}: ${s.score} points`, GW / 2, 300 + i * 50);
  });
  
  ctx.fillStyle = '#aaa';
  ctx.font = '24px sans-serif';
  ctx.fillText('Refresh to play again', GW / 2, 600);
}

function drawScores() {
  for (let i = 0; i < MAX_SLOTS; i++) {
    const s = slots[i];
    if (!s.peerId) continue;
    ctx.fillStyle = SLOT_COLORS[i];
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${s.peerId === myPeerId ? 'YOU' : 'P' + (i + 1)}: ${s.score}`, 20 + i * 150, 40);
  }
}

// ============================================================
// MAIN LOOP
// ============================================================
let lastTime = 0;
function loop(ts) {
  const dt = (ts - (lastTime || ts)) / 1000;
  lastTime = ts;
  
  if (lobbyState === 'lobby') {
    updateHold(dt);
  } else if (lobbyState === 'countdown') {
    countdownTimer -= dt;
    if (countdownTimer <= 0) {
      if (isHost) {
        questionStartTime = performance.now();
        lobbyState = 'game';
        broadcast({ type: 'sync-game', lobbyState, currentQuestionIndex });
      } else {
        // Wait for host
      }
    }
  } else if (lobbyState === 'feedback') {
    feedbackTimer -= dt;
    if (feedbackTimer <= 0 && isHost) {
      nextQuestion();
      broadcast({ type: 'sync-game', lobbyState, currentQuestionIndex });
    }
  }
  
  draw();
  requestAnimationFrame(loop);
}

connect();
requestAnimationFrame(loop);
