import test from 'node:test';
import assert from 'node:assert/strict';
import { io as clientIo } from 'socket.io-client';

process.env.NODE_ENV = 'test';
const { server, rooms } = await import('../src/server.js');

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
  await waitUntil(() => ownerRoom.currentBet === 5);

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
