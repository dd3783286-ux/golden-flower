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
  expireTurn,
  leavePlayer,
  makeRoom,
  publicRoom,
  repayBorrow,
  requestBorrow,
  requestChips,
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
const production = process.env.NODE_ENV === 'production';
const cachedAssetExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.woff', '.woff2']);

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: production || baseUrl.startsWith('https://'), maxAge: 30 * 864e5 }
});

app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
app.use(sessionMiddleware);
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

app.post('/api/dev-login', (req, res) => {
  if (process.env.ALLOW_DEV_LOGIN === 'false') return res.status(403).json({ error: '测试登录已关闭' });
  const name = String(req.body.name || '').trim().slice(0, 12);
  if (!name) return res.status(400).json({ error: '请输入昵称' });
  req.session.user = { id: `dev_${crypto.randomUUID()}`, name, avatar: '' };
  req.session.save(() => res.json({ user: req.session.user }));
});

app.post('/api/change-name', (req, res) => {
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

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

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
  } catch {}
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
io.engine.use(sessionMiddleware);
io.on('connection', (socket) => {
  const user = socket.request.session.user;
  if (!user) return socket.disconnect(true);

  socket.on('create-room', (_ = {}, reply) => safe(reply, () => {
    leaveOtherRoom(socket, user.id);
    let code;
    do code = String(Math.floor(100000 + Math.random() * 900000)); while (rooms.has(code));
    const room = makeRoom(code, user);
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

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (room && disconnectPlayer(room, user.id)) broadcast(room);
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
    socket.leave(room.code);
    if (result.closed) deleteRoom(room.code); else broadcast(room);
  }
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
  saveRooms();
  for (const socketId of io.sockets.adapter.rooms.get(room.code) || []) {
    const client = io.sockets.sockets.get(socketId);
    if (client?.request.session.user) client.emit('room', publicRoom(room, client.request.session.user.id));
  }
}

function scheduleRoom(room) {
  clearTimeout(roomTimers.get(room.code));
  const deadlines = [room.turnDeadline, room.reveal?.expiresAt].filter(Boolean);
  if (!deadlines.length) return roomTimers.delete(room.code);
  const delay = Math.max(10, Math.min(...deadlines) - Date.now() + 20);
  const timer = setTimeout(() => {
    const current = rooms.get(room.code);
    if (!current) return;
    let changed = expireTurn(current);
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
  saveRooms();
}

function saveRooms() {
  if (process.env.NODE_ENV === 'test') return;
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify([...rooms.values()], null, 2), 'utf8');
  } catch (error) {
    console.error('保存房间失败：', error.message);
  }
}

function loadRooms() {
  if (process.env.NODE_ENV === 'test' || !fs.existsSync(dataFile)) return;
  try {
    const stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const room of stored) {
      room.ledger ||= [];
      room.players.forEach((player) => { player.connected = false; player.ready = false; });
      room.reveal = null;
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
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const room of rooms.values()) {
    const allOffline = room.players.every((player) => !player.connected);
    if (allOffline && room.updatedAt < cutoff) deleteRoom(room.code);
  }
}, 10 * 60 * 1000);
cleanupTimer.unref?.();

if (process.env.NODE_ENV !== 'test') server.listen(port, '0.0.0.0', () => console.log(`三张牌已启动：${baseUrl}`));
export { app, server, rooms };
