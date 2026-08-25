import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as clientIo } from 'socket.io-client';

process.env.NODE_ENV = 'test';
const { FileSessionStore, server, rooms } = await import('../src/server.js');

function emitAck(socket, event, data) {
  return new Promise((resolve, reject) => socket.timeout(3_000).emit(event, data, (error, response) => error ? reject(error) : resolve(response)));
}
function waitUntil(predicate, timeout = 3_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const value = predicate();
      if (value) { clearInterval(timer); resolve(value); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('等待状态更新超时')); }
    }, 20);
  });
}
async function login(origin, name) {
  const response = await fetch(`${origin}/api/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
function connect(origin, cookie, onRoom) {
  return clientIo(origin, { transports: ['websocket'], extraHeaders: { Cookie: cookie }, forceNew: true }).on('room', onRoom);
}

test('双客户端完成建房、准备、审批、重连、下注和真正退出', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ownerCookie = await login(origin, '房主');
  const guestCookie = await login(origin, '好友');
  let ownerRoom;
  let guestRoom;
  const owner = connect(origin, ownerCookie, (state) => { ownerRoom = state; });
  let guest = connect(origin, guestCookie, (state) => { guestRoom = state; });
  t.after(() => { owner.disconnect(); guest.disconnect(); rooms.clear(); server.close(); });
  await Promise.all([new Promise((resolve) => owner.on('connect', resolve)), new Promise((resolve) => guest.on('connect', resolve))]);

  const created = await emitAck(owner, 'create-room', {});
  assert.equal(created.ok, true);
  assert.equal((await emitAck(guest, 'join-room', { code: created.code })).ok, true);
  await waitUntil(() => ownerRoom?.players.length === 2 && guestRoom?.players.length === 2);

  const renameResponse = await fetch(`${origin}/api/change-name`, { method: 'POST', headers: { 'content-type': 'application/json', Cookie: guestCookie }, body: JSON.stringify({ name: 'iPad新名字' }) });
  assert.equal(renameResponse.status, 200);
  await waitUntil(() => ownerRoom.players.some((player) => player.name === 'iPad新名字'));
  const restoreNameResponse = await fetch(`${origin}/api/change-name`, { method: 'POST', headers: { 'content-type': 'application/json', Cookie: guestCookie }, body: JSON.stringify({ name: '好友' }) });
  assert.equal(restoreNameResponse.status, 200);
  await waitUntil(() => ownerRoom.players.some((player) => player.name === '好友'));

  const ownerChip = await emitAck(owner, 'request-chips', { code: created.code, amount: 500 });
  const guestChip = await emitAck(guest, 'request-chips', { code: created.code, amount: 500 });
  assert.equal((await emitAck(owner, 'review-chips', { code: created.code, requestId: ownerChip.id, approved: true })).ok, true);
  assert.equal((await emitAck(owner, 'review-chips', { code: created.code, requestId: guestChip.id, approved: true })).ok, true);
  await waitUntil(() => ownerRoom.players.every((player) => player.chips === 500));
  assert.deepEqual(ownerRoom.ledger, []);
  const records = await emitAck(owner, 'get-records', { code: created.code });
  assert.equal(records.ok, true);
  assert.ok(records.records.ledger.length >= 2);

  assert.equal((await emitAck(owner, 'set-ready', { code: created.code, ready: true })).ok, true);
  assert.equal((await emitAck(guest, 'set-ready', { code: created.code, ready: true })).ok, true);
  await waitUntil(() => ownerRoom.players.every((player) => player.ready));

  guest.disconnect();
  await waitUntil(() => ownerRoom.players.find((player) => player.name === '好友').connected === false);
  guest = connect(origin, guestCookie, (state) => { guestRoom = state; });
  await new Promise((resolve) => guest.on('connect', resolve));
  assert.equal((await emitAck(guest, 'join-room', { code: created.code })).ok, true);
  await waitUntil(() => guestRoom?.code === created.code && ownerRoom.players.find((player) => player.name === '好友').connected === true);
  assert.equal((await emitAck(guest, 'set-ready', { code: created.code, ready: true })).ok, true);

  assert.equal((await emitAck(owner, 'start-game', { code: created.code })).ok, true);
  await waitUntil(() => ownerRoom.status === 'playing' && guestRoom.status === 'playing');
  const socketsByName = { 房主: owner, 好友: guest };
  const firstName = ownerRoom.players[ownerRoom.turn].name;
  const firstSocket = socketsByName[firstName];
  assert.equal((await emitAck(firstSocket, 'action', { code: created.code, action: 'see' })).ok, true);
  assert.equal((await emitAck(firstSocket, 'action', { code: created.code, action: 'call' })).ok, true);
  await waitUntil(() => ownerRoom.players[ownerRoom.turn].name !== firstName);
  const secondName = ownerRoom.players[ownerRoom.turn].name;
  assert.equal((await emitAck(socketsByName[secondName], 'action', { code: created.code, action: 'raise', raiseTo: 5 })).ok, true);
  // 奇数档位自动取偶(明牌价=2×闷牌价严格成立)
  await waitUntil(() => ownerRoom.currentBet === 6);

  assert.equal((await emitAck(firstSocket, 'leave-room', { code: created.code })).ok, true);
  await waitUntil(() => ownerRoom?.status === 'waiting' || guestRoom?.status === 'waiting');
  const remainingSocket = firstSocket === owner ? guest : owner;
  let unexpectedlyRejoined = false;
  const reconnect = connect(origin, firstSocket === owner ? ownerCookie : guestCookie, () => { unexpectedlyRejoined = true; });
  t.after(() => reconnect.disconnect());
  await new Promise((resolve) => reconnect.on('connect', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(unexpectedlyRejoined, false);
  assert.equal([...rooms.values()][0]?.players.some((player) => player.name === firstName), false);
  remainingSocket.disconnect();
});

test('同一账号打开两个页面，关闭一个不会把另一个判为离线', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cookie = await login(origin, '双页面玩家');
  let latestRoom;
  const first = connect(origin, cookie, (state) => { latestRoom = state; });
  const second = connect(origin, cookie, (state) => { latestRoom = state; });
  t.after(() => { first.disconnect(); second.disconnect(); rooms.clear(); server.close(); });
  await Promise.all([new Promise((resolve) => first.on('connect', resolve)), new Promise((resolve) => second.on('connect', resolve))]);
  const created = await emitAck(first, 'create-room', {});
  assert.equal((await emitAck(second, 'join-room', { code: created.code })).ok, true);
  await waitUntil(() => latestRoom?.players[0]?.connected === true);
  first.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(rooms.get(created.code).players[0].connected, true);
});

test('三名在线玩家通过确认完成明牌比牌且第三方看不到牌面', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const names = ['甲', '乙', '丙'];
  const cookies = await Promise.all(names.map((name) => login(origin, name)));
  const states = {};
  const clients = names.map((name, index) => connect(origin, cookies[index], (state) => { states[name] = state; }));
  t.after(() => { clients.forEach((client) => client.disconnect()); rooms.clear(); server.close(); });
  await Promise.all(clients.map((client) => new Promise((resolve) => client.on('connect', resolve))));
  const socketByName = Object.fromEntries(names.map((name, index) => [name, clients[index]]));
  const created = await emitAck(clients[0], 'create-room', {});
  await emitAck(clients[1], 'join-room', { code: created.code });
  await emitAck(clients[2], 'join-room', { code: created.code });
  await waitUntil(() => states.甲?.players.length === 3);

  for (const name of names) {
    const request = await emitAck(socketByName[name], 'request-chips', { code: created.code, amount: 100 });
    assert.equal((await emitAck(clients[0], 'review-chips', { code: created.code, requestId: request.id, approved: true })).ok, true);
    assert.equal((await emitAck(socketByName[name], 'set-ready', { code: created.code, ready: true })).ok, true);
  }
  assert.equal((await emitAck(clients[0], 'start-game', { code: created.code })).ok, true);
  await waitUntil(() => states.甲?.status === 'playing');
  for (let index = 0; index < 3; index += 1) {
    const currentName = states.甲.players[states.甲.turn].name;
    await emitAck(socketByName[currentName], 'action', { code: created.code, action: 'see' });
    await emitAck(socketByName[currentName], 'action', { code: created.code, action: 'call' });
    await waitUntil(() => states.甲.players[states.甲.turn].name !== currentName);
  }

  const challengerName = states.甲.players[states.甲.turn].name;
  const targetName = names.find((name) => name !== challengerName);
  const thirdName = names.find((name) => ![challengerName, targetName].includes(name));
  const targetId = states.甲.players.find((player) => player.name === targetName).id;
  const request = await emitAck(socketByName[challengerName], 'action', { code: created.code, action: 'compare', targetId });
  assert.equal(request.pending, true);
  await waitUntil(() => states[targetName]?.pendingCompare?.id === request.requestId);
  assert.equal(states[thirdName].pendingCompare.challengerName, undefined);
  assert.equal((await emitAck(socketByName[targetName], 'review-compare', { code: created.code, requestId: request.requestId, approved: true })).ok, true);
  await waitUntil(() => states.甲?.reveal?.id);
  assert.equal(states[challengerName].reveal.cardsVisible, true);
  assert.equal(states[targetName].reveal.cardsVisible, true);
  assert.equal(states[thirdName].reveal.cardsVisible, false);
  assert.equal(states.甲.players.filter((player) => !player.folded).length, 2);
});

test('安全响应头已启用', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { rooms.clear(); server.close(); });
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('文件会话存储可在重新实例化后恢复登录', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-flower-session-'));
  const file = path.join(directory, 'sessions.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = new FileSessionStore(file);
  await new Promise((resolve, reject) => first.set('session-1', { cookie: { expires: new Date(Date.now() + 60_000) }, user: { id: 'u1', name: '玩家' } }, (error) => error ? reject(error) : resolve()));
  const restored = await new Promise((resolve, reject) => new FileSessionStore(file).get('session-1', (error, value) => error ? reject(error) : resolve(value)));
  assert.deepEqual(restored.user, { id: 'u1', name: '玩家' });
});
