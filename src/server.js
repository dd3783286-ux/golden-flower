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
  disconnectPlayer,
  expireComparisonRequest,
  expireTurn,
  leavePlayer,
  makeRoom,
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

const app = express();
const server = createServer(app);
const io = new Server(server, { pingTimeout: 20_000, pingInterval: 10_000 });
const rooms = new Map();
const roomTimers = new Map();
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
const APP_VERSION = '20260822dc';
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

function broadcast(room) {
  scheduleRoom(room);
  scheduleSaveRooms();
  for (const socketId of io.sockets.adapter.rooms.get(room.code) || []) {
    const client = io.sockets.sockets.get(socketId);
    if (client?.request.session.user) client.emit('room', publicRoom(room, client.request.session.user.id));
  }
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
  roomTimers.delete(code);
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
      room.players.forEach((player) => { player.connected = false; player.ready = false; });
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
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const room of rooms.values()) {
    const allOffline = room.players.every((player) => !player.connected);
    if (allOffline && room.updatedAt < cutoff) deleteRoom(room.code);
  }
  for (const [key, bucket] of requestBuckets) {
    if (Date.now() - bucket.startedAt > 10 * 60_000) requestBuckets.delete(key);
  }
}, 10 * 60 * 1000);
cleanupTimer.unref?.();

// 等待阶段自动补筹码:只对机器人(bot)生效,真人必须走房主审批
const chipAutoTimer = setInterval(() => {
  for (const room of rooms.values()) {
    if (room.status !== 'waiting') continue;
    for (const player of room.players) {
      if (!player.bot) continue; // 真人:筹码申请必须经房主批准
      if (player.chips >= room.baseBet || player.leaveAfterRound) continue;
      try {
        const pending = (room.chipRequests || []).find((request) => request.playerId === player.id && request.status === 'pending');
        if (!pending) requestChips(room, player.id, 500);
        const latest = (room.chipRequests || []).find((request) => request.playerId === player.id && request.status === 'pending');
        if (latest) reviewChipRequest(room, room.ownerId, latest.id, true);
        broadcast(room);
      } catch { /* 忽略单房间异常 */ }
    }
  }
}, 1_500);
chipAutoTimer.unref?.();

// 真人离线自动清理:非机器人玩家离线超过30秒自动移出房间(牌局中则自动弃牌,本局结束移除)
const offlineKickTimer = setInterval(() => {
  const cutoff = Date.now() - 15_000;
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
    if (closed) deleteRoom(room.code); else broadcast(room);
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
