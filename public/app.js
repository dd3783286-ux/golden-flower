let me = null;
let room = null;
let socket = null;
let pending = false;
let lastAnimatedRound = 0;
let lastWinnerId = null;
let previousPot = 0;
let toastTimer = null;
let raiseOpen = false;
let lastTurnKey = '';
let dismissedRevealId = null;
let lastSeenRound = 0;
let lastSeenState = false;
let handSpokenThisRound = false; // 本局是否已播报过自己的牌型(看牌时播一次)
let visualStateRound = 0;
let previousPlayerVisualStates = new Map();
let lastTableActionId = null;
let tableActionTimer = null;
let compareRevealTimer = null;
let winnerRevealTimer = null;
let recordCache = null;
let deckWarmingStarted = false;
let chipFlightTimer = null;
let peekTimer = null;
let lastRevealAt = 0;
let offlineWarnTimer = null;

const $ = (selector) => document.querySelector(selector);
const BET_LEVELS = [1, 2, 5, 10, 20, 50, 100, 200, 500];
const CHIP_AMOUNTS = [100, 200, 300, 500];
const CARD_ASSET_ROOT = '/assets/cards-standard';
const CARD_SUIT_NAMES = { '♣': 'c', '♦': 'd', '♥': 'h', '♠': 's' };
const seatPositions = [
  [50, 10], [76, 18], [90, 35], [91, 58], [76, 78],
  [50, 80], [24, 78], [9, 58], [10, 35], [24, 18]
];
const seatLayouts = {
  1: [5],
  2: [5, 0],
  3: [5, 8, 2],
  4: [5, 8, 0, 2],
  5: [5, 7, 9, 1, 3],
  6: [5, 7, 8, 0, 2, 3],
  7: [5, 6, 8, 9, 1, 2, 4],
  8: [5, 6, 7, 9, 0, 1, 3, 4],
  9: [5, 6, 7, 8, 9, 0, 1, 2, 3],
  10: [5, 6, 7, 8, 9, 0, 1, 2, 3, 4]
};

function showScreen(selector) {
  ['#login', '#lobby', '#table'].forEach((id) => $(id).classList.add('hidden'));
  $(selector).classList.remove('hidden');
  $('#app').classList.toggle('in-game', selector === '#table');
  if (selector === '#table') maybeTour();
}

// ---- 音效系统:Web Audio 合成,无需外部音频文件 ----
let audioCtx = null;
let audioUnlocked = false; // 是否已获得用户手势解锁(iOS 必须手势后才能发声)
function ensureAudio() {
  if (!audioUnlocked) return null; // 未手势解锁不创建(避免iOS创建即挂起的僵尸上下文)
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch { audioCtx = null; }
  return audioCtx;
}
function tone(freq, dur, type = 'sine', vol = 0.12, when = 0) {
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  } catch { /* 忽略 */ }
}
const SOUNDS = {
  deal: () => { tone(340, 0.05, 'triangle', 0.12); tone(215, 0.08, 'triangle', 0.1, 0.055); },
  chip: () => { tone(560, 0.045, 'sine', 0.1); tone(780, 0.06, 'sine', 0.08, 0.045); },
  compare: () => { tone(190, 0.2, 'sawtooth', 0.09); tone(125, 0.28, 'sawtooth', 0.07, 0.09); },
  fold: () => { tone(220, 0.12, 'triangle', 0.1); tone(150, 0.16, 'triangle', 0.08, 0.09); },
  see: () => { tone(430, 0.04, 'triangle', 0.1); tone(640, 0.05, 'triangle', 0.08, 0.04); },
  win: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'triangle', 0.11, i * 0.12)); },
  toast: () => { tone(880, 0.09, 'sine', 0.14); tone(1320, 0.12, 'sine', 0.1, 0.06); },
  // 开局洗牌声:白噪声低通,模拟唰唰唰
  shuffle: () => {
    const ctx = ensureAudio();
    if (!ctx) return;
    try {
      const dur = 1.5;
      const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2000;
      const gain = ctx.createGain();
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.08, t + 0.12);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(filter).connect(gain).connect(ctx.destination);
      src.start();
      src.stop(t + dur + 0.05);
    } catch { /* 忽略 */ }
  },
  // 落牌嗒声:发牌时每张一声
  tap: () => { tone(1400, 0.028, 'square', 0.045); }
};
let soundMuted = false;
let voiceMuted = false;
function playSound(name) {
  if (soundMuted) return; // 音效开关:关闭后只保留人声(TTS)
  try {
    const ctx = ensureAudio();
    if (ctx && ctx.state === 'suspended') {
      // 音频被挂起(iOS 常见):尝试唤醒后重播一次,唤醒失败等下次手势
      ctx.resume().then(() => { try { SOUNDS[name]?.(); } catch { /* 忽略 */ } }).catch(() => { /* 忽略 */ });
      return;
    }
    SOUNDS[name]?.();
  } catch { /* 忽略 */ }
}
// 浏览器自动播放策略:必须在用户首次手势后解锁音频,否则音效被静音
const unlockAudio = () => {
  audioUnlocked = true; // 先标记已解锁,再创建上下文(手势中创建才允许发声)
  const ctx = ensureAudio();
  // 解锁成功立即播放一声"叮",用于确认音效通道已打开
  if (ctx && ctx.state === 'running') playSound('toast');
  // 同时初始化人声(TTS),部分浏览器/系统要求手势后才有权限
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.resume?.();
      window.speechSynthesis.getVoices();
    } catch { /* 忽略 */ }
  }
};
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('touchstart', unlockAudio, { once: true });
document.addEventListener('click', unlockAudio, { once: true });
// 每次用户手势都尝试恢复音频:iOS 会不定期挂起 AudioContext(切后台/长时间无操作),
// 且只有用户手势能 resume——这是"音效一会有一会没有"的根因
const resumeAudioOnGesture = () => {
  audioUnlocked = true;
  try {
    const ctx = ensureAudio();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    window.speechSynthesis?.resume?.();
  } catch { /* 忽略 */ }
};
document.addEventListener('pointerdown', resumeAudioOnGesture);
document.addEventListener('touchstart', resumeAudioOnGesture);
document.addEventListener('click', resumeAudioOnGesture);

// ---- 人声播报(TTS,关键节点) ----
// 优先选择年轻女性中文语音;iOS 中文女声:月/婷婷/美嘉/善怡等,排除英文女声名(Flo/Sandy 等合中文像英文口音)
const FEMALE_VOICE_HINTS = [
  '月', '婷婷', '美嘉', '善怡', '小美', '小瑶', 'tingting', 'meijia', 'shanyi', 'xiaoyan', 'xiaoxiao', 'huihui', 'yaoyao', 'lili', 'jiajia',
  'female', 'woman', 'girl', 'ting'
];
const MALE_VOICE_HINTS = [
  'zhiwei', '志伟', 'eddy', 'reed', 'rocko', 'grandpa', 'shelley', 'daniel', 'alex', 'fred', 'oliver', 'arthur', 'male', 'boy'
];
function pickZhVoice() {
  try {
    const voices = window.speechSynthesis.getVoices();
    const zh = voices.filter((voice) => voice.lang && voice.lang.toLowerCase().startsWith('zh'));
    if (!zh.length) return null;
    const byFemale = zh.find((voice) => FEMALE_VOICE_HINTS.some((hint) => voice.name.toLowerCase().includes(hint)));
    if (byFemale) return byFemale;
    const notMale = zh.find((voice) => !MALE_VOICE_HINTS.some((hint) => voice.name.toLowerCase().includes(hint)));
    if (notMale) return notMale;
    return zh.find((voice) => voice.default) || zh[0];
  } catch { return null; }
}

// 真人女声语音片段(edge-tts 晓晓生成,活泼年轻),优先播放;未匹配的走 TTS
const VOICE_CLIPS = [
  ['豹子', 'sounds/baozi.mp3'],
  ['顺金', 'sounds/shunjin.mp3'],
  ['金花', 'sounds/jinhua.mp3'],
  ['顺子', 'sounds/shunzi.mp3'],
  ['对子', 'sounds/duizi.mp3'],
  ['散牌', 'sounds/sanpai.mp3'],
  ['轮到你了', 'sounds/lundao.mp3'],
  ['请尽快操作', 'sounds/kuaidian.mp3'],
  ['你赢了比牌', 'sounds/wincompare.mp3'],
  ['你赢了本局', 'sounds/win.mp3'],
  ['比牌失败', 'sounds/lose.mp3'],
  ['筹码已到账', 'sounds/chip.mp3'],
  ['跟注', 'sounds/genzhu.mp3'],
  ['加注', 'sounds/jiazhu.mp3'],
  ['比牌', 'sounds/bipai.mp3'],
  ['看牌', 'sounds/kanpai.mp3'],
  ['弃牌', 'sounds/qipai.mp3']
];
const voiceClipCache = {};
// 人声去重:同一条文案 600ms 内不重复播(防机器人连招"跟注跟注跟注"刷屏)
let lastSpeakText = '';
let lastSpeakAt = 0;
// 语音串行队列:一次只播一条,播完再播下一条。
// 解决"看牌+牌型"(看牌!顺子!)等两条语音几乎同时触发时互相打断导致只响一条的问题
const voiceQueue = [];
let voicePlaying = false;
let voiceFallbackTimer = null;
function playVoiceClip(src) {
  voiceQueue.push(src);
  if (voiceQueue.length > 4) voiceQueue.shift(); // 队列上限,防堆积
  pumpVoiceQueue();
}
function pumpVoiceQueue() {
  if (voicePlaying || !voiceQueue.length) return;
  voicePlaying = true;
  const src = voiceQueue.shift();
  clearTimeout(voiceFallbackTimer); // 只保留一个兜底计时器,避免旧timer误杀正在播的下一条
  try {
    // 复用同源 Audio 元素(串行队列保证同一时刻只有一个在播,复用安全)
    // 避免每次 cloneNode 新建导致 iOS 长会话下 Audio 元素累积被拒播
    const player = voiceClipCache[src] || (voiceClipCache[src] = new Audio(src));
    player.volume = 1;
    player.currentTime = 0;
    const done = () => { voicePlaying = false; pumpVoiceQueue(); };
    player.onended = done;
    player.onerror = done;
    player.play().catch(done);
    // 兜底:5秒强制播下一条(防止 onended 不触发导致队列卡死)
    voiceFallbackTimer = setTimeout(() => { if (voicePlaying) { voicePlaying = false; pumpVoiceQueue(); } }, 5_000);
  } catch {
    voicePlaying = false;
    pumpVoiceQueue();
  }
}

function speak(text) {
  if (voiceMuted) return; // 人声开关
  const now = Date.now();
  if (text === lastSpeakText && now - lastSpeakAt < 600) return; // 同文案去重
  lastSpeakText = text;
  lastSpeakAt = now;
  try {
    // 优先播放真人女声片段
    for (const [key, src] of VOICE_CLIPS) {
      if (text.includes(key)) {
        playVoiceClip(src);
        return;
      }
    }
    // 兜底:浏览器语音合成
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.02;   // 语速略快,更活泼(仍清晰)
    utterance.pitch = 1.35;  // 音调明显提高,更年轻有活力
    const zhVoice = pickZhVoice();
    if (zhVoice) utterance.voice = zhVoice;
    // 延迟播报,避免 iOS 上 cancel 后立即 speak 被吞
    setTimeout(() => { try { window.speechSynthesis.speak(utterance); } catch { /* 忽略 */ } }, 60);
  } catch { /* 忽略 */ }
}
if ('speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  document.addEventListener('voiceschanged', () => window.speechSynthesis.getVoices());
}

// 前端牌型评估(与服务端规则一致,用于看牌播报)
function evaluateHandTypeName(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) return '';
  const ranks = cards.map((card) => card.rank).sort((a, b) => b - a);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  let straightHigh = null;
  if (ranks[0] - ranks[1] === 1 && ranks[1] - ranks[2] === 1) straightHigh = ranks[0];
  if (ranks.join(',') === '14,3,2') straightHigh = 3;
  const counts = new Map();
  ranks.forEach((rank) => counts.set(rank, (counts.get(rank) || 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  if (groups[0][1] === 3) return '豹子';
  if (flush && straightHigh) return '顺金';
  if (flush) return '金花';
  if (straightHigh) return '顺子';
  if (groups[0][1] === 2) return '对子';
  return '单张';
}
let lastSpokenRevealId = null;
let lastSpokenTurnKey = '';
let lastWarnKey = '';
let awaitingChipCredit = false;
let lastMyChips = 0;

// ---- 首次进房新手引导(只提示一次) ----
let tourShown = false;
function maybeTour() {
  if (tourShown) return;
  try { if (localStorage.getItem('gf_tour_done')) { tourShown = true; return; } } catch { tourShown = true; return; }
  tourShown = true;
  setTimeout(() => toast('点右上角「邀请好友」把链接发给朋友一起玩'), 1400);
  setTimeout(() => toast('先点「准备」并申请筹码 · 轮到你时下方会出现操作按钮'), 5600);
  setTimeout(() => toast('30秒不操作会自动托管跟注,可随时点「托管」取消'), 9800);
  try { localStorage.setItem('gf_tour_done', '1'); } catch { /* 忽略 */ }
}

function viewerId() { return room?.viewerId || me?.id; }
function localCompareCost(player, target) {
  return room.currentBet * (player?.seen ? 2 : 1);
}

function resetRoomVisualState() {
  lastAnimatedRound = 0;
  lastWinnerId = null;
  previousPot = 0;
  raiseOpen = false;
  lastTurnKey = '';
  dismissedRevealId = null;
  lastSeenRound = 0;
  lastSeenState = false;
  visualStateRound = 0;
  previousPlayerVisualStates = new Map();
  lastTableActionId = null;
  recordCache = null;
  clearTimeout(tableActionTimer);
  clearTimeout(compareRevealTimer);
  clearTimeout(winnerRevealTimer);
  clearTimeout(chipFlightTimer);
  $('#chipFlight')?.classList.add('hidden');
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  try {
    const data = await fetch('/api/me').then((response) => response.json());
    me = data.user;
    $('#wxLogin').classList.toggle('hidden', !data.wechatConfigured);
    $('#devForm').classList.toggle('hidden', !data.devLogin);
    $('#logout').classList.toggle('hidden', !me);
    if (me) {
      $('#user').textContent = me.name;
      showScreen('#lobby');
      connect();
      warmCardDeck();
    } else {
      showScreen('#login');
    }
    const invitedRoom = new URLSearchParams(location.search).get('room');
    if (invitedRoom) $('#roomCode').value = invitedRoom.slice(0, 6);
    checkVersion();
  } catch {
    toast('页面连接失败，请刷新重试');
  }
}

// 新版本提示:服务器版本与本地记录不同时提示刷新
function checkVersion() {
  fetch('/api/version').then((response) => response.json()).then(({ version }) => {
    const prev = localStorage.getItem('gfVersion');
    if (prev && prev !== version) showVersionBar();
    localStorage.setItem('gfVersion', version);
  }).catch(() => {});
}
function showVersionBar() {
  if (document.getElementById('versionBar')) return;
  const bar = document.createElement('div');
  bar.id = 'versionBar';
  bar.textContent = '发现新版本,点这里刷新';
  bar.setAttribute('role', 'button');
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99;background:linear-gradient(145deg,#ffe184,#e5a432);color:#302008;text-align:center;padding:9px;font-weight:800;cursor:pointer;box-shadow:0 2px 10px #0006';
  bar.onclick = () => location.reload();
  document.body.appendChild(bar);
}

function connect() {
  socket?.disconnect();
  socket = io();
  socket.on('connect', () => {
    setNetwork(true);
    clearTimeout(offlineWarnTimer);
    const code = new URLSearchParams(location.search).get('room')?.slice(0, 6);
    if (!code) return;
    socket.timeout(5_000).emit('join-room', { code }, (timeoutError, response) => {
      if (timeoutError || !response?.ok) return toast(response?.error || '恢复房间失败，请重新加入');
      showScreen('#table');
    });
  });
  socket.on('disconnect', () => {
    setNetwork(false);
    // 断线警告:30秒会被移出,20秒时提醒
    clearTimeout(offlineWarnTimer);
    offlineWarnTimer = setTimeout(() => toast('⚠️ 网络断开,还有约1分钟将被移出房间,请尽快回来'), 9 * 60_000);
  });
  socket.on('connect_error', () => setNetwork(false));
  socket.on('room', (state) => {
    const sameRoom = room?.code === state.code;
    const potDelta = sameRoom ? Math.max(0, state.pot - previousPot) : 0;
    const newAction = sameRoom && state.lastAction?.id && state.lastAction.id !== room?.lastAction?.id;
    const animationAmount = newAction && Number(state.lastAction.amount) > 0 ? Number(state.lastAction.amount) : potDelta;
    if (room?.code && room.code !== state.code) resetRoomVisualState();
    const nextTurnKey = `${state.round}:${state.turn}`;
    if (nextTurnKey !== lastTurnKey) raiseOpen = false;
    lastTurnKey = nextTurnKey;
    room = state;
    previousPot = state.pot;
    // 筹码到账检测:刚提交申请且筹码增加 → 播报
    const mineNow = state.players.find((player) => player.id === me?.id);
    if (awaitingChipCredit && mineNow && mineNow.chips > lastMyChips) {
      awaitingChipCredit = false;
      speak('筹码已到账');
    }
    lastMyChips = mineNow?.chips ?? lastMyChips;
    scheduleRender(animationAmount);
  });
}

// 渲染合并:连续广播(机器人连招/多人操作)合并为每帧一次全量渲染,减轻手机渲染压力
let renderScheduled = false;
let pendingAnimationAmount = 0;
function scheduleRender(animationAmount = 0) {
  if (animationAmount) pendingAnimationAmount = animationAmount;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
    if (pendingAnimationAmount > 0) {
      animateChip(pendingAnimationAmount);
      pendingAnimationAmount = 0;
    }
  });
}

function setNetwork(online) {
  $('#network').textContent = online ? '在线' : '重连中';
  $('#network').classList.toggle('online', online);
  $('#network').classList.toggle('offline', !online);
}

function emit(event, data, callback) {
  if (!socket?.connected) return toast('网络正在重连，请稍候');
  if (pending) return;
  pending = true;
  socket.timeout(5_000).emit(event, data, (timeoutError, response) => {
    pending = false;
    if (timeoutError) return toast('操作超时，请检查网络');
    if (!response?.ok) return toast(response?.error || '操作失败');
    callback?.(response);
  });
}

$('#devForm').onsubmit = async (event) => {
  event.preventDefault();
  const response = await fetch('/api/dev-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('#nickname').value }) });
  const data = await response.json();
  if (!response.ok) return toast(data.error);
  me = data.user;
  $('#user').textContent = me.name;
  $('#logout').classList.remove('hidden');
  showScreen('#lobby');
  connect();
};

const testSoundHandler = () => {
  const ctx = ensureAudio();
  if (!ctx) return toast('此浏览器不支持音效');
  playSound('toast');
  setTimeout(() => playSound('deal'), 300);
  speak('声音测试正常');
  toast('应听到:电子叮-嗒声 + 人声「声音测试正常」');
};
$('#testSound').onclick = testSoundHandler;
$('#testSoundLobby').onclick = testSoundHandler;

// 音效开关:关掉合成音效,保留人声
$('#muteButton').onclick = () => {
  soundMuted = !soundMuted;
  $('#muteButton').classList.toggle('muted', soundMuted);
  toast(soundMuted ? '合成音效已关闭(人声保留)' : '合成音效已开启');
};

// 人声开关:关闭真人女声与语音播报
$('#voiceButton').onclick = () => {
  voiceMuted = !voiceMuted;
  $('#voiceButton').classList.toggle('muted', voiceMuted);
  if (voiceMuted) window.speechSynthesis?.cancel();
  toast(voiceMuted ? '人声已关闭(音效保留)' : '人声已开启');
};

$('#logout').onclick = () => confirmAction('切换账号', '将退出当前登录账号，确定继续吗？', async () => {
  if (room) return toast('请先退出房间');
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/';
});

$('#create').onclick = () => {
  showSheet('<h3>创建房间</h3><p class="meta">选择房间类型</p>'
    + '<button data-room-type="1" class="player-choice"><span class="avatar-small">🌐</span>公开房间<small>出现在大厅,任何人都能加入</small></button>'
    + '<button data-room-type="0" class="player-choice"><span class="avatar-small">🔒</span>私密房间<small>仅凭房间号/邀请链接加入</small></button>');
  $('#sheetContent').querySelectorAll('[data-room-type]').forEach((button) => button.onclick = () => {
    const isPublic = button.dataset.roomType === '1';
    closeSheet();
    emit('create-room', { isPublic }, (response) => {
      if (response?.reused) toast('你已有一个房间,直接进入');
      resetRoomVisualState();
      history.replaceState(null, '', `/?room=${response.code}`);
      showScreen('#table');
    });
  });
};
$('#joinForm').onsubmit = (event) => {
  event.preventDefault();
  const code = $('#roomCode').value.trim();
  emit('join-room', { code }, () => {
    resetRoomVisualState();
    history.replaceState(null, '', `/?room=${code}`);
    showScreen('#table');
  });
};

function render() {
  if (!room || !me) return;
  showScreen('#table');
  roomMemberChanges();
  const mine = room.players.find((player) => player.id === viewerId());
  const turnPlayer = room.players[room.turn];
  $('#code').textContent = room.code;
  $('#pot').textContent = room.pot;
  $('#baseBet').textContent = room.baseBet;
  $('#currentBet').textContent = room.currentBet;
  $('#round').textContent = room.round;
  $('#roomStatus').textContent = room.status === 'playing' ? `${turnPlayer?.name || '玩家'} 操作中` : `${room.players.length}/10人 · 等待开局`;
  const owner = room.players.find((player) => player.id === room.ownerId);
  $('#ownerName').textContent = `房主 ${owner?.name || '-'}`;
  $('#table').classList.toggle('is-waiting', room.status === 'waiting');
  renderTableAction();
  renderPlayers();
  renderHand(mine);
  renderActions(mine, turnPlayer);
  renderBadge();
  renderCompare();
  renderWinner();
  renderTrustee(mine);
}

function renderTableAction() {
  const action = room.lastAction;
  const element = $('#tableAction');
  if (!element || !action || action.id === lastTableActionId) return;
  lastTableActionId = action.id;
  if (action.round !== room.round || Date.now() - action.at > 5_000) return;
  if (action.type === 'call') { playSound('chip'); speak('跟注'); }
  else if (action.type === 'raise') { playSound('chip'); speak('加注'); }
  else if (action.type === 'compare') { playSound('compare'); speak('比牌'); }
  else if (action.type === 'see') { playSound('see'); speak('看牌'); }
  else if (action.type === 'fold') {
    playSound('fold');
    speak('弃牌');
    toast(`🃏 ${action.playerName} 弃牌了`);
    foldCardsAway(action.playerId);
  }
  // 真人感:操作气泡说话
  const lines = BUBBLE_LINES[action.type];
  if (lines) showSeatBubble(action.playerId, lines[Math.floor(Math.random() * lines.length)]);
  // 真人感:大额加注桌面微震
  if (action.type === 'raise' && action.stake >= 50) {
    const stage = $('#tableStage');
    if (stage) {
      stage.classList.remove('shake');
      void stage.offsetWidth; // 重启动画
      stage.classList.add('shake');
      setTimeout(() => stage.classList.remove('shake'), 500);
    }
  }

  const descriptions = {
    call: ['跟注', action.amount ? `投入 ${action.amount}` : ''],
    raise: [`加注至 ${action.stake}`, action.amount ? `投入 ${action.amount}` : ''],
    compare: [`比牌 ${action.targetName || ''}`.trim(), action.amount ? `投入 ${action.amount}` : ''],
    fold: ['弃牌', action.automated ? '托管自动操作' : '']
  };
  const [label, detail] = descriptions[action.type] || [action.type, ''];
  element.innerHTML = `<small>${esc(action.playerName)}</small><strong>${esc(label)}</strong>${detail ? `<em>${esc(detail)}</em>` : ''}`;
  element.className = `table-action action-${esc(action.type)}`;
  clearTimeout(tableActionTimer);
  const keyframes = action.type === 'fold'
    ? [{ opacity: 0, transform: 'translate(-50%,-35%) scale(1.35)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: .28 }, { opacity: 0, transform: 'translate(-50%,-70%) scale(.92)' }]
    : [{ opacity: 0, transform: 'translate(-50%,15%) scale(.45)' }, { opacity: 1, transform: 'translate(-50%,-58%) scale(1.12)', offset: .36 }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: .72 }, { opacity: 0, transform: 'translate(-50%,-62%) scale(.94)' }];
  element.animate(keyframes, { duration: 1_650, easing: 'cubic-bezier(.2,.8,.2,1)' });
  tableActionTimer = setTimeout(() => element.classList.add('hidden'), 1_650);
}

// 玩家专属头像色相:同一玩家颜色固定,一眼区分
function avatarHue(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return hash;
}

// 进出房提示:检测玩家列表变化,顶部横幅提示
let lastPlayerMap = new Map();
let memberToastTimer = null;
function roomMemberChanges() {
  const map = new Map(room.players.map((player) => [player.id, player.name]));
  const changed = [];
  if (lastPlayerMap.size > 0) {
    for (const [id, name] of map) if (!lastPlayerMap.has(id)) changed.push(`${name} 加入了牌局`);
    for (const [id, name] of lastPlayerMap) if (!map.has(id)) changed.push(`${name} 离开了牌局`);
  }
  lastPlayerMap = map;
  if (!changed.length) return;
  clearTimeout(memberToastTimer);
  memberToastTimer = setTimeout(() => changed.forEach((text) => toast(text)), 260);
}

// 真人牌桌氛围:开局时一张一张轮发牌(牌背从中央牌堆飞向每个玩家),发完才亮牌面
let dealAnimActive = false;
function dealCardsAnimation() {
  const stage = $('#tableStage');
  if (!stage || dealAnimActive) return;
  dealAnimActive = true;
  const rect = stage.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const seats = [...document.querySelectorAll('#players .player-seat')].map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2 - rect.left, y: r.top + r.height / 2 - rect.top };
  });
  if (!seats.length) { dealAnimActive = false; return; }
  playSound('shuffle'); // 开局洗牌声
  $('#potChips')?.replaceChildren(); // 新局清空池边筹码堆
  // 轮发顺序:每轮每人一张(真人逆时针发牌)
  const order = [];
  for (let roundIdx = 0; roundIdx < 3; roundIdx += 1) {
    for (let i = 0; i < seats.length; i += 1) order.push(seats[i]);
  }
  // 发牌期间隐藏各家牌面,只留牌堆
  $('#cards').classList.add('dealing');
  document.querySelectorAll('.opponent-cards').forEach((el) => el.classList.add('dealing'));
  // 中央牌堆(3层牌背),最后一张发出后淡出
  const deck = document.createElement('div');
  deck.className = 'deal-deck';
  deck.innerHTML = '<i></i><i></i><i></i>';
  stage.appendChild(deck);
  const step = 150;
  order.forEach((seat, idx) => {
    setTimeout(() => {
      playSound('tap'); // 落牌嗒声
      const card = document.createElement('div');
      card.className = 'deal-fly-card';
      card.style.left = `${cx}px`;
      card.style.top = `${cy}px`;
      stage.appendChild(card);
      const dx = seat.x - cx;
      const dy = seat.y - cy;
      const rotation = idx % 2 ? 10 : -10;
      card.animate(
        [
          { transform: 'translate(-50%,-50%) rotate(0deg) scale(1)', opacity: 1 },
          { transform: `translate(-50%,-50%) translate(${dx}px,${dy}px) rotate(${rotation}deg) scale(1)`, opacity: 1, offset: 0.9 },
          { transform: `translate(-50%,-50%) translate(${dx}px,${dy}px) rotate(${rotation}deg) scale(0.4)`, opacity: 0 }
        ],
        { duration: 620, easing: 'cubic-bezier(.2,.7,.3,1)' }
      ).onfinish = () => card.remove();
    }, idx * step);
  });
  const total = order.length * step + 720;
  setTimeout(() => {
    deck.remove();
    $('#cards').classList.remove('dealing');
    document.querySelectorAll('.opponent-cards').forEach((el) => el.classList.remove('dealing'));
    dealAnimActive = false;
  }, total);
}

let lastPlayersKey = '';
function renderPlayers() {
  const playerCount = room.players.length;
  // 变化检测:玩家关键状态无变化时跳过全量 DOM 重建(机器人连招/等待阶段大幅减负,降低发热)
  const playersKey = [
    room.status, room.round, room.pot, room.currentBet, room.dealer,
    room.players.map((p) => `${p.id}:${p.name}:${p.chips}:${p.seen}:${p.folded}:${p.ready}:${p.bot ? 1 : 0}`).join('|'),
    room.players[room.turn]?.id || ''
  ].join('#');
  if (playersKey === lastPlayersKey) return;
  lastPlayersKey = playersKey;
  const newDeal = room.status === 'playing' && room.round > lastAnimatedRound;
  if (room.round !== visualStateRound) {
    visualStateRound = room.round;
    previousPlayerVisualStates = new Map();
  }
  const stateEffects = [];
  const myIndex = room.players.findIndex((player) => player.id === viewerId());
  const layout = seatLayouts[playerCount] || seatLayouts[10];
  // 4 人局自定义坐标:均匀围在筹码池四周(底/左/顶/右),不再挤在圆桌上半部
  const seat4Positions = [[50, 80], [12, 50], [50, 15], [88, 50]];
  $('#players').innerHTML = room.players.map((player, index) => {
    const relativeIndex = (index - myIndex + playerCount) % playerCount;
    const seatIndex = layout[relativeIndex] ?? 5;
    let x, y;
    if (playerCount === 4) {
      // 4 人局自定义坐标:均匀围在筹码池四周,不再挤在圆桌上半部
      [x, y] = seat4Positions[relativeIndex];
    } else {
      [x, y] = seatPositions[seatIndex];
    }
    // 投注圈:座位向桌面中心偏移约24%(真实牌桌的投注圈位置)
    const dxc = x - 50;
    const dyc = y - 50;
    const lenC = Math.hypot(dxc, dyc) || 1;
    const ringX = x - (dxc / lenC) * 24;
    const ringY = y - (dyc / lenC) * 24;
    const isTurn = room.turn === index && room.status === 'playing';
    const state = player.connected === false ? (player.autoPlay ? '离线 · 托管' : '离线') : room.status === 'playing' && player.autoPlay ? (player.folded ? '托管 · 已弃牌' : '托管中') : room.status === 'playing' && player.folded ? (player.eliminatedByCompare ? '比牌淘汰' : '已弃牌') : room.status === 'waiting' ? (player.ready ? '已准备' : player.chips < room.baseBet ? '需筹码' : '未准备') : player.seen ? '已看牌' : '';
    const visualState = room.status === 'playing' && player.folded ? 'folded' : room.status === 'playing' && player.seen ? 'seen' : '';
    const previousVisualState = previousPlayerVisualStates.get(player.id);
    if (previousVisualState !== undefined && previousVisualState !== visualState && (visualState === 'seen' || visualState === 'folded')) stateEffects.push({ id: player.id, type: visualState });
    previousPlayerVisualStates.set(player.id, visualState);
    const stateClass = state.includes('离线') ? 'state-offline' : state.includes('看牌') ? 'state-seen' : state.includes('弃牌') || state.includes('淘汰') ? 'state-folded' : state.includes('托管') ? 'state-trustee' : state === '已准备' ? 'state-ready' : '';
    const isMe = player.id === viewerId();
    const showOpponentCards = room.status === 'playing' && !isMe && !player.folded;
    const opponentHtml = `<div class="opponent-cards ${newDeal ? 'deal' : ''}" aria-label="三张未公开的牌"><i></i><i></i><i></i></div>`;
    // 所有对手的牌都放在头像正前方(朝筹码池一侧),紧贴头像,竖立
    const classes = [isTurn ? 'turn' : '', player.connected === false ? 'offline' : '', player.folded && room.status === 'playing' ? 'folded' : '', player.autoPlay ? 'trustee' : '', seatIndex === 0 ? 'top-seat' : '', `seat-${seatIndex}`, isMe ? 'me' : ''].join(' ');
    return `<div class="bet-ring" data-player-id="${esc(player.id)}" style="--rx:${ringX.toFixed(1)}%;--ry:${ringY.toFixed(1)}%"></div><div class="player-seat ${classes}" style="--x:${x};--y:${y}" data-player-id="${esc(player.id)}">
      ${isTurn ? '<span class="seat-spotlight" aria-hidden="true"></span>' : ''}
      ${state ? `<span class="seat-state ${stateClass}" aria-live="polite">${state}</span>` : ''}
      ${player.bot ? '<span class="bot-tag">🤖</span>' : ''}
      ${player.bot && room.ownerId === viewerId() && room.status === 'waiting' ? `<button class="remove-bot" data-remove-bot="${esc(player.id)}" title="移除机器人" aria-label="移除机器人">×</button>` : ''}
      <div class="avatar" style="--av-h:${avatarHue(player.id)}">${esc(player.name.slice(0, 1))}${isTurn ? '<span class="turn-time" id="turnCountdown"></span><span class="thinking" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}${index === room.dealer ? '<span class="seat-badge">庄</span>' : ''}${showOpponentCards ? opponentHtml : ''}</div>
      <div class="seat-name">${player.bot ? '🤖 ' : ''}${esc(player.name)}</div><b class="seat-chips">${player.chips}</b>
    </div>`;
  }).join('');
  stateEffects.forEach(({ id, type }) => {
    const seat = [...document.querySelectorAll('#players [data-player-id]')].find((element) => element.dataset.playerId === id);
    const label = seat?.querySelector('.seat-state');
    if (!label) return;
    const keyframes = type === 'seen'
      ? [
          { opacity: 0, transform: 'translateX(-50%) translateY(8px) scale(.45)', filter: 'brightness(2.8)' },
          { opacity: 1, transform: 'translateX(-50%) translateY(-5px) scale(1.32)', filter: 'brightness(1.45)', offset: .48 },
          { opacity: 1, transform: 'translateX(-50%) translateY(0) scale(1)', filter: 'brightness(1)' }
        ]
      : [
          { opacity: 0, transform: 'translateX(-50%) translateY(-12px) scale(2) rotate(-9deg)' },
          { opacity: 1, transform: 'translateX(-50%) translateY(2px) scale(.9) rotate(2deg)', offset: .58 },
          { opacity: 1, transform: 'translateX(-50%) translateY(0) scale(1) rotate(0)' }
        ];
    label.animate(keyframes, { duration: type === 'seen' ? 760 : 620, easing: 'cubic-bezier(.2,.85,.2,1)' });
  });
  updateCountdown();
}

function renderHand(mine) {
  const newDeal = room.status === 'playing' && room.round > lastAnimatedRound;
  if (newDeal) { lastAnimatedRound = room.round; playSound('deal'); dealCardsAnimation(); }
  if (room.round !== lastSeenRound) {
    lastSeenRound = room.round;
    lastSeenState = false;
    handSpokenThisRound = false;
  }
  const revealNow = room.status === 'playing' && Boolean(mine?.seen) && !lastSeenState;
  if (mine?.seen) lastSeenState = true;
  // 看牌牌型播报:独立判定(本局内看过牌且从未播报过就播一次),不依赖 revealNow 的动画状态
  if (mine?.seen && mine.hand?.length === 3 && !handSpokenThisRound) {
    handSpokenThisRound = true;
    speak(`${evaluateHandTypeName(mine.hand)}!`);
  }
  const cards = mine?.hand || [];
  $('#cards').classList.toggle('revealed', Boolean(mine?.seen));
  if (revealNow) {
    // 真人感:牌背先"搓一下",再翻面;动画窗口内不重建,防被其他广播打断
    lastRevealAt = Date.now();
    $('#cards').innerHTML = cards.map((card, index) => cardHtml(null, 'peek', `--i:${index}`)).join('');
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      if (room?.status === 'playing') {
        const meNow = room.players.find((player) => player.id === viewerId());
        if (meNow?.seen) $('#cards').innerHTML = cards.map((card, index) => cardHtml(card, 'flip', `--i:${index}`)).join('');
      }
    }, 760);
  } else if (Date.now() - lastRevealAt < 1700) {
    // 瞄牌/翻面动画进行中:只更新文字,不重建牌面
  } else {
    $('#cards').innerHTML = cards.map((card, index) => card
      ? cardHtml(card, '', `--i:${index}`)
      : cardHtml(null, newDeal ? 'deal' : '', `--i:${index}`)).join('');
  }
  if (room.status !== 'playing') $('#handState').textContent = mine?.ready ? '已准备，等待房主开局' : '准备后等待开局';
  else if (mine?.folded) $('#handState').textContent = mine.eliminatedByCompare ? '本局已比牌淘汰' : '本局已弃牌';
  else $('#handState').textContent = mine?.seen ? `明牌 · 跟注 ${room.currentBet * 2}` : `闷牌 · 跟注 ${room.currentBet}`;
  $('#myStats').innerHTML = mine ? `<i class="mini-chip" aria-hidden="true"></i> ${mine.chips} · 本局已下 ${mine.bet}` : '';
}

function renderActions(mine, turnPlayer) {
  $('#actions').classList.remove('raise-picker');
  const waiting = room.status === 'waiting';
  $('#waitingBar').classList.toggle('hidden', !waiting);
  if (waiting) {
    const readyLabel = mine?.ready ? '取消准备' : '准备';
    const available = room.players.filter((player) => player.connected && player.ready && player.chips >= room.baseBet);
    const blockers = room.players.filter((player) => player.connected && (!player.ready || player.chips < room.baseBet)).map((player) => {
      const needs = [player.chips < room.baseBet ? '筹码' : '', !player.ready ? '准备' : ''].filter(Boolean);
      return `${player.name}：${needs.join('、')}`;
    });
    const onlineCount = room.players.filter((player) => player.connected).length;
    const summary = available.length >= 2 ? `${available.length}人已准备，可以开局` : `${onlineCount}人在线 · ${available.length}人已准备`;
    const readyDetail = blockers.length ? `<div class="ready-detail">还需 ${blockers.map(esc).join('；')}</div>` : '';
    const ownPending = (room.chipRequests || []).find((request) => request.playerId === viewerId() && request.status === 'pending');
    const quickChips = mine.chips < room.baseBet ? ownPending
      ? `<div class="quick-notice">已申请 ${ownPending.amount} 筹码，等待房主批准</div>`
      : `<div class="quick-chips"><b>先申请筹码：</b>${CHIP_AMOUNTS.map((amount) => `<button data-quick-chip="${amount}">+${amount}</button>`).join('')}</div>` : '';
    const quickReviews = room.ownerId === viewerId() ? (room.chipRequests || []).filter((request) => request.status === 'pending').map((request) => `<div class="quick-review"><span>${esc(request.playerName)}申请${request.amount}</span><button data-quick-review="${request.id}" data-ok="1">同意</button><button data-quick-review="${request.id}" data-ok="0">拒绝</button></div>`).join('') : '';
    const pendingCount = (room.chipRequests || []).filter((request) => request.status === 'pending').length;
    const approveAllBtn = room.ownerId === viewerId() && pendingCount > 0 ? `<div class="quick-review" style="justify-content:center"><button id="approveAllBtn" class="primary">一键同意全部(${pendingCount})</button></div>` : '';
    $('#waitingBar').innerHTML = `<div class="ready-summary">${esc(summary)}</div>${readyDetail}${quickChips}${quickReviews}${approveAllBtn}<div class="ready-buttons"><button id="readyButton" class="${mine?.ready ? '' : 'primary'}" ${mine.chips < room.baseBet ? 'disabled' : ''}>${mine.chips < room.baseBet ? '筹码到账' : readyLabel}</button>${room.ownerId === viewerId() ? `<button id="addBotBtn">🤖 机器人</button><button id="startButton" class="primary" ${available.length < 2 ? 'disabled' : ''}>${available.length < 2 ? '等待玩家就绪' : '开始游戏'}</button>` : '<span>等待房主开始</span>'}</div>`;
    $('#readyButton').onclick = () => emit('set-ready', { code: room.code, ready: !mine.ready });
    if ($('#addBotBtn')) $('#addBotBtn').onclick = () => emit('add-bot', { code: room.code }, (res) => { if (res?.name) toast(`🤖 ${res.name} 加入房间`); });
    if ($('#startButton')) $('#startButton').onclick = () => emit('start-game', { code: room.code });
    $('#waitingBar').querySelectorAll('[data-quick-chip]').forEach((button) => button.onclick = () => { awaitingChipCredit = true; emit('request-chips', { code: room.code, amount: Number(button.dataset.quickChip) }, () => toast('申请已提交，等待房主批准')); });
    $('#waitingBar').querySelectorAll('[data-quick-review]').forEach((button) => button.onclick = () => emit('review-chips', { code: room.code, requestId: button.dataset.quickReview, approved: button.dataset.ok === '1' }, () => toast(button.dataset.ok === '1' ? '筹码已批准' : '申请已拒绝')));
    $('#approveAllBtn')?.addEventListener('click', () => {
      const pendings = (room.chipRequests || []).filter((request) => request.status === 'pending');
      pendings.forEach((request) => socket.emit('review-chips', { code: room.code, requestId: request.id, approved: true }));
      toast(`已批准 ${pendings.length} 个筹码申请`);
    });
    $('#actions').innerHTML = '';
    return;
  }

  const pendingCompare = room.pendingCompare;
  if (pendingCompare) {
    const seconds = Math.max(0, Math.ceil((pendingCompare.expiresAt - Date.now()) / 1000));
    if (pendingCompare.targetId === viewerId()) {
      $('#actions').innerHTML = `<div class="compare-consent"><div><b>${esc(pendingCompare.challengerName)} 向你发起比牌</b><small>对方支付 ${pendingCompare.cost}，仅你们双方看到牌面 · <span id="compareRequestSeconds">${seconds}</span>秒</small></div><button data-compare-review="0" class="danger">拒绝</button><button data-compare-review="1" class="primary">同意比牌</button></div>`;
      $('#actions').querySelectorAll('[data-compare-review]').forEach((button) => button.onclick = () => emit('review-compare', {
        code: room.code,
        requestId: pendingCompare.id,
        approved: button.dataset.compareReview === '1'
      }));
    } else if (pendingCompare.challengerId === viewerId()) {
      $('#actions').innerHTML = `<div class="waiting-action">等待 ${esc(pendingCompare.targetName)} 确认比牌 · <span id="compareRequestSeconds">${seconds}</span>秒</div>`;
    } else {
      $('#actions').innerHTML = `<div class="waiting-action">两名玩家正在确认比牌 · <span id="compareRequestSeconds">${seconds}</span>秒</div>`;
    }
    return;
  }

  const mineTurn = turnPlayer?.id === viewerId() && !mine?.folded;
  if (mineTurn && lastSpokenTurnKey !== `${room.round}:${room.turn}`) {
    lastSpokenTurnKey = `${room.round}:${room.turn}`;
    speak('轮到你了');
  }
  if (mine?.autoPlay) {
    $('#actions').innerHTML = '<div class="waiting-action">托管中，点击下方“取消托管”可恢复操作</div>';
    return;
  }
  if (!mineTurn) {
    $('#actions').innerHTML = `<div class="waiting-action">${mine?.folded ? '等待本局结束' : `等待 ${esc(turnPlayer?.name || '其他玩家')} 操作`}</div>`;
    return;
  }
  const factor = mine.seen ? 2 : 1;
  const callCost = room.currentBet * factor;
  const canAfford = mine.chips >= callCost;
  const activePlayers = room.players.filter((player) => !player.folded);
  // 新规则:所有人看牌后才能比牌(服务端已算好,这里直接用)
  const compareReady = Boolean(room.canCompare);
  const compareTargets = activePlayers.filter((player) => player.id !== mine.id && (room.compareTargetIds || []).includes(player.id));
  const compareCosts = compareTargets.map((target) => Number(room.compareCosts?.[target.id]) || localCompareCost(mine, target));
  const affordableCompare = compareCosts.some((cost) => mine.chips >= cost);
  const compareCostLabel = compareCosts.length && compareCosts.every((cost) => cost === compareCosts[0]) ? compareCosts[0] : '选择费用';
  const nextLevel = room.currentBet + 1;
  if (raiseOpen) {
    // 加注选择:在当前档位上累加1~6注或10注
    const steps = [1, 2, 3, 4, 5, 6, 10];
    const options = steps
      .map((n) => ({ n, stake: room.currentBet + n, cost: (room.currentBet + n) * factor }))
      .filter((option) => mine.chips >= option.cost);
    $('#actions').classList.add('raise-picker');
    $('#actions').innerHTML = `<button data-raise-back>返回</button>${options.map((option) => `<button data-raise-level="${option.stake}" class="main-action">加${option.n}注<small>档位${option.stake}·付${option.cost}</small></button>`).join('')}`;
    $('#actions').querySelector('[data-raise-back]').onclick = () => { raiseOpen = false; renderActions(mine, turnPlayer); };
    $('#actions').querySelectorAll('[data-raise-level]').forEach((button) => button.onclick = () => {
      const level = Number(button.dataset.raiseLevel);
      emit('action', { code: room.code, action: 'raise', raiseTo: level }, () => { raiseOpen = false; toast(`已加注到 ${level}`); });
    });
    return;
  }
  $('#actions').innerHTML = `
    <button data-action="fold" class="danger">✕ 弃牌</button>
    <button data-action="see" ${mine.seen ? 'disabled' : ''}>◎ 看牌</button>
    <button data-action="call" class="main-action" ${canAfford ? '' : 'disabled'}>✓ 跟注 ${callCost}</button>
    ${canAfford
      ? `<button data-action="raise" ${!nextLevel || mine.chips < nextLevel * factor ? 'disabled' : ''}>▲ 加注</button>`
      : `<button type="button" data-chip-request class="chip-request">⊕ 申请筹码<small>批准后立即到账</small></button>`}
    <button type="button" data-action="compare" class="compare-action" ${!compareReady || !affordableCompare ? 'disabled' : ''}>⚔ 比牌</button>`;
  $('#actions').querySelectorAll('[data-action]').forEach((button) => button.onclick = () => handleAction(button.dataset.action));
  $('#actions').querySelectorAll('[data-chip-request]').forEach((button) => button.onclick = () => {
    const ownPending = (room.chipRequests || []).find((request) => request.playerId === viewerId() && request.status === 'pending');
    if (ownPending) return toast('已有申请待审批,请稍候');
    awaitingChipCredit = true;
    emit('request-chips', { code: room.code, amount: 500 }, () => toast(room.ownerId === viewerId() ? '筹码已到账 ✅' : '申请已提交,等待房主批准'));
  });
}

function handleAction(action) {
  if (action === 'fold') return confirmAction('确认弃牌', '弃牌后本局不能再操作，也不会公开你的牌。', () => emit('action', { code: room.code, action: 'fold' }));
  if (action === 'raise') {
    raiseOpen = true;
    const mine = room.players.find((player) => player.id === viewerId());
    return renderActions(mine, room.players[room.turn]);
  }
  if (action === 'compare') return showCompareTargets();
  emit('action', { code: room.code, action });
}

function renderTrustee(mine) {
  const button = $('#trusteeButton');
  const active = Boolean(mine?.autoPlay);
  button.textContent = active ? '取消托管' : '托管';
  button.classList.toggle('active', active);
  button.disabled = room.status !== 'playing' || Boolean(room.pendingCompare) || (!active && mine?.folded);
}

$('#trusteeButton').onclick = () => {
  const mine = room?.players.find((player) => player.id === viewerId());
  if (!mine || room.status !== 'playing') return toast('开局后才能使用托管');
  emit('set-trustee', { code: room.code, enabled: !mine.autoPlay }, () => toast(mine.autoPlay ? '已取消托管' : '已进入托管'));
};

function showCompareTargets() {
  const mine = room.players.find((player) => player.id === viewerId());
  const allowedTargets = new Set(room.compareTargetIds || []);
  const activeOpponents = room.players.filter((player) => !player.folded && player.id !== viewerId());
  const choices = room.players.filter((player) => allowedTargets.has(player.id));
  if (!choices.length && activeOpponents.length === 1) choices.push(activeOpponents[0]);
  const costFor = (target) => Number(room.compareCosts?.[target.id]) || localCompareCost(mine, target);
  if (choices.length === 1) {
    const target = choices[0];
    const cost = costFor(target);
    const needsApproval = room.players.filter((player) => !player.folded).length > 2 && mine.seen && target.seen;
    return confirmAction('确认比牌', `确定支付 ${cost} 与“${target.name}”比牌吗？${needsApproval ? '发起后需对方在10秒内同意。' : ''}牌面仅比牌双方可见。`, () => emit('action', { code: room.code, action: 'compare', targetId: target.id }));
  }
  showSheet(`<h3>选择比牌对手</h3><p class="meta">只有比牌双方能看到牌面，其他玩家只能看到胜负结果。</p>${choices.map((player) => { const cost = costFor(player); return `<button class="player-choice" data-target="${esc(player.id)}" ${mine.chips < cost ? 'disabled' : ''}><span class="avatar-small">${esc(player.name[0])}</span>${esc(player.name)} · 支付${cost}</button>`; }).join('')}`);
  $('#sheetContent').querySelectorAll('[data-target]').forEach((button) => button.onclick = () => {
    const target = room.players.find((player) => player.id === button.dataset.target);
    const cost = costFor(target);
    const needsApproval = room.players.filter((player) => !player.folded).length > 2 && mine.seen && target?.seen;
    closeSheet();
    confirmAction('确认比牌', `确定支付 ${cost} 与“${target?.name || '该玩家'}”比牌吗？${needsApproval ? '发起后需对方在10秒内同意。' : ''}牌面仅比牌双方可见。`, () => emit('action', { code: room.code, action: 'compare', targetId: button.dataset.target }));
  });
}

function renderCompare() {
  const reveal = room.reveal;
  const visible = reveal && reveal.id !== dismissedRevealId;
  const compareDelay = room.lastAction?.type === 'compare' ? 1_050 - (Date.now() - room.lastAction.at) : 0;
  if (visible && compareDelay > 0) {
    $('#compareOverlay').classList.add('hidden');
    clearTimeout(compareRevealTimer);
    compareRevealTimer = setTimeout(() => { compareRevealTimer = null; if (room?.reveal?.id === reveal.id) renderCompare(); }, compareDelay);
    return;
  }
  $('#compareOverlay').classList.toggle('hidden', !visible);
  if (!visible) return;
  duelFlash();
  if (room.winner) sweepChipsToWinner(room.winner.id);
  // 真人感:赢家气泡喊牌型(如"金花!""豹子!")
  const winnerType = reveal.winnerId === reveal.challengerId ? reveal.challengerType : reveal.targetType;
  if (winnerType && winnerType !== '牌面保密') {
    setTimeout(() => showSeatBubble(reveal.winnerId, `${winnerType}!`), 520);
  }
  if (reveal.id !== lastSpokenRevealId) {
    lastSpokenRevealId = reveal.id;
    if (reveal.winnerId === viewerId()) speak('你赢了比牌');
    else if (reveal.challengerId === viewerId() || reveal.targetId === viewerId()) speak('比牌失败');
  }
  const side = (name, cards, type, id) => `<div class="compare-side ${id === reveal.winnerId ? 'winner' : 'loser'}"><b>${esc(name)}</b><div class="mini-cards">${cards.map((card) => cardHtml(card)).join('')}</div><strong>${esc(type || '牌面保密')}</strong></div>`;
  const challengerSide = side(reveal.challengerName, reveal.challengerHand, reveal.challengerType, reveal.challengerId);
  const targetSide = side(reveal.targetName, reveal.targetHand, reveal.targetType, reveal.targetId);
  // 赢家排在上面,输家排在下面
  $('#compareHands').innerHTML = reveal.winnerId === reveal.challengerId ? challengerSide + targetSide : targetSide + challengerSide;
  $('#compareResult').textContent = `${reveal.winnerName} 获胜 · ${reveal.loserName} 淘汰`;
  $('#compareContinue').classList.toggle('hidden', room.status !== 'waiting');
}

$('#compareContinue').onclick = () => {
  dismissedRevealId = room.reveal?.id || null;
  if (room.winner) lastWinnerId = room.winner.id;
  $('#compareOverlay').classList.add('hidden');
  $('#resultOverlay').classList.add('hidden');
  toast('请准备下一局');
};

function renderWinner() {
  if (!room.winner) { $('#resultOverlay').classList.add('hidden'); return; }
  if (room.reveal || room.winner.id === lastWinnerId) return;  const foldDelay = room.lastAction?.type === 'fold' ? 1_050 - (Date.now() - room.lastAction.at) : 0;
  if (foldDelay > 0) {
    $('#resultOverlay').classList.add('hidden');
    clearTimeout(winnerRevealTimer);
    winnerRevealTimer = setTimeout(() => { winnerRevealTimer = null; if (room?.winner) renderWinner(); }, foldDelay);
    return;
  }
  lastWinnerId = room.winner.id;
  playSound('win');
  if (room.winner.id === viewerId()) speak(`你赢了本局,赢得 ${room.winner.pot} 筹码`);
  $('#resultTitle').textContent = `${room.winner.winnerName} 赢得本局`;
  $('#resultText').textContent = `获得筹码池 ${room.winner.pot}`;
  $('#resultRows').innerHTML = room.winner.players.map((player) => `<div class="result-row"><span>${esc(player.name)} · 本局下注 ${player.bet}</span><b>${player.chips}</b></div>`).join('');
  if (room.winner.id === viewerId()) sprinkleCoins();
  sweepChipsToWinner(room.winner.id);
  $('#resultOverlay').classList.remove('hidden');
}

// 真人感:赢家把池中筹码"搂"向自己座位
function sweepChipsToWinner(winnerId) {
  try {
    const potChips = $('#potChips');
    const felt = document.querySelector('.felt');
    const seat = winnerId && [...document.querySelectorAll('#players [data-player-id]')].find((el) => el.dataset.playerId === winnerId);
    if (!potChips || !potChips.children.length || !felt || !seat) return;
    const feltRect = felt.getBoundingClientRect();
    const seatRect = seat.getBoundingClientRect();
    const tx = seatRect.left + seatRect.width / 2 - (feltRect.left + feltRect.width / 2);
    const ty = seatRect.top + seatRect.height / 2 - (feltRect.top + feltRect.height / 2);
    [...potChips.children].forEach((chip, i) => {
      chip.animate(
        [
          { transform: 'translate(0,0) scale(1)', opacity: 1 },
          { transform: `translate(${tx}px,${ty}px) scale(.35)`, opacity: 0 }
        ],
        { duration: 720, delay: i * 45, easing: 'cubic-bezier(.2,.7,.3,1)' }
      ).onfinish = () => chip.remove();
    });
  } catch { /* 忽略 */ }
}

// 胜利结算撒金币:轻量粒子,约1.6秒,不重复
function sprinkleCoins() {
  const panel = $('#resultOverlay .result-panel');
  if (!panel) return;
  panel.querySelectorAll('.result-confetti').forEach((el) => el.remove());
  const confetti = document.createElement('div');
  confetti.className = 'result-confetti';
  confetti.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 14; i += 1) {
    const coin = document.createElement('i');
    coin.className = 'coin';
    coin.style.left = `${4 + Math.random() * 88}%`;
    coin.style.setProperty('--cy', `${120 + Math.random() * 240}px`);
    coin.style.setProperty('--delay', `${(Math.random() * 0.8).toFixed(2)}s`);
    coin.style.setProperty('--dur', `${(1.5 + Math.random() * 1.1).toFixed(2)}s`);
    confetti.appendChild(coin);
  }
  panel.appendChild(confetti);
}

function renderBadge() {
  const pendingCount = (room.chipRequests || []).filter((request) => request.status === 'pending' && room.ownerId === viewerId()).length
    + (room.borrowRequests || []).filter((request) => request.status === 'pending_lender' && request.lenderId === viewerId() || request.status === 'pending_owner' && room.ownerId === viewerId()).length;
  $('#requestBadge').textContent = pendingCount;
  $('#requestBadge').classList.toggle('hidden', pendingCount === 0);
}

$('#chipsButton').onclick = () => {
  if (!room) return;
  const mine = room.players.find((player) => player.id === viewerId());
  let html = '<h3>筹码与审批</h3>';
  const ownPending = (room.chipRequests || []).find((request) => request.playerId === viewerId() && request.status === 'pending');
  if (room.status !== 'waiting') {
    html += `<div class="sheet-section"><b>紧急补筹码</b><p class="meta">${ownPending ? `已申请 ${ownPending.amount}，等待房主批准` : '牌局中申请，批准后立即到账'}</p><div class="choice-grid">${CHIP_AMOUNTS.map((amount) => `<button data-chip="${amount}" ${ownPending ? 'disabled' : ''}>+${amount}</button>`).join('')}</div></div>`;
  } else {
    html += `<div class="sheet-section"><b>申请虚拟筹码</b><p class="meta">${ownPending ? `已申请 ${ownPending.amount}，等待房主审批` : '选择金额后由房主审批'}</p><div class="choice-grid">${CHIP_AMOUNTS.map((amount) => `<button data-chip="${amount}" ${ownPending ? 'disabled' : ''}>+${amount}</button>`).join('')}</div></div>`;
    const lenders = room.players.filter((player) => player.id !== viewerId() && player.chips >= 100 && player.connected);
    if (lenders.length) html += `<div class="sheet-section"><button id="borrowButton" class="wide">向其他玩家借筹码</button></div>`;
  }
  const chipReviews = (room.chipRequests || []).filter((request) => request.status === 'pending' && room.ownerId === viewerId());
  const borrowReviews = (room.borrowRequests || []).filter((request) => request.status === 'pending_lender' && request.lenderId === viewerId() || request.status === 'pending_owner' && room.ownerId === viewerId());
  [...chipReviews, ...borrowReviews].forEach((request) => {
    const isChip = request.id.startsWith('chip_');
    const stage = isChip ? '筹码申请' : request.status === 'pending_lender' ? '等待出借确认' : '等待房主批准';
    html += `<div class="sheet-section sheet-row"><span><b>${esc(request.playerName || request.borrowerName)}</b><br><span class="meta">${stage} · ${request.amount}</span></span><span><button data-review="${request.id}" data-kind="${isChip ? 'chip' : 'borrow'}" data-ok="1">同意</button><button data-review="${request.id}" data-kind="${isChip ? 'chip' : 'borrow'}" data-ok="0">拒绝</button></span></div>`;
  });
  const debts = (room.debts || []).filter((debt) => debt.borrowerId === viewerId() && debt.outstanding > 0);
  debts.forEach((debt) => { html += `<div class="sheet-section"><b>欠 ${esc(debt.lenderName)} ${debt.outstanding}</b><button class="wide" data-repay="${debt.id}">归还筹码</button></div>`; });
  html += `<div class="sheet-section"><span class="meta">累计获批 ${mine?.totalApproved || 0} · 未还借入 ${mine?.borrowedIn || 0} · 未收回借出 ${mine?.lentOut || 0}</span></div>`;
  showSheet(html);
  $('#sheetContent').querySelectorAll('[data-chip]').forEach((button) => button.onclick = () => emit('request-chips', { code: room.code, amount: Number(button.dataset.chip) }, () => { closeSheet(); toast('申请已提交，等待房主批准'); }));
  $('#sheetContent').querySelectorAll('[data-review]').forEach((button) => button.onclick = () => { const event = button.dataset.kind === 'chip' ? 'review-chips' : 'review-borrow'; emit(event, { code: room.code, requestId: button.dataset.review, approved: button.dataset.ok === '1' }, () => { closeSheet(); toast(button.dataset.ok === '1' ? '已同意' : '已拒绝'); }); });
  $('#borrowButton')?.addEventListener('click', () => showBorrowLenders());
  $('#sheetContent').querySelectorAll('[data-repay]').forEach((button) => button.onclick = () => showRepayChoices(button.dataset.repay));
};

function showBorrowLenders() {
  const lenders = room.players.filter((player) => player.id !== viewerId() && player.chips >= 100 && player.connected);
  showSheet(`<h3>选择出借玩家</h3>${lenders.map((player) => `<button class="player-choice" data-lender="${esc(player.id)}">${esc(player.name)} · 可用 ${player.chips}</button>`).join('')}`);
  $('#sheetContent').querySelectorAll('[data-lender]').forEach((button) => button.onclick = () => showBorrowAmounts(button.dataset.lender));
}

function showBorrowAmounts(lenderId) {
  const lender = room.players.find((player) => player.id === lenderId);
  showSheet(`<h3>向 ${esc(lender.name)} 借筹码</h3><p class="meta">出借人同意后，还需要房主最终批准。</p><div class="choice-grid">${CHIP_AMOUNTS.map((amount) => `<button data-borrow="${amount}" ${lender.chips < amount ? 'disabled' : ''}>${amount}</button>`).join('')}</div>`);
  $('#sheetContent').querySelectorAll('[data-borrow]').forEach((button) => button.onclick = () => { const amount = Number(button.dataset.borrow); button.disabled = true; button.textContent = '提交中'; emit('request-borrow', { code: room.code, lenderId, amount }, () => { closeSheet(); toast('借筹码申请已提交'); }); });
}

function showRepayChoices(debtId) {
  const debt = room.debts.find((item) => item.id === debtId);
  const mine = room.players.find((player) => player.id === viewerId());
  showSheet(`<h3>归还 ${esc(debt.lenderName)}</h3><div class="choice-grid">${CHIP_AMOUNTS.filter((amount) => amount <= debt.outstanding).map((amount) => `<button data-repay-amount="${amount}" ${mine.chips < amount ? 'disabled' : ''}>${amount}</button>`).join('')}</div>`);
  $('#sheetContent').querySelectorAll('[data-repay-amount]').forEach((button) => button.onclick = () => { const amount = Number(button.dataset.repayAmount); button.disabled = true; button.textContent = '提交中'; emit('repay-borrow', { code: room.code, debtId, amount }, () => { closeSheet(); toast(`已归还 ${amount} 筹码`); }); });
}

$('#logButton').onclick = () => emit('get-records', { code: room.code }, (response) => {
  recordCache = response.records;
  showLedger('all', recordCache);
});

function showLedger(selectedPlayer = 'all', records = recordCache || {}) {
  const ledger = records.ledger || [];
  const summaries = room.players.map((player) => {
    const entries = ledger.filter((entry) => entry.playerId === player.id);
    const income = entries.filter((entry) => entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0);
    const expense = entries.filter((entry) => entry.amount < 0).reduce((sum, entry) => sum - entry.amount, 0);
    return `<div class="ledger-summary"><b>${esc(player.name)}</b><span>收入 +${income}</span><span>支出 -${expense}</span><strong>余额 ${player.chips}</strong></div>`;
  }).join('');
  showSheet(`<h3>牌局记录</h3><div class="ledger-summaries">${summaries}</div>`);
}
$('#rulesButton').onclick = showRules;
$('#tableRulesButton').onclick = showRules;
function showRules() {
  showSheet(`<h3>房间规则</h3><ol class="rules-list"><li>每局底注1，第一局随机庄家，以后顺时针轮庄，庄家下家先操作。</li><li>闷牌按当前档位支付；看牌免费且不换人，看牌后下注为2倍。</li><li>加注为在当前档位基础上累加：加1~6注或加10注（例如当前档位5，加3注后为8）。</li><li>完成第一轮下注后可以比牌。多人局中，需要所有未弃牌玩家都看牌后才能主动比牌；剩两名玩家时，闷牌玩家可花当前档位开明牌（1倍），明牌玩家可花2倍看闷牌。比牌费只按发起者状态计算，不因对手状态再次翻倍。多人仍在局中时，被比牌者有10秒同意或拒绝；同意后才扣费并比牌，拒绝或超时不扣费，仍由发起者继续操作。</li><li>比牌牌面仅比牌双方可见，其他玩家只能看到胜负结果；牌小者淘汰，牌大者留在桌上继续游戏；普通弃牌不公开。</li><li>牌型：豹子＞顺金＞金花＞顺子＞对子＞散牌。A23为最小顺子，花色不分大小。</li><li>非同花的235只在遇到豹子时获胜；完全同牌时主动比牌者输。</li><li>每次操作限时30秒。超时后进入托管自动跟注；接电话/断网10分钟内回来正常，离线期间自动托管，超10分钟移出房间。</li><li>牌局中筹码不足时可以紧急申请筹码，房主批准后立即到账继续跟注；房主自己申请自动通过。</li></ol>`);
}

// 移除机器人(房主,等待阶段):事件委托,座位上的 × 按钮
document.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-remove-bot]');
  if (!button) return;
  emit('remove-bot', { code: room.code, botId: button.dataset.removeBot }, (res) => {
    if (res?.name) toast(`🤖 ${res.name} 已离开`);
  });
});

$('#leave').onclick = () => confirmAction('退出房间', room?.status === 'playing' ? '退出后将自动弃牌，并在本局结束后离开房间。' : '确定退出当前房间吗？', async () => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000); // 免费实例休眠唤醒可能较慢,20秒超时
    const response = await fetch('/api/leave-room', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: room.code }), signal: controller.signal });
    clearTimeout(timer);
    const data = await response.json();
    if (!response.ok) return toast(data.error || '退出失败，请重试');
  } catch {
    return toast('网络较慢，请稍后再试');
  }
  room = null;
  resetRoomVisualState();
  history.replaceState(null, '', '/');
  showScreen('#lobby');
});

$('#switchName').onclick = () => {
  showSheet(`<h3>切换名字</h3><p class="meta">修改后立即在当前房间生效，不会退出牌局或清除筹码。</p><div class="rename-form"><input id="renameInput" maxlength="12" autocomplete="nickname" value="${esc(me?.name || '')}" placeholder="输入新名字"><button id="renameSubmit" class="primary">保存名字</button></div>`);
  const input = $('#renameInput');
  input.select();
  const submit = async () => {
    const name = input.value.trim();
    if (!name) return toast('请输入新名字');
    $('#renameSubmit').disabled = true;
    try {
      const response = await fetch('/api/change-name', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '修改失败');
      me = data.user;
      $('#user').textContent = me.name;
      closeSheet();
      toast('名字已修改');
    } catch (error) {
      $('#renameSubmit').disabled = false;
      toast(error.message || '修改失败，请重试');
    }
  };
  $('#renameSubmit').onclick = submit;
  input.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } };
};

$('#invite').onclick = async () => {
  if (!room) return toast('请先进入房间');
  const link = `${location.origin}/?room=${room.code}`;
  const text = `我在“三张牌”房间 ${room.code} 等你：${link}`;
  try {
    if (navigator.share) await navigator.share({ title: '三张牌', text, url: link });
    else await navigator.clipboard.writeText(text);
    toast('链接已复制,朋友点开即可进房');
  } catch (error) {
    if (error.name !== 'AbortError') {
      showSheet(`<h3>邀请好友</h3><p>房间号：<b>${room.code}</b></p><input id="inviteLink" aria-label="邀请链接" value="${esc(link)}" readonly><p class="meta">长按上面的链接复制后发送给好友,好友点开即可直接进房。</p>`);
      $('#inviteLink').onclick = () => $('#inviteLink').select();
    }
  }
};

function showSheet(html) {
  $('#sheetContent').innerHTML = html;
  $('#sheetBackdrop').classList.remove('hidden');
  setTimeout(() => $('#sheet').querySelector('button, input, [tabindex]')?.focus(), 0);
}
function closeSheet() { $('#sheetBackdrop').classList.add('hidden'); }
$('#closeSheet').onclick = closeSheet;
$('#sheetBackdrop').onclick = (event) => { if (event.target === $('#sheetBackdrop')) closeSheet(); };

function confirmAction(title, text, onConfirm) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOverlay').classList.remove('hidden');
  // 防重复:点击确定后禁用并提示处理中,避免"点三次没反应"重复提交
  const ok = $('#confirmOk');
  ok.disabled = false;
  ok.textContent = '确定';
  ok.onclick = () => {
    if (ok.disabled) return;
    ok.disabled = true;
    ok.textContent = '处理中...';
    $('#confirmOverlay').classList.add('hidden');
    onConfirm();
  };
}
$('#confirmCancel').onclick = () => $('#confirmOverlay').classList.add('hidden');
$('#closeResult').onclick = () => $('#resultOverlay').classList.add('hidden');
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('#confirmOverlay').classList.contains('hidden')) $('#confirmOverlay').classList.add('hidden');
  else if (!$('#sheetBackdrop').classList.contains('hidden')) closeSheet();
  else if (!$('#resultOverlay').classList.contains('hidden')) $('#resultOverlay').classList.add('hidden');
});

function animateChip(amount) {
  const chip = $('#chipFlight');
  clearTimeout(chipFlightTimer);
  chip.classList.remove('hidden');
  chip.textContent = `+${amount}`;
  // 起点:下注者座位中心(找不到时回退到桌台左下角)
  let dx = -160;
  let dy = 150;
  let seat = null;
  try {
    const actorId = room?.lastAction?.playerId;
    seat = actorId && [...document.querySelectorAll('#players [data-player-id]')].find((el) => el.dataset.playerId === actorId);
    const felt = document.querySelector('.felt');
    if (seat && felt) {
      const seatRect = seat.getBoundingClientRect();
      const feltRect = felt.getBoundingClientRect();
      dx = seatRect.left + seatRect.width / 2 - (feltRect.left + feltRect.width / 2);
      dy = seatRect.top + seatRect.height / 2 - (feltRect.top + feltRect.height / 2);
    }
  } catch { /* 回退默认起点 */ }
  chip.getAnimations?.().forEach((animation) => animation.cancel());
  chip.animate(
    [{ transform: `translate(${dx}px,${dy}px) scale(.55)` }, { transform: 'translate(0,0) scale(1)' }],
    { duration: 480, easing: 'cubic-bezier(.25,.72,.3,1)' }
  );
  chipFlightTimer = setTimeout(() => chip.classList.add('hidden'), 600);

  // 真人感:一枚实体筹码从座位飞进池中,池边筹码堆+1
  try {
    const felt = document.querySelector('.felt');
    if (felt) {
      const feltRect = felt.getBoundingClientRect();
      const startX = seat ? seat.getBoundingClientRect().left + seat.getBoundingClientRect().width / 2 - feltRect.left : 0;
      const startY = seat ? seat.getBoundingClientRect().top + seat.getBoundingClientRect().height / 2 - feltRect.top : feltRect.height;
      // 投注圈位置:筹码先进圈,再收进池
      const actorId = room?.lastAction?.playerId;
      const ringEl = actorId ? document.querySelector(`#players .bet-ring[data-player-id="${actorId}"]`) : null;
      let ringX = 0;
      let ringY = 0;
      if (ringEl) {
        const ringRect = ringEl.getBoundingClientRect();
        ringX = ringRect.left + ringRect.width / 2 - feltRect.left - feltRect.width / 2;
        ringY = ringRect.top + ringRect.height / 2 - feltRect.top - feltRect.height / 2;
        ringEl.classList.add('hot');
        setTimeout(() => ringEl.classList.remove('hot'), 600);
      }
      const coin = document.createElement('i');
      coin.className = 'fly-chip';
      coin.style.left = `${feltRect.width / 2}px`;
      coin.style.top = `${feltRect.height / 2}px`;
      felt.appendChild(coin);
      coin.animate(
        [
          { transform: `translate(${startX - feltRect.width / 2}px,${startY - feltRect.height / 2}px) rotate(0deg) scale(.6)` },
          { transform: `translate(${ringX}px,${ringY}px) rotate(140deg) scale(.92)`, offset: 0.52 },
          { transform: 'translate(0,0) rotate(220deg) scale(1)', offset: 0.85 },
          { transform: 'translate(0,0) rotate(220deg) scale(0)' }
        ],
        { duration: 560, easing: 'cubic-bezier(.22,.68,.3,1)' }
      ).onfinish = () => coin.remove();
      // 池边筹码堆递增(最多16个,满则滚动)
      const potChips = $('#potChips');
      if (potChips) {
        const colors = ['#dc9d26', '#3d7ea8', '#c2444e', '#3d8a5f', '#8a5adc'];
        const mini = document.createElement('i');
        mini.style.background = `radial-gradient(circle at 35% 30%,${colors[Math.floor(Math.random() * colors.length)]},#00000088)`;
        potChips.appendChild(mini);
        while (potChips.children.length > 8) potChips.firstChild.remove();
      }
    }
  } catch { /* 忽略 */ }
}

function updateCountdown() {
  const compareLabel = $('#compareRequestSeconds');
  if (compareLabel && room?.pendingCompare?.expiresAt) compareLabel.textContent = Math.max(0, Math.ceil((room.pendingCompare.expiresAt - Date.now()) / 1000));
  const playing = room?.status === 'playing' && Boolean(room?.turnDeadline);
  // 非牌局:只负责隐藏环与时钟,不做任何重绘计算
  const ring = $('#turnRing');
  if (ring) {
    if (!playing) {
      ring.classList.add('hidden');
      const clock = $('#turnClock');
      if (clock) clock.classList.add('hidden');
      return;
    }
    const remaining = Math.max(0, room.turnDeadline - Date.now());
    const pct = Math.min(1, remaining / 30_000); // 剩余比例
    const bar = ring.querySelector('.turn-ring-bar');
    if (bar) {
      // 增长式:开始无环,随时间从起点画满一圈
      bar.style.strokeDashoffset = String(295.31 * pct);
      bar.style.stroke = pct <= 1 / 3 ? '#ff4048' : '#ff6b74';
    }
    const svg = ring.querySelector('svg');
    if (svg) {
      // 环的起点 = 轮到玩家头像相对桌心的角度(只在轮转变化时重算,避免每帧强制重排)
      const turnIndex = room.turn;
      if (turnIndex !== lastAngleTurn) {
        lastAngleTurn = turnIndex;
        const turnSeat = document.querySelector('#players .player-seat.turn');
        let angle = -90;
        if (turnSeat) {
          const seatRect = turnSeat.getBoundingClientRect();
          const stageRect = $('#tableStage').getBoundingClientRect();
          const sx = seatRect.left + seatRect.width / 2 - (stageRect.left + stageRect.width / 2);
          const sy = seatRect.top + seatRect.height / 2 - (stageRect.top + stageRect.height / 2);
          angle = Math.atan2(sy, sx) * 180 / Math.PI;
        }
        svg.style.transform = `rotate(${angle}deg)`;
      }
    }
    ring.classList.remove('hidden');
  }
  // 最后10秒:筹码池中央大号倒计时数字
  const clock = $('#turnClock');
  if (clock) {
    if (playing) {
      const seconds = Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000));
      if (seconds <= 10) {
        clock.textContent = String(seconds);
        clock.classList.remove('hidden');
        clock.classList.toggle('warn', seconds <= 5);
      } else {
        clock.classList.add('hidden');
      }
    } else {
      clock.classList.add('hidden');
    }
  }
  // 头像环:与桌边红环同步走(同一倒计时,红色conic)
  const avatarRing = $('#turnCountdown');
  if (avatarRing && room.turnDeadline) {
    const avatarRemaining = Math.max(0, room.turnDeadline - Date.now());
    avatarRing.style.setProperty('--progress', Math.min(100, Math.round(avatarRemaining / 30_000 * 100)));
  }
  // 托管警告:轮到自己且剩 5 秒时播报一次
  if (playing && room.turnDeadline) {
    const warnSeconds = Math.ceil(Math.max(0, room.turnDeadline - Date.now()) / 1000);
    if (warnSeconds === 5) {
      const mePlayer = room.players.find((player) => player.id === viewerId());
      const turnNow = room.players[room.turn];
      const warnKey = `${room.round}:${room.turn}`;
      if (mePlayer && turnNow && turnNow.id === mePlayer.id && !mePlayer.folded && lastWarnKey !== warnKey) {
        lastWarnKey = warnKey;
        speak('请尽快操作');
      }
    }
  }
}

// 真人感:操作气泡+口头禅——玩家操作时头像旁冒小气泡说话
const BUBBLE_LINES = {
  call: ['跟了跟了', '跟上', '没问题', '小意思', '跟'],
  raise: ['抬一手!', '加注!', '这把值!', '来劲了', '搞大点'],
  compare: ['开你牌!', '比一下!', '亮牌吧!', '谁怕谁', '碰一碰'],
  fold: ['这把我不要了', '弃了弃了', '牌不行', '溜了溜了', '看不了'],
  see: ['瞄一眼', '看看牌', '偷偷看一眼']
};
function showSeatBubble(playerId, text) {
  try {
    const seat = playerId && [...document.querySelectorAll('#players [data-player-id]')].find((el) => el.dataset.playerId === playerId);
    if (!seat) return;
    seat.querySelectorAll('.seat-bubble').forEach((el) => el.remove());
    const bubble = document.createElement('div');
    bubble.className = 'seat-bubble';
    bubble.textContent = text;
    seat.appendChild(bubble);
    setTimeout(() => bubble.remove(), 1900);
  } catch { /* 忽略 */ }
}

// 真人感:弃牌时3张牌甩向池中央消失
function foldCardsAway(playerId) {
  try {
    const felt = document.querySelector('.felt');
    const seat = playerId && [...document.querySelectorAll('#players [data-player-id]')].find((el) => el.dataset.playerId === playerId);
    if (!felt) return;
    const feltRect = felt.getBoundingClientRect();
    const cx = feltRect.width / 2;
    const cy = feltRect.height / 2;
    const sx = seat ? seat.getBoundingClientRect().left + seat.getBoundingClientRect().width / 2 - feltRect.left : 0;
    const sy = seat ? seat.getBoundingClientRect().top + seat.getBoundingClientRect().height / 2 - feltRect.top : feltRect.height;
    for (let i = 0; i < 3; i += 1) {
      setTimeout(() => {
        const card = document.createElement('i');
        card.className = 'fold-fly-card';
        card.style.left = `${sx}px`;
        card.style.top = `${sy}px`;
        felt.appendChild(card);
        const dx = cx - sx;
        const dy = cy - sy;
        card.animate(
          [
            { transform: 'translate(-50%,-50%) rotate(0deg) scale(1)', opacity: 1 },
            { transform: `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px)) rotate(${i === 0 ? -50 : i === 1 ? 20 : 70}deg) scale(.8)`, opacity: 0.85, offset: 0.75 },
            { transform: `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px)) rotate(${i === 0 ? -50 : i === 1 ? 20 : 70}deg) scale(0.2)`, opacity: 0 }
          ],
          { duration: 700, easing: 'cubic-bezier(.25,.7,.3,1)' }
        ).onfinish = () => card.remove();
      }, i * 110);
    }
  } catch { /* 忽略 */ }
}

// 真人感:比牌对决冲击波
function duelFlash() {
  try {
    const panel = $('#compareOverlay .compare-panel');
    if (!panel) return;
    panel.querySelectorAll('.duel-flash').forEach((el) => el.remove());
    const flash = document.createElement('div');
    flash.className = 'duel-flash';
    flash.setAttribute('aria-hidden', 'true');
    panel.appendChild(flash);
    setTimeout(() => flash.remove(), 1100);
  } catch { /* 忽略 */ }
}
// 倒计时刷新:1000ms 一次(配合 CSS transition 平滑),避免手机端每250ms重绘倒计时环导致发烫
let lastAngleTurn = -1;
let countdownTimer = null;
const startCountdownTimer = () => { if (!countdownTimer) countdownTimer = setInterval(updateCountdown, 1000); };
const stopCountdownTimer = () => { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } };
startCountdownTimer();
// 后台暂停:页面切到后台(切应用/锁屏)时停止所有定时器与轮询,避免持续耗电发热
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    document.documentElement.classList.remove('is-visible');
    stopCountdownTimer();
  } else {
    document.documentElement.classList.add('is-visible');
    startCountdownTimer();
    resumeAudioOnGesture(); // 切回前台立即恢复音频(iOS 后台会挂起 AudioContext)
  }
});
document.documentElement.classList.add('is-visible');

function warmCardDeck() {
  if (deckWarmingStarted) return;
  deckWarmingStarted = true;
  const files = [];
  for (const suit of Object.values(CARD_SUIT_NAMES)) for (let cardRank = 1; cardRank <= 13; cardRank += 1) files.push(`${cardRank}${suit}.svg`);
  let nextIndex = 0;
  const loadNext = () => {
    if (nextIndex >= files.length) return;
    const image = new Image();
    image.onload = image.onerror = loadNext;
    image.src = `${CARD_ASSET_ROOT}/${files[nextIndex++]}`;
  };
  const begin = () => { for (let index = 0; index < 4; index += 1) loadNext(); };
  if ('requestIdleCallback' in window) window.requestIdleCallback(begin, { timeout: 2_000 });
  else setTimeout(begin, 1_000);
}

function cardHtml(card, extraClass = '', inlineStyle = '') {
  const className = `card ${card ? '' : 'back'} ${extraClass}`.trim();
  const fileName = card ? cardAssetName(card) : 'classic-navy-back-v3.jpg';
  const label = card ? `${rank(card.rank)}${card.suit}` : '未看牌';
  const style = inlineStyle ? ` style="${esc(inlineStyle)}"` : '';
  return `<div class="${className}"${style}><img src="${CARD_ASSET_ROOT}/${fileName}" alt="${esc(label)}" draggable="false"></div>`;
}
function cardAssetName(card) {
  const suit = CARD_SUIT_NAMES[card.suit];
  const cardRank = card.rank === 14 ? 1 : card.rank;
  return `${cardRank}${suit}.svg`;
}
function rank(value) { return ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J' })[value] || value; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function toast(text) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text;
  $('#toast').classList.remove('hidden');
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 2_500);
}

init();

