import test from 'node:test';
import assert from 'node:assert/strict';
import { compareHands, compareHandsWith235, evaluateHand } from '../src/poker.js';
import {
  act,
  addPlayer,
  BET_LEVELS,
  disconnectPlayer,
  expireTurn,
  leavePlayer,
  makeRoom,
  MAX_PLAYERS,
  publicRoom,
  repayBorrow,
  requestBorrow,
  requestChips,
  reviewBorrowRequest,
  reviewChipRequest,
  setReady,
  setTrustee,
  showdown,
  startGame,
  TURN_MS
} from '../src/game.js';

const hand = (ranks, suits = ['♠', '♥', '♣']) => ranks.map((rank, index) => ({ rank, suit: suits[index] }));
const player = (id, name = id) => ({ id, name, connected: true });
function approve(room, id, amount = 500) {
  const request = requestChips(room, id, amount);
  reviewChipRequest(room, room.ownerId, request.id, true);
}
function fundedRoom(each = 500, count = 2) {
  const room = makeRoom('123456', player('1', '甲'));
  for (let index = 2; index <= count; index += 1) addPlayer(room, player(String(index), `玩家${index}`));
  room.players.forEach((item) => { approve(room, item.id, each); setReady(room, item.id, true); });
  return room;
}

test('牌型顺序、A23和235特殊规则正确', () => {
  assert.equal(evaluateHand(hand([14, 14, 14])).name, '豹子');
  assert.equal(evaluateHand(hand([14, 13, 12], ['♠', '♠', '♠'])).name, '同花顺');
  assert.equal(compareHands(hand([3, 2, 14]), hand([4, 3, 2])), -1);
  assert.equal(compareHandsWith235(hand([2, 3, 5]), hand([9, 9, 9])), 1);
  assert.equal(compareHandsWith235(hand([2, 3, 5]), hand([14, 14, 13])), -1);
  assert.equal(compareHandsWith235(hand([2, 3, 5], ['♠', '♠', '♥']), hand([9, 9, 9])), 1, '两种花色的非同花235也应吃豹子');
  assert.equal(compareHandsWith235(hand([2, 3, 5], ['♠', '♠', '♠']), hand([9, 9, 9])), -1, '同花235仍按金花计算');
});

test('房间最多十人，玩家准备后才能开局', () => {
  const room = makeRoom('1', player('1'));
  for (let index = 2; index <= 10; index += 1) addPlayer(room, player(String(index)));
  assert.equal(room.players.length, MAX_PLAYERS);
  assert.throws(() => addPlayer(room, player('11')), /房间已满/);
  approve(room, '1'); approve(room, '2');
  assert.throws(() => startGame(room, '1'), /还不能开局/);
  setReady(room, '1', true); setReady(room, '2', true);
  startGame(room, '1', () => 0);
  assert.equal(room.status, 'playing');
});

test('初始筹码为0，增加筹码必须房主审批', () => {
  const room = makeRoom('1', player('1', '房主'));
  addPlayer(room, player('2', '客人'));
  assert.deepEqual(room.players.map((item) => item.chips), [0, 0]);
  const request = requestChips(room, '2', 300);
  assert.throws(() => reviewChipRequest(room, '2', request.id, true), /只有房主/);
  reviewChipRequest(room, '1', request.id, true);
  assert.equal(room.players[1].chips, 300);
});

test('借筹码必须出借人同意和房主最终审批，并可归还', () => {
  const room = fundedRoom();
  const request = requestBorrow(room, '2', '1', 200);
  reviewBorrowRequest(room, '1', request.id, true);
  assert.equal(request.status, 'approved', '出借人就是房主时一次确认完成');
  assert.equal(room.players[0].chips, 300);
  assert.equal(room.players[1].chips, 700);
  const debt = room.debts[0];
  repayBorrow(room, '2', debt.id, 100);
  assert.equal(debt.outstanding, 100);
  assert.equal(room.players[0].chips, 400);
});

test('非房主出借时需要两级审批', () => {
  const room = fundedRoom(500, 3);
  const request = requestBorrow(room, '3', '2', 100);
  reviewBorrowRequest(room, '2', request.id, true);
  assert.equal(request.status, 'pending_owner');
  assert.throws(() => reviewBorrowRequest(room, '2', request.id, true), /只有房主/);
  reviewBorrowRequest(room, '1', request.id, true);
  assert.equal(request.status, 'approved');
});

test('第一局随机庄家，后续顺时针轮庄', () => {
  const room = fundedRoom();
  startGame(room, '1', () => 0);
  assert.equal(room.dealer, 0);
  assert.equal(room.turn, 1);
  act(room, '2', 'fold');
  assert.equal(room.lastAction.type, 'fold');
  room.players.forEach((item) => setReady(room, item.id, true));
  startGame(room, '1', () => 0.8);
  assert.equal(room.dealer, 1);
  assert.equal(room.turn, 0);
});

test('闷牌1倍、明牌2倍，看牌后仍由本人操作', () => {
  const room = fundedRoom();
  startGame(room, '1', () => 0);
  const second = room.players[1];
  act(room, '2', 'call');
  assert.deepEqual({ type: room.lastAction.type, amount: room.lastAction.amount }, { type: 'call', amount: 1 });
  assert.equal(second.chips, 498);
  act(room, '1', 'see');
  assert.equal(room.turn, 0);
  const before = room.players[0].chips;
  act(room, '1', 'call');
  assert.equal(room.players[0].chips, before - 2);
});

test('成熟下注档位只能向上选择', () => {
  const room = fundedRoom();
  startGame(room, '1', () => 0);
  act(room, '2', 'raise', 5);
  assert.deepEqual({ type: room.lastAction.type, stake: room.lastAction.stake }, { type: 'raise', stake: 5 });
  assert.equal(room.currentBet, 5);
  assert.ok(BET_LEVELS.includes(room.currentBet));
  assert.throws(() => act(room, '1', 'raise', 2), /高于当前档位/);
});

test('完成首轮下注后才能比牌，只有比牌双方能看到牌面', () => {
  const room = fundedRoom(500, 3);
  startGame(room, '1', () => 0);
  assert.throws(() => showdown(room, room.players[room.turn].id, '1'), /一轮下注/);
  for (let index = 0; index < 3; index += 1) act(room, room.players[room.turn].id, 'call');
  const challenger = room.players[room.turn];
  act(room, challenger.id, 'see');
  const target = room.players.find((item) => item.id !== challenger.id && !item.folded);
  assert.equal(publicRoom(room, challenger.id).canCompare, true);
  const reveal = showdown(room, challenger.id, target.id);
  assert.deepEqual({ type: room.lastAction.type, targetName: room.lastAction.targetName }, { type: 'compare', targetName: target.name });
  assert.equal(reveal.challengerHand.length, 3);
  const participantState = publicRoom(room, challenger.id);
  assert.ok(participantState.players.find((item) => item.id === challenger.id).hand.every(Boolean));
  assert.ok(participantState.players.find((item) => item.id === target.id).hand.every(Boolean));
  assert.equal(participantState.reveal.cardsVisible, true);
  const spectatorState = publicRoom(room, room.players.find((item) => ![challenger.id, target.id].includes(item.id)).id);
  assert.ok(spectatorState.players.find((item) => item.id === challenger.id).hand.every((card) => card === null));
  assert.ok(spectatorState.players.find((item) => item.id === target.id).hand.every((card) => card === null));
  assert.ok(spectatorState.reveal.challengerHand.every((card) => card === null));
  assert.ok(spectatorState.reveal.targetHand.every((card) => card === null));
  assert.equal(spectatorState.reveal.cardsVisible, false);
  assert.equal(spectatorState.reveal.challengerType, null);
  assert.equal(spectatorState.reveal.targetType, null);
});

test('闷牌仅在剩两人时可按跟注额与明牌玩家比牌', () => {
  const room = fundedRoom(500, 3);
  startGame(room, '1', () => 0);
  const blindPlayer = room.players[room.turn];
  act(room, blindPlayer.id, 'call');
  const seenPlayer = room.players[room.turn];
  act(room, seenPlayer.id, 'see');
  act(room, seenPlayer.id, 'call');
  const thirdPlayer = room.players[room.turn];
  act(room, thirdPlayer.id, 'call');

  const threePlayerView = publicRoom(room, blindPlayer.id);
  assert.equal(threePlayerView.canCompare, false);
  assert.equal(threePlayerView.compareHint, '剩两人');
  assert.throws(() => showdown(room, blindPlayer.id, seenPlayer.id), /剩余两名玩家/);

  act(room, blindPlayer.id, 'call');
  act(room, seenPlayer.id, 'call');
  act(room, thirdPlayer.id, 'fold');
  const twoPlayerView = publicRoom(room, blindPlayer.id);
  assert.equal(twoPlayerView.canCompare, true);
  assert.deepEqual(twoPlayerView.compareTargetIds, [seenPlayer.id]);
  const expectedCost = room.currentBet;
  const beforeChips = blindPlayer.chips;
  const reveal = showdown(room, blindPlayer.id, seenPlayer.id);
  assert.equal(reveal.cost, expectedCost);
  assert.equal(blindPlayer.chips, beforeChips - expectedCost);
});

test('剩两名玩家都闷牌时可以闷开并按1倍支付', () => {
  const room = fundedRoom(500, 2);
  startGame(room, '1', () => 0);
  act(room, room.players[room.turn].id, 'call');
  act(room, room.players[room.turn].id, 'call');
  const challenger = room.players[room.turn];
  const target = room.players.find((player) => player.id !== challenger.id && !player.folded);
  const view = publicRoom(room, challenger.id);
  assert.equal(view.canCompare, true);
  assert.deepEqual(view.compareTargetIds, [target.id]);
  const expectedCost = room.currentBet;
  const reveal = showdown(room, challenger.id, target.id);
  assert.equal(reveal.cost, expectedCost);
});

test('剩两人时明牌玩家可以看闷牌玩家并按2倍支付', () => {
  const room = fundedRoom(500, 2);
  startGame(room, '1', () => 0);
  act(room, room.players[room.turn].id, 'call');
  act(room, room.players[room.turn].id, 'call');
  const challenger = room.players[room.turn];
  const target = room.players.find((player) => player.id !== challenger.id && !player.folded);
  act(room, challenger.id, 'see');
  const view = publicRoom(room, challenger.id);
  assert.equal(view.canCompare, true);
  const expectedCost = room.currentBet * 2;
  const reveal = showdown(room, challenger.id, target.id);
  assert.equal(reveal.cost, expectedCost);
});

test('明牌玩家与明牌玩家比牌按1倍支付', () => {
  const room = fundedRoom(500, 2);
  startGame(room, '1', () => 0);
  const firstPlayer = room.players[room.turn];
  act(room, firstPlayer.id, 'call');
  const secondPlayer = room.players[room.turn];
  act(room, secondPlayer.id, 'see');
  act(room, secondPlayer.id, 'call');
  const challenger = room.players[room.turn];
  const target = room.players.find((player) => player.id !== challenger.id && !player.folded);
  act(room, challenger.id, 'see');
  const expectedCost = room.currentBet;
  const view = publicRoom(room, challenger.id);
  assert.equal(view.compareCosts[target.id], expectedCost);
  const reveal = showdown(room, challenger.id, target.id);
  assert.equal(reveal.cost, expectedCost);
  const compareEntry = room.ledger.findLast((entry) => entry.playerId === challenger.id && entry.type === '比牌费用');
  assert.equal(compareEntry.amount, -expectedCost);
});

test('最终比牌后牌面保留到玩家点击下一局', () => {
  const room = fundedRoom();
  startGame(room, '1', () => 0);
  act(room, room.players[room.turn].id, 'call');
  act(room, room.players[room.turn].id, 'call');
  const challenger = room.players[room.turn];
  const target = room.players.find((item) => item.id !== challenger.id && !item.folded);
  act(room, challenger.id, 'see');
  showdown(room, challenger.id, target.id);
  assert.equal(room.status, 'waiting');
  assert.ok(room.reveal);
  assert.equal(room.reveal.expiresAt, null);
  assert.equal(room.winner.reason, '比牌获胜');
});

test('正常情况下未看牌玩家只能收到隐藏牌面', () => {
  const room = fundedRoom();
  startGame(room, '1', () => 0);
  assert.deepEqual(publicRoom(room, '2').players[1].hand, [null, null, null]);
  act(room, '2', 'see');
  assert.ok(publicRoom(room, '2').players[1].hand.every(Boolean));
  assert.deepEqual(publicRoom(room, '1').players[1].hand, [null, null, null]);
});

test('明牌玩家跟注后，闷牌玩家仍看不到对方牌面', () => {
  const room = fundedRoom(500, 2);
  startGame(room, '1', () => 0);
  const blindPlayer = room.players[room.turn];
  act(room, blindPlayer.id, 'call');
  const seenPlayer = room.players[room.turn];
  act(room, seenPlayer.id, 'see');
  act(room, seenPlayer.id, 'call');
  const blindView = publicRoom(room, blindPlayer.id);
  const seenOpponent = blindView.players.find((item) => item.id === seenPlayer.id);
  assert.equal(seenOpponent.seen, true);
  assert.deepEqual(seenOpponent.hand, [null, null, null]);
  const ownView = publicRoom(room, seenPlayer.id).players.find((item) => item.id === seenPlayer.id);
  assert.ok(ownView.hand.every(Boolean));
});

test('每台设备收到服务器确认的本人座位编号', () => {
  const room = fundedRoom();
  const firstView = publicRoom(room, '1');
  const secondView = publicRoom(room, '2');
  assert.equal(firstView.viewerId, '1');
  assert.equal(secondView.viewerId, '2');
  assert.ok(firstView.players.some((item) => item.id === firstView.viewerId));
  assert.ok(secondView.players.some((item) => item.id === secondView.viewerId));
});

test('筹码流水记录审批、底注、下注和获胜后的余额', () => {
  const room = fundedRoom(100, 2);
  startGame(room, '1', () => 0);
  const caller = room.players[room.turn];
  act(room, caller.id, 'call');
  const folder = room.players[room.turn];
  act(room, folder.id, 'fold');
  const types = room.ledger.map((entry) => entry.type);
  assert.equal(types.filter((type) => type === '筹码审批').length, 2);
  assert.equal(types.filter((type) => type === '底注').length, 2);
  assert.ok(types.includes('跟注'));
  assert.ok(types.includes('赢得筹码池'));
  assert.ok(room.ledger.every((entry) => Number.isFinite(entry.amount) && Number.isFinite(entry.balance)));
});

test('30秒超时进入托管并自动跟注', () => {
  const room = fundedRoom(500, 3);
  startGame(room, '1', () => 0);
  assert.equal(TURN_MS, 30_000);
  const timedOut = room.players[room.turn];
  const chipsBefore = timedOut.chips;
  assert.equal(expireTurn(room, room.turnDeadline + 1), true);
  assert.equal(timedOut.autoPlay, true);
  assert.equal(timedOut.folded, false);
  assert.equal(timedOut.chips, chipsBefore - room.currentBet);
  assert.ok(room.ledger.some((entry) => entry.playerId === timedOut.id && entry.type === '托管跟注'));
  assert.equal(room.status, 'playing');
});

test('托管跟注筹码不足时自动弃牌，掉线不会锁桌', () => {
  const room = fundedRoom(500, 3);
  startGame(room, '1', () => 0);
  const current = room.players[room.turn];
  current.chips = 0;
  disconnectPlayer(room, current.id);
  assert.ok(room.turnDeadline > Date.now() + 29_000, '掉线玩家每轮仍应有30秒');
  assert.equal(expireTurn(room, room.turnDeadline + 1), true);
  assert.equal(current.autoPlay, true);
  assert.equal(current.folded, true);
  assert.equal(room.status, 'playing');
});

test('玩家可以手动开启和取消托管', () => {
  const room = fundedRoom(500, 3);
  startGame(room, '1', () => 0);
  const current = room.players[room.turn];
  setTrustee(room, current.id, true);
  assert.equal(current.autoPlay, true);
  assert.ok(room.turnDeadline <= Date.now() + 500);
  setTrustee(room, current.id, false);
  assert.equal(current.autoPlay, false);
  assert.ok(room.turnDeadline > Date.now() + 29_000);
});

test('等待阶段真正离开并自动转让房主', () => {
  const room = fundedRoom();
  const result = leavePlayer(room, '1');
  assert.equal(result.removed, true);
  assert.equal(room.players.some((item) => item.id === '1'), false);
  assert.equal(room.ownerId, '2');
});

test('借贷未结清时双方都不能退出房间', () => {
  const room = fundedRoom();
  const request = requestBorrow(room, '2', '1', 100);
  reviewBorrowRequest(room, '1', request.id, true);
  assert.throws(() => leavePlayer(room, '1'), /结清/);
  assert.throws(() => leavePlayer(room, '2'), /结清/);
  repayBorrow(room, '2', room.debts[0].id, 100);
  assert.equal(leavePlayer(room, '2').removed, true);
});

test('实时房间状态不携带大体积流水和历史', () => {
  const room = fundedRoom();
  const view = publicRoom(room, '1');
  assert.deepEqual(view.ledger, []);
  assert.deepEqual(view.log, []);
  assert.deepEqual(view.history, []);
});

test('牌局中退出按弃牌处理并完成结算', () => {
  const room = fundedRoom();
  startGame(room, '1', () => 0);
  const leaving = room.players[room.turn];
  leavePlayer(room, leaving.id);
  assert.equal(room.status, 'waiting');
  assert.equal(room.players.some((item) => item.id === leaving.id), false);
  assert.ok(room.winner);
});
