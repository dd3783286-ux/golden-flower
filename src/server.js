import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import {
  act,
  addPlayer,
  BET_LEVELS,
  betCost,
  comparisonAvailability,
  disconnectPlayer,
  expireComparisonRequest,
  expireTurn,
  leavePlayer,
  makeRoom,
  MAX_PLAYERS,
  publicRoom,
  repayBorrow,
  requestBorrow,
  requestChips,
  reviewComparison,
  reviewBorrowRequest,
  reviewChipRequest,
  setReady,
  setTrustee,
  showdown,
  startGame
} from './game.js';
import { botPersonality, chooseBotAction } from './botBrain.js';

const app = express();
const server = createServer(app);
const io = new Server(server, { pingTimeout: 20_000, pingInterval: 10_000 });
const rooms = new Map();
const roomTimers = new Map();
const botTimers = new Map(); // roomCode -> setTimeout,服务端托管机器人行动调度
// 机器人陪玩名字池:每次添加一个,名字不重复
const BOT_NAMES = ['潘', '谢', '王'];
const botIdSequence = { value: 0 };
const botId = () => `bot_${Date.now().toString(36)}_${(botIdSequence.value += 1)}`;
const nextBotName = (room) => {
  const taken = new Set(room.players.map((player) => player.name));
  const name = BOT_NAMES.find((candidate) => !taken.has(candidate));
  if (name) return name;
  throw new Error('机器人陪玩已全部就位');
};
const isBotPlayer = (player) => Boolean(player && player.bot);
const port = Number(process.env.PORT || 3000);
const baseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
const dirname = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(dirname, '../data/rooms.json');
const roomsBackupFile = `${dataFile}.bak`;
const sessionFile = path.join(dirname, '../data/sessions.json');
const sessionSecretFile = path.join(dirname, '../data/session-secret.txt');
const cachedAssetExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.woff', '.woff2', '.mp3']);
let saveTimer = null;

class FileSessionStore extends session.Store {
  constructor(file) {
    super();
    this.file = file;
    this.sessions = new Map();
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const current = Date.now();
      for (const [id, value] of Object.entries(saved)) {
        if (!value.expiresAt || value.expiresAt > current) this.sessions.set(id, value);
      }
    } catch (error) {
      console.error('读取登录会话失败：', error.message);
    }
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.sessions)), 'utf8');
      fs.renameSync(temporary, this.file);
    } catch (error) {
      console.error('保存登录会话失败：', error.message);
    }
  }

  get(id, callback) {
    const value = this.sessions.get(id);
    if (!value || (value.expiresAt && value.expiresAt <= Date.now())) {
      if (value) { this.sessions.delete(id); this.persist(); }
      return callback(null, null);
    }
    callback(null, value.session);
  }

  set(id, value, callback = () => {}) {
    const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 30 * 864e5;
    this.sessions.set(id, { expiresAt, session: value });
    this.persist();
    callback(null);
  }

  destroy(id, callback = () => {}) {
    this.sessions.delete(id);
    this.persist();
    callback(null);
  }

  touch(id, value, callback = () => {}) { this.set(id, value, callback); }
}

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'test') return 'test-session-secret';
  fs.mkdirSync(path.dirname(sessionSecretFile), { recursive: true });
  if (fs.existsSync(sessionSecretFile)) return fs.readFileSync(sessionSecretFile, 'utf8').trim();
  const generated = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(sessionSecretFile, generated, { encoding: 'utf8', mode: 0o600 });
  return generated;
}

const sessionMiddleware = session({
  secret: sessionSecret(),
  store: process.env.NODE_ENV === 'test' ? undefined : new FileSessionStore(sessionFile),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 30 * 864e5 }
});

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws: wss:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use(sessionMiddleware);

const requestBuckets = new Map();
function limitSensitiveRequests(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const current = Date.now();
  const bucket = requestBuckets.get(key) || { startedAt: current, count: 0 };
  if (current - bucket.startedAt > 60_000) { bucket.startedAt = current; bucket.count = 0; }
  bucket.count += 1;
  requestBuckets.set(key, bucket);
  if (bucket.count > 30) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  next();
}
app.use(express.static(path.join(dirname, '../public'), {
  // 页面代码保持实时更新；图片和字体缓存一天，避免每次操作重复下载牌面资源。
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (cachedAssetExtensions.has(path.extname(filePath).toLowerCase())) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return;
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

app.get('/api/me', (req, res) => res.json({
  user: req.session.user || null,
  wechatConfigured: Boolean(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET),
  devLogin: process.env.ALLOW_DEV_LOGIN !== 'false'
}));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// 前端版本号:每次发布时更新(与 index.html 的 ?v= 同步),供"新版本提示"检测
const APP_VERSION = '20260824ab';
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION }));

app.post('/api/dev-login', limitSensitiveRequests, (req, res) => {
  if (process.env.ALLOW_DEV_LOGIN === 'false') return res.status(403).json({ error: '测试登录已关闭' });
  const name = String(req.body.name || '').trim().slice(0, 12);
  if (!name) return res.status(400).json({ error: '请输入昵称' });
  req.session.user = { id: `dev_${crypto.randomUUID()}`, name, avatar: '', bot: req.body.bot === true };
  req.session.save(() => res.json({ user: req.session.user }));
});

app.post('/api/change-name', limitSensitiveRequests, (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ error: '登录已失效' });
  const name = String(req.body.name || '').trim().slice(0, 12);
  if (!name) return res.status(400).json({ error: '请输入新名字' });
  const oldName = user.name;
  user.name = name;
  for (const room of rooms.values()) {
    const player = room.players.find((candidate) => candidate.id === user.id);
    if (!player) continue;
    player.name = name;
    room.chipRequests.forEach((request) => { if (request.playerId === user.id) request.playerName = name; });
    room.borrowRequests.forEach((request) => {
      if (request.borrowerId === user.id) request.borrowerName = name;
      if (request.lenderId === user.id) request.lenderName = name;
    });
    room.log.push(`${oldName} 更名为 ${name}`);
    room.updatedAt = Date.now();
    broadcast(room);
  }
  for (const client of io.sockets.sockets.values()) {
    if (client.request.session.user?.id === user.id) client.request.session.user.name = name;
  }
  req.session.save(() => res.json({ ok: true, user }));
});

app.post('/api/logout', (req, res) => {
  const userId = req.session.user?.id;
  if (userId && [...rooms.values()].some((room) => room.players.some((player) => player.id === userId))) {
    return res.status(400).json({ error: '请先退出当前房间' });
  }
  req.session.destroy(() => res.json({ ok: true }));
});

app.post('/api/leave-room', (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ error: '登录已失效' });
    leaveAllRoomsForUser(req.session.user.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/leave-and-logout', (req, res) => {
  const userId = req.session.user?.id;
  try {
    if (userId) leaveAllRoomsForUser(userId);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/auth/wechat', (req, res) => {
  if (!process.env.WECHAT_APP_ID) return res.status(503).send('尚未配置微信 AppID');
  const redirect = encodeURIComponent(`${baseUrl}/auth/wechat/callback`);
  res.redirect(`https://open.weixin.qq.com/connect/oauth2/authorize?appid=${process.env.WECHAT_APP_ID}&redirect_uri=${redirect}&response_type=code&scope=snsapi_userinfo&state=gf#wechat_redirect`);
});

app.get('/auth/wechat/callback', async (req, res) => {
  try {
    if (req.query.state !== 'gf' || !req.query.code) throw new Error('无效回调');
    const tokenUrl = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
    Object.entries({ appid: process.env.WECHAT_APP_ID, secret: process.env.WECHAT_APP_SECRET, code: req.query.code, grant_type: 'authorization_code' }).forEach(([key, value]) => tokenUrl.searchParams.set(key, value));
    const token = await fetch(tokenUrl).then((response) => response.json());
    if (!token.access_token) throw new Error(token.errmsg || '微信授权失败');
    const infoUrl = new URL('https://api.weixin.qq.com/sns/userinfo');
    infoUrl.searchParams.set('access_token', token.access_token);
    infoUrl.searchParams.set('openid', token.openid);
    infoUrl.searchParams.set('lang', 'zh_CN');
    const info = await fetch(infoUrl).then((response) => response.json());
    req.session.user = { id: `wx_${info.openid}`, name: info.nickname || '微信玩家', avatar: info.headimgurl || '' };
    req.session.save(() => res.redirect('/'));
  } catch (error) {
    res.status(400).send(error.message);
  }
});

loadRooms();
backupRooms(); // 启动时备份一次
// 每6小时定时备份
const backupTimer = setInterval(backupRooms, 6 * 60 * 60 * 1000);
backupTimer.unref?.();
io.engine.use(sessionMiddleware);
io.on('connection', (socket) => {
  const user = socket.request.session.user;
  if (!user) return socket.disconnect(true);
  let eventWindowStarted = Date.now();
  let eventCount = 0;
  socket.use((_packet, next) => {
    const current = Date.now();
    if (current - eventWindowStarted > 10_000) { eventWindowStarted = current; eventCount = 0; }
    eventCount += 1;
    if (eventCount > 120) return next(new Error('操作过于频繁，请稍后再试'));
    next();
  });

  socket.on('create-room', ({ isPublic = true } = {}, reply) => safe(reply, () => {
    // 一人一房:已有自己创建的房间则直接进入,不重复创建
    const existing = [...rooms.values()].find((r) => r.ownerId === user.id);
    if (existing) {
      leaveOtherRoom(socket, user.id, existing.code);
      joinSocket(socket, existing, user);
      return { code: existing.code, reused: true };
    }
    leaveOtherRoom(socket, user.id);
    let code;
    do code = String(Math.floor(100000 + Math.random() * 900000)); while (rooms.has(code));
    const room = makeRoom(code, user);
    room.isPublic = Boolean(isPublic);
    rooms.set(code, room);
    joinSocket(socket, room, user);
    return { code };
  }));

  socket.on('join-room', ({ code }, reply) => safe(reply, () => {
    const room = mustRoom(code);
    leaveOtherRoom(socket, user.id, room.code);
    addPlayer(room, user);
    joinSocket(socket, room, user);
    return { code: room.code };
  }));

  // 房主一键添加机器人陪玩(服务端托管,无真实连接)
  socket.on('add-bot', ({ code }, reply) => safe(reply, () => {
    const room = mustRoom(code);
    if (room.ownerId !== user.id) throw new Error('只有房主可以添加机器人');
    if (room.status !== 'waiting') throw new Error('牌局进行中，请等待下一局');
    if (room.players.length >= MAX_PLAYERS) throw new Error(`房间已满（最多${MAX_PLAYERS}人）`);
    const name = nextBotName(room);
    const botUser = { id: botId(), name, avatar: '', bot: true };
    addPlayer(room, botUser);
    // 机器人开局自带筹码并自动准备,房主可直接开始
    try {
      requestChips(room, botUser.id, 500);
      const pending = (room.chipRequests || []).find((request) => request.playerId === botUser.id && request.status === 'pending');
      if (pending) reviewChipRequest(room, room.ownerId, pending.id, true);
      setReady(room, botUser.id, true);
    } catch { /* 筹码/准备异常不阻塞添加 */ }
    room.log.push(`🤖 ${name} 加入房间`);
    broadcast(room);
    return { name };
  }));

  // 房主移除机器人陪玩
  socket.on('remove-bot', ({ code, botId: targetId }, reply) => safe(reply, () => {
    const room = mustRoom(code);
    if (room.ownerId !== user.id) throw new Error('只有房主可以移除机器人');
    const bot = room.players.find((player) => player.id === targetId);
    if (!bot) throw new Error('机器人不存在');
    if (!isBotPlayer(bot)) throw new Error('只能移除机器人');
    const result = leavePlayer(room, targetId);
    if (result.closed) deleteRoom(room.code); else broadcast(room);
    return { removed: true, name: bot.name };
  }));

  socket.on('leave-room', ({ code }, reply) => safe(reply, () => {
    const room = mustRoom(code);
    const result = leavePlayer(room, user.id);
    socket.leave(room.code);
    socket.data.roomCode = null;
    if (result.closed) deleteRoom(room.code); else broadcast(room);
    return { left: true };
  }));

  socket.on('set-ready', ({ code, ready }, reply) => mutate(reply, code, () => setReady(mustRoom(code), user.id, ready)));
  socket.on('set-trustee', ({ code, enabled }, reply) => mutate(reply, code, () => setTrustee(mustRoom(code), user.id, enabled)));
  socket.on('request-chips', ({ code, amount }, reply) => mutate(reply, code, () => requestChips(mustRoom(code), user.id, Number(amount))));
  socket.on('review-chips', ({ code, requestId, approved }, reply) => mutate(reply, code, () => reviewChipRequest(mustRoom(code), user.id, requestId, Boolean(approved))));
  socket.on('request-borrow', ({ code, lenderId, amount }, reply) => mutate(reply, code, () => requestBorrow(mustRoom(code), user.id, lenderId, Number(amount))));
  socket.on('review-borrow', ({ code, requestId, approved }, reply) => mutate(reply, code, () => reviewBorrowRequest(mustRoom(code), user.id, requestId, Boolean(approved))));
  socket.on('repay-borrow', ({ code, debtId, amount }, reply) => mutate(reply, code, () => repayBorrow(mustRoom(code), user.id, debtId, Number(amount))));
  socket.on('start-game', ({ code }, reply) => mutate(reply, code, () => startGame(mustRoom(code), user.id)));
  socket.on('action', ({ code, action, targetId, raiseTo }, reply) => mutate(reply, code, () => action === 'compare' ? showdown(mustRoom(code), user.id, targetId) : act(mustRoom(code), user.id, action, raiseTo)));
  socket.on('review-compare', ({ code, requestId, approved }, reply) => mutate(reply, code, () => reviewComparison(mustRoom(code), user.id, requestId, Boolean(approved))));

  socket.on('get-records', ({ code }, reply) => safe(reply, () => {
    const room = mustRoom(code);
    if (!room.players.some((player) => player.id === user.id)) throw new Error('你不在这个房间中');
    return { records: {
      ledger: (room.ledger || []).slice(-1000),
      log: (room.log || []).slice(-500),
      history: (room.history || []).slice(0, 30)
    } };
  }));

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (room && !hasOtherConnectedSocket(user.id, room.code, socket.id) && disconnectPlayer(room, user.id)) broadcast(room);
  });
});

function safe(reply, operation) {
  try {
    const data = operation() || {};
    reply?.({ ok: true, ...data });
  } catch (error) {
    reply?.({ ok: false, error: error.message });
  }
}

function mutate(reply, code, operation) {
  safe(reply, () => {
    const data = operation();
    const room = mustRoom(code);
    broadcast(room);
    return data;
  });
}

function mustRoom(code) {
  const room = rooms.get(String(code));
  if (!room) throw new Error('房间不存在或已关闭');
  return room;
}

function leaveRoomForUser(userId, code) {
  const room = mustRoom(code);
  const result = leavePlayer(room, userId);
  for (const client of io.sockets.sockets.values()) {
    if (client.request.session.user?.id !== userId) continue;
    client.leave(room.code);
    client.data.roomCode = null;
  }
  if (result.closed) deleteRoom(room.code); else broadcast(room);
}

function leaveAllRoomsForUser(userId) {
  const codes = [...rooms.values()].filter((room) => room.players.some((player) => player.id === userId)).map((room) => room.code);
  codes.forEach((code) => leaveRoomForUser(userId, code));
}

function leaveOtherRoom(socket, userId, exceptCode = null) {
  for (const room of rooms.values()) {
    if (room.code === exceptCode || !room.players.some((player) => player.id === userId)) continue;
    const result = leavePlayer(room, userId);
    for (const client of io.sockets.sockets.values()) {
      if (client.request.session.user?.id !== userId) continue;
      client.leave(room.code);
      if (client.data.roomCode === room.code) client.data.roomCode = null;
    }
    if (result.closed) deleteRoom(room.code); else broadcast(room);
  }
}

function hasOtherConnectedSocket(userId, code, excludedSocketId) {
  for (const client of io.sockets.sockets.values()) {
    if (client.id === excludedSocketId || !client.connected) continue;
    if (client.data.roomCode === code && client.request.session.user?.id === userId) return true;
  }
  return false;
}

function joinSocket(socket, room, user) {
  socket.join(room.code);
  socket.data.roomCode = room.code;
  const player = room.players.find((candidate) => candidate.id === user.id);
  if (player) {
    player.connected = true;
    player.lastSeenAt = Date.now();
  }
  broadcast(room);
}

// ---- 广播合并:250ms 窗口内同一房间多次变更合并为一次推送 ----
// 机器人连招/多人操作时大幅减少客户端渲染次数(真人局操作间隔远超250ms,零感知)
const broadcastQueue = new Map(); // code -> room(最新状态)
let broadcastFlushTimer = null;
function broadcast(room) {
  broadcastQueue.set(room.code, room);
  if (!broadcastFlushTimer) {
    broadcastFlushTimer = setTimeout(() => {
      broadcastFlushTimer = null;
      const batch = [...broadcastQueue.values()];
      broadcastQueue.clear();
      for (const r of batch) pushRoom(r);
    }, 250);
    broadcastFlushTimer.unref?.();
  }
}
function pushRoom(room) {
  // 房间可能已删除/重建,只推仍存在的
  if (rooms.get(room.code) !== room) return;
  scheduleRoom(room);
  scheduleSaveRooms();
  for (const socketId of io.sockets.adapter.rooms.get(room.code) || []) {
    const client = io.sockets.sockets.get(socketId);
    if (client?.request.session.user) client.emit('room', publicRoom(room, client.request.session.user.id));
  }
  scheduleBotDecisions(room);
}

// ---- 服务端托管机器人决策调度 ----
// 轮到机器人行动时,延迟 1~3 秒模拟"思考",再按真人策略自动操作;
// 真人被机器人比牌时,机器人自动确认;真人比机器人时,机器人等待真人确认。
function scheduleBotDecisions(room) {
  if (room.status !== 'playing' || room.turn < 0) return;
  if (botTimers.has(room.code)) return;
  if (room.pendingCompare) {
    if (isBotPlayer(room.players.find((player) => player.id === room.pendingCompare.targetId))) {
      const timer = setTimeout(() => {
        botTimers.delete(room.code);
        const current = rooms.get(room.code);
        if (!current?.pendingCompare) return;
        try {
          reviewComparison(current, current.pendingCompare.targetId, current.pendingCompare.id, true);
          broadcast(current);
        } catch { /* 状态已变化则忽略 */ }
      }, 900);
      timer.unref?.();
      botTimers.set(room.code, timer);
    }
    return;
  }
  const current = room.players[room.turn];
  if (!isBotPlayer(current) || current.folded) return;
  const timer = setTimeout(() => {
    botTimers.delete(room.code);
    runBotTurn(room.code, current.id);
  }, 700 + Math.random() * 1_100); // 0.7~1.8秒思考,节奏接近真人
  timer.unref?.();
  botTimers.set(room.code, timer);
}

function runBotTurn(code, botIdValue) {
  const room = rooms.get(code);
  if (!room) return;
  const bot = room.players.find((player) => player.id === botIdValue);
  if (!bot || room.status !== 'playing' || bot.folded) return;
  if (room.pendingCompare) return; // 等待对方确认比牌
  if (room.players[room.turn]?.id !== botIdValue) return; // 已轮到别人
  // 筹码不足当前跟注额时,先自动补筹码,避免行动失败拖到30秒超时
  const need = betCost(room.currentBet, bot.seen);
  if (bot.chips < need) ensureBotChips(room, bot);
  try {
    console.log(`[bot] ${bot.name} 行动(档位${room.currentBet},${bot.seen ? '明' : '闷'},筹码${bot.chips})`);
    decideBot(room, bot);
    broadcast(room);
  } catch (error) {
    // 决策失败兜底:仍轮到该机器人则按当前档位跟注
    try {
      console.log(`[bot] ${bot.name} 决策异常(${error.message})→跟注兜底`);
      act(room, botIdValue, 'call');
      broadcast(room);
    } catch { /* 忽略 */ }
  }
}

// 机器人筹码不足时自动补筹码(低于50即补500),不用真人房主审批
function ensureBotChips(room, bot) {
  if (bot.chips >= 50 || bot.leaveAfterRound) return;
  try {
    let pending = (room.chipRequests || []).find((request) => request.playerId === bot.id && request.status === 'pending');
    if (!pending) requestChips(room, bot.id, 500);
    pending = (room.chipRequests || []).find((request) => request.playerId === bot.id && request.status === 'pending');
    if (pending) reviewChipRequest(room, room.ownerId, pending.id, true);
  } catch { /* 忽略单房间异常 */ }
}

// 机器人决策:智能引擎(牌力+赔率+读人+诈唬+性格),见 src/botBrain.js
function decideBot(room, bot) {
  const { canCompare, compareTargetIds } = comparisonAvailability(room, bot.id);
  const active = room.players.filter((player) => !player.folded);
  const opponents = active.filter((player) => player.id !== bot.id)
    .sort((a, b) => b.bet - a.bet); // 投入多的排前面,视为更凶
  const ctx = {
    seen: bot.seen,
    hand: bot.seen ? bot.hand : [],
    chips: bot.chips,
    currentBet: room.currentBet,
    pot: room.pot,
    actionsInHand: room.actionsInHand,
    oppCount: opponents.length,
    opponents: opponents.map((o) => ({ bet: o.bet, seen: o.seen })),
    canCompare,
    compareTargetIds: opponents.filter((o) => compareTargetIds.includes(o.id)).map((o) => o.id),
    personality: botPersonality(bot.name),
    // 读人:最近一次行动是否是对手的加注(威胁信号→强牌可能真大)
    threat: Boolean(room.lastAction?.type === 'raise' && room.lastAction.playerId !== bot.id && !room.players.find((p) => p.id === room.lastAction.playerId)?.folded)
  };
  const decision = chooseBotAction(ctx);
  console.log(`[bot] ${bot.name}(${ctx.personality.tag}) ${bot.seen ? '明' : '闷'} 档位${room.currentBet} → ${decision.action}${decision.raiseTo ? `至${decision.raiseTo}` : ''}${decision.targetId ? `(${room.players.find((p) => p.id === decision.targetId)?.name})` : ''}`);
  if (decision.action === 'compare') return showdown(room, bot.id, decision.targetId);
  if (decision.action === 'raise') return act(room, bot.id, 'raise', decision.raiseTo);
  return act(room, bot.id, decision.action); // call / fold / see
}

function scheduleRoom(room) {
  clearTimeout(roomTimers.get(room.code));
  const deadlines = [room.turnDeadline, room.reveal?.expiresAt, room.pendingCompare?.expiresAt].filter(Boolean);
  if (!deadlines.length) return roomTimers.delete(room.code);
  const delay = Math.max(10, Math.min(...deadlines) - Date.now() + 20);
  const timer = setTimeout(() => {
    const current = rooms.get(room.code);
    if (!current) return;
    let changed = expireComparisonRequest(current) || expireTurn(current);
    if (current.reveal && current.reveal.expiresAt <= Date.now()) {
      current.reveal = null;
      changed = true;
    }
    if (changed) broadcast(current); else scheduleRoom(current);
  }, delay);
  timer.unref?.();
  roomTimers.set(room.code, timer);
}

function deleteRoom(code) {
  clearTimeout(roomTimers.get(code));
  clearTimeout(botTimers.get(code));
  roomTimers.delete(code);
  botTimers.delete(code);
  rooms.delete(code);
  scheduleSaveRooms();
}

function saveRooms() {
  if (process.env.NODE_ENV === 'test') return;
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const temporary = `${dataFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...rooms.values()], null, 2), 'utf8');
    if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, roomsBackupFile);
    fs.renameSync(temporary, dataFile);
  } catch (error) {
    console.error('保存房间失败：', error.message);
  }
}

// 数据自动备份:启动时 + 每6小时快照到 data/backups,保留最近10份
function backupRooms() {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const dir = path.join(dirname, '../data/backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const target = path.join(dir, `rooms-${stamp}.json`);
    if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, target);
    const list = fs.readdirSync(dir).filter((f) => f.startsWith('rooms-')).sort();
    for (let i = 0; i < list.length - 10; i += 1) fs.unlinkSync(path.join(dir, list[i]));
  } catch (error) {
    console.error('备份失败：', error.message);
  }
}

function scheduleSaveRooms() {
  if (process.env.NODE_ENV === 'test') return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveRooms(); }, 100);
  saveTimer.unref?.();
}

function loadRooms() {
  if (process.env.NODE_ENV === 'test' || (!fs.existsSync(dataFile) && !fs.existsSync(roomsBackupFile))) return;
  try {
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    } catch (primaryError) {
      stored = JSON.parse(fs.readFileSync(roomsBackupFile, 'utf8'));
      console.warn('主房间数据损坏，已从备份恢复：', primaryError.message);
    }
    for (const room of stored) {
      room.ledger ||= [];
      room.players.forEach((player) => {
        player.connected = false;
        player.ready = false;
        // 服务端托管机器人:加载后视为在线,等待阶段自动补筹码+准备(见 chipAutoTimer)
        if (isBotPlayer(player)) player.connected = true;
      });
      room.reveal = null;
      room.pendingCompare = null;
      if (room.status === 'playing') {
        room.turnDeadline = Date.now() + 30_000;
      }
      rooms.set(room.code, room);
      scheduleRoom(room);
    }
  } catch (error) {
    console.error('读取房间失败：', error.message);
  }
}

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000; // 15 分钟
  for (const room of rooms.values()) {
    // 无真人玩家在线(全是机器人或已离线)的房间视为空房,超时后清理
    const allOffline = room.players.every((player) => !player.connected || player.bot);
    if (allOffline && room.updatedAt < cutoff) deleteRoom(room.code);
  }
  for (const [key, bucket] of requestBuckets) {
    if (Date.now() - bucket.startedAt > 10 * 60_000) requestBuckets.delete(key);
  }
}, 5 * 60 * 1000);
cleanupTimer.unref?.();

// 机器人自动补筹码:等待阶段补到能准备,牌局中低于50也自动补(真人必须走房主审批)
const chipAutoTimer = setInterval(() => {
  for (const room of rooms.values()) {
    for (const player of room.players) {
      if (!player.bot) continue; // 真人:筹码申请必须经房主批准
      if (player.leaveAfterRound) continue;
      try {
        let changed = false;
        if (room.status === 'waiting') {
          if (player.chips < room.baseBet) {
            const pending = (room.chipRequests || []).find((request) => request.playerId === player.id && request.status === 'pending');
            if (!pending) requestChips(room, player.id, 500);
            const latest = (room.chipRequests || []).find((request) => request.playerId === player.id && request.status === 'pending');
            if (latest) reviewChipRequest(room, room.ownerId, latest.id, true);
            changed = true;
          }
          // 机器人筹码足够后自动准备,房主可直接开局
          if (player.chips >= room.baseBet && !player.ready) { setReady(room, player.id, true); changed = true; }
        } else if (room.status === 'playing' && player.chips < 50) {
          // 牌局中筹码不足50自动补,避免机器人"没钱+等30秒超时"的窘境
          const before = player.chips;
          ensureBotChips(room, player);
          if (player.chips !== before) changed = true;
        }
        if (changed) broadcast(room);
      } catch { /* 忽略单房间异常 */ }
    }
  }
}, 1_500);
chipAutoTimer.unref?.();

// 真人离线自动清理:接电话/短暂断网 10 分钟内回来正常;超过 10 分钟移出房间(牌局中则自动弃牌,本局结束移除)
const OFFLINE_KICK_MS = 10 * 60 * 1000; // 10 分钟
const offlineKickTimer = setInterval(() => {
  const cutoff = Date.now() - OFFLINE_KICK_MS;
  for (const room of rooms.values()) {
    const kickIds = room.players
      .filter((player) => !player.bot && !player.connected && (player.lastSeenAt || 0) <= cutoff)
      .map((player) => player.id);
    if (!kickIds.length) continue;
    let closed = false;
    for (const id of kickIds) {
      try {
        const result = leavePlayer(room, id);
        if (result.closed) { closed = true; break; }
      } catch { /* 忽略单个玩家异常 */ }
    }
    // 真人全部离开后,只剩机器人的房间直接解散
    if (closed || !room.players.some((player) => !player.bot)) deleteRoom(room.code); else broadcast(room);
  }
}, 5_000);
offlineKickTimer.unref?.();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveRooms();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref?.();
  });
}

if (process.env.NODE_ENV !== 'test') server.listen(port, '0.0.0.0', () => console.log(`三张牌已启动：${baseUrl}`));
export { app, FileSessionStore, server, rooms };
