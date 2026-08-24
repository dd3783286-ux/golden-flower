import { compareHandsWith235, createDeck, evaluateHand, shuffle } from './poker.js';

export const MAX_PLAYERS = 10;
export const CHIP_AMOUNTS = [100, 200, 300, 500];
export const BET_LEVELS = [1, 2, 5, 10, 20, 50, 100, 200, 500];
// 下注支付额:档位即闷牌价,闷牌付档位全额,明牌付2倍(如档位5,闷付5,明付10)
export function betCost(stake, seen) {
  return seen ? stake * 2 : stake;
}
export const TURN_MS = 30_000;
const TRUSTEE_DELAY_MS = 300;
// 档位(闷牌价)最小值:闷牌起步2注,明牌付4(底注baseBet独立,发牌前每人扣1)
const MIN_BET = 2;

const now = () => Date.now();
const requestId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export function makeRoom(code, owner) {
  return {
    code,
    ownerId: owner.id,
    isPublic: true,
    status: 'waiting',
    baseBet: 1,
    currentBet: MIN_BET,
    pot: 0,
    turn: -1,
    round: 0,
    dealer: -1,
    lastDealerId: null,
    actionsInHand: 0,
    turnDeadline: null,
    special235: true,
    reveal: null,
    pendingCompare: null,
    lastAction: null,
    winner: null,
    createdAt: now(),
    updatedAt: now(),
    players: [makePlayer(owner)],
    chipRequests: [],
    borrowRequests: [],
    debts: [],
    ledger: [],
    history: [],
    log: [`${owner.name} 创建了房间`]
  };
}

function makePlayer(player) {
  return {
    id: player.id,
    name: player.name,
    avatar: player.avatar || '',
    bot: Boolean(player.bot),
    chips: 0,
    totalApproved: 0,
    borrowedIn: 0,
    lentOut: 0,
    connected: true,
    ready: false,
    folded: true,
    eliminatedByCompare: false,
    seen: false,
    bet: 0,
    hand: [],
    autoPlay: false,
    leaveAfterRound: false,
    lastSeenAt: now()
  };
}

function touch(room) {
  room.updatedAt = now();
  if (room.log?.length > 500) room.log = room.log.slice(-500);
  if (room.chipRequests?.length > 200) {
    room.chipRequests = [
      ...room.chipRequests.filter((request) => request.status === 'pending'),
      ...room.chipRequests.filter((request) => request.status !== 'pending').slice(-180)
    ].slice(-200);
  }
  if (room.borrowRequests?.length > 200) {
    room.borrowRequests = [
      ...room.borrowRequests.filter((request) => request.status?.startsWith('pending')),
      ...room.borrowRequests.filter((request) => !request.status?.startsWith('pending')).slice(-180)
    ].slice(-200);
  }
  return room;
}

function recordLedger(room, player, type, amount, note = '') {
  room.ledger ||= [];
  room.ledger.push({
    id: requestId('ledger'),
    at: now(),
    round: room.round,
    playerId: player.id,
    playerName: player.name,
    type,
    amount: Number(amount),
    balance: player.chips,
    note
  });
  if (room.ledger.length > 1000) room.ledger = room.ledger.slice(-1000);
}

function recordTableAction(room, player, type, { amount = 0, stake = 0, targetName = '', automated = false } = {}) {
  room.lastAction = {
    id: requestId('action'),
    at: now(),
    round: room.round,
    playerId: player.id,
    playerName: player.name,
    type,
    amount: Number(amount),
    stake: Number(stake),
    targetName,
    automated: Boolean(automated)
  };
}

export function addPlayer(room, player) {
  const existing = room.players.find((p) => p.id === player.id);
  if (existing) {
    existing.connected = true;
    existing.bot = Boolean(player.bot);
    existing.lastSeenAt = now();
    existing.leaveAfterRound = false;
    return touch(room), existing;
  }
  if (room.players.length >= MAX_PLAYERS) throw new Error('房间已满（最多10人）');
  if (room.status !== 'waiting') throw new Error('牌局进行中，请等待下一局');
  const added = makePlayer(player);
  room.players.push(added);
  room.log.push(`${player.name} 加入房间`);
  touch(room);
  return added;
}

export function setReady(room, playerId, ready) {
  ensureWaiting(room);
  const player = mustPlayer(room, playerId);
  if (ready && player.chips < room.baseBet) throw new Error('筹码不足，请先申请筹码');
  player.ready = Boolean(ready);
  room.log.push(`${player.name}${player.ready ? '已准备' : '取消准备'}`);
  touch(room);
  return player;
}

export function setTrustee(room, playerId, enabled) {
  if (room.status !== 'playing') throw new Error('开局后才能使用托管');
  const player = mustPlayer(room, playerId);
  if (player.folded && enabled) throw new Error('本局已经结束操作');
  player.autoPlay = Boolean(enabled);
  const index = room.players.findIndex((candidate) => candidate.id === playerId);
  if (index === room.turn) room.turnDeadline = now() + (player.autoPlay ? TRUSTEE_DELAY_MS : TURN_MS);
  room.log.push(`${player.name}${player.autoPlay ? '进入托管' : '取消托管'}`);
  touch(room);
  return player;
}

export function requestChips(room, playerId, amount) {
  ensureAmount(amount);
  const player = mustPlayer(room, playerId);
  if (room.chipRequests.some((r) => r.playerId === playerId && r.status === 'pending')) throw new Error('已有待审批申请');
  const request = { id: requestId('chip'), playerId, playerName: player.name, amount: Number(amount), status: 'pending', createdAt: now() };
  room.chipRequests.push(request);
  room.log.push(`${player.name} 申请增加 ${amount} 筹码`);
  touch(room);
  return request;
}

export function reviewChipRequest(room, ownerId, requestIdValue, approved) {
  if (room.ownerId !== ownerId) throw new Error('只有房主可以审批');
  const request = room.chipRequests.find((r) => r.id === requestIdValue && r.status === 'pending');
  if (!request) throw new Error('申请不存在或已处理');
  request.status = approved ? 'approved' : 'rejected';
  request.reviewedAt = now();
  if (approved) {
    const player = mustPlayer(room, request.playerId);
    player.chips += request.amount;
    player.totalApproved += request.amount;
    recordLedger(room, player, '筹码审批', request.amount, '房主批准增加筹码');
  }
  room.log.push(`房主${approved ? '同意' : '拒绝'}了 ${request.playerName} 的 ${request.amount} 筹码申请`);
  touch(room);
  return request;
}

export function requestBorrow(room, borrowerId, lenderId, amount) {
  ensureWaiting(room);
  ensureAmount(amount);
  if (borrowerId === lenderId) throw new Error('不能向自己借筹码');
  const borrower = mustPlayer(room, borrowerId);
  const lender = mustPlayer(room, lenderId);
  if (lender.chips < amount) throw new Error('出借人筹码不足');
  if (room.borrowRequests.some((r) => r.borrowerId === borrowerId && r.status.startsWith('pending'))) throw new Error('已有待处理借筹码申请');
  const request = {
    id: requestId('borrow'),
    borrowerId,
    borrowerName: borrower.name,
    lenderId,
    lenderName: lender.name,
    amount: Number(amount),
    status: 'pending_lender',
    createdAt: now()
  };
  room.borrowRequests.push(request);
  room.log.push(`${borrower.name} 向 ${lender.name} 申请借 ${amount} 筹码`);
  touch(room);
  return request;
}

export function reviewBorrowRequest(room, reviewerId, requestIdValue, approved) {
  ensureWaiting(room);
  const request = room.borrowRequests.find((r) => r.id === requestIdValue && r.status.startsWith('pending'));
  if (!request) throw new Error('借筹码申请不存在或已处理');

  if (request.status === 'pending_lender') {
    if (request.lenderId !== reviewerId) throw new Error('只有出借人可以先确认');
    if (!approved) {
      request.status = 'rejected';
      room.log.push(`${request.lenderName} 拒绝借给 ${request.borrowerName} ${request.amount} 筹码`);
    } else if (room.ownerId === reviewerId) {
      approveBorrow(room, request);
    } else {
      request.status = 'pending_owner';
      room.log.push(`${request.lenderName} 已同意，等待房主批准借款`);
    }
  } else {
    if (room.ownerId !== reviewerId) throw new Error('只有房主可以最终审批');
    if (!approved) {
      request.status = 'rejected';
      room.log.push(`房主拒绝了 ${request.borrowerName} 的借款申请`);
    } else {
      approveBorrow(room, request);
    }
  }
  request.reviewedAt = now();
  touch(room);
  return request;
}

function approveBorrow(room, request) {
  const lender = mustPlayer(room, request.lenderId);
  const borrower = mustPlayer(room, request.borrowerId);
  if (lender.chips < request.amount) throw new Error('出借人筹码不足');
  lender.chips -= request.amount;
  lender.lentOut += request.amount;
  borrower.chips += request.amount;
  borrower.borrowedIn += request.amount;
  recordLedger(room, lender, '借出筹码', -request.amount, `借给 ${borrower.name}`);
  recordLedger(room, borrower, '借入筹码', request.amount, `向 ${lender.name} 借入`);
  request.status = 'approved';
  const debt = { id: requestId('debt'), requestId: request.id, borrowerId: borrower.id, borrowerName: borrower.name, lenderId: lender.id, lenderName: lender.name, originalAmount: request.amount, outstanding: request.amount, createdAt: now() };
  room.debts.push(debt);
  room.log.push(`${lender.name} 借给 ${borrower.name} ${request.amount} 筹码，房主已批准`);
}

export function repayBorrow(room, borrowerId, debtId, amount) {
  ensureWaiting(room);
  ensureAmount(amount);
  const debt = room.debts.find((item) => item.id === debtId && item.borrowerId === borrowerId && item.outstanding > 0);
  if (!debt) throw new Error('没有可归还的借款');
  const borrower = mustPlayer(room, borrowerId);
  const lender = mustPlayer(room, debt.lenderId);
  const value = Number(amount);
  if (value > debt.outstanding) throw new Error('归还金额不能超过未还金额');
  if (borrower.chips < value) throw new Error('当前筹码不足以归还');
  borrower.chips -= value;
  borrower.borrowedIn -= value;
  lender.chips += value;
  lender.lentOut -= value;
  debt.outstanding -= value;
  debt.lastPaymentAt = now();
  recordLedger(room, borrower, '归还筹码', -value, `归还给 ${lender.name}`);
  recordLedger(room, lender, '收回借款', value, `${borrower.name} 归还`);
  room.log.push(`${borrower.name} 归还 ${lender.name} ${value} 筹码`);
  touch(room);
  return debt;
}

export function startGame(room, requesterId, random = Math.random) {
  if (room.ownerId !== requesterId) throw new Error('只有房主可以开局');
  ensureWaiting(room);
  // 房主发起开局时,如果自己忘了点准备,自动视为已准备并参与本局
  const requester = room.players.find((player) => player.id === requesterId);
  if (requester) requester.ready = true;
  const activeIndexes = room.players
    .map((player, index) => ({ player, index }))
    .filter(({ player }) => player.ready && player.chips >= room.baseBet && !player.leaveAfterRound)
    .map(({ index }) => index);
  if (activeIndexes.length < 2) {
    const unavailable = room.players.filter((player) => !player.leaveAfterRound && (!player.ready || player.chips < room.baseBet));
    const details = unavailable.map((player) => `${player.name}${player.chips < room.baseBet ? '筹码不足' : ''}${!player.ready ? `${player.chips < room.baseBet ? '且' : ''}未准备` : ''}`).join('、');
    const missing = Math.max(0, 2 - room.players.filter((player) => !player.leaveAfterRound).length);
    throw new Error(`还不能开局：${details || `还需${missing || 1}名玩家进入并准备`}`);
  }

  const deck = shuffle(createDeck(), random);
  room.status = 'playing';
  room.pot = 0;
  room.currentBet = MIN_BET; // 档位(闷牌价)初始2:闷牌起步2注,明牌付4
  room.round += 1;
  room.actionsInHand = 0;
  room.lastAction = null;
  room.winner = null;
  room.reveal = null;
  room.pendingCompare = null;
  room.players.forEach((player, index) => {
    player.folded = !activeIndexes.includes(index);
    player.eliminatedByCompare = false;
    player.seen = false;
    player.bet = 0;
    player.hand = player.folded ? [] : deck.splice(0, 3);
    if (!player.folded) {
      // 开局瞬间断线的已准备玩家不弃牌,进入托管自动跟注,重连后可恢复
      if (player.connected === false) player.autoPlay = true;
      player.chips -= room.baseBet;
      player.bet = room.baseBet;
      room.pot += room.baseBet;
      recordLedger(room, player, '底注', -room.baseBet, `第 ${room.round} 局`);
    }
  });

  const lastDealerIndex = room.players.findIndex((player) => player.id === room.lastDealerId);
  room.dealer = lastDealerIndex < 0 ? activeIndexes[Math.floor(random() * activeIndexes.length)] : nextEligibleIndex(room, lastDealerIndex, activeIndexes);
  room.lastDealerId = room.players[room.dealer].id;
  room.turn = nextActiveIndex(room, room.dealer);
  setTurnDeadline(room);
  room.log.push(`第 ${room.round} 局开始，${room.players[room.dealer].name} 坐庄，底注 ${room.baseBet}`);
  touch(room);
  return room;
}

export function act(room, playerId, action, raiseTo) {
  if (room.pendingCompare) throw new Error('正在等待比牌确认');
  const { player, index } = currentPlayer(room, playerId);
  player.autoPlay = false;
  if (action === 'see') {
    if (player.seen) throw new Error('已经看过牌');
    player.seen = true;
    recordTableAction(room, player, 'see');
    room.log.push(`${player.name} 看牌`);
    touch(room);
    return;
  }
  if (action === 'fold') {
    player.folded = true;
    recordTableAction(room, player, 'fold');
    room.log.push(`${player.name} 弃牌`);
    settleOrAdvance(room, index);
    touch(room);
    return;
  }
  if (action !== 'call' && action !== 'raise') throw new Error('未知操作');

  let stake = room.currentBet;
  if (action === 'raise') {
    stake = Number(raiseTo);
    // 加注规则:档位(闷牌价)必须高于当前档位(整数)。明牌加注到档位N付2N;闷牌加注到档位N付N,前端已换算
    if (!Number.isInteger(stake) || stake <= room.currentBet) throw new Error('加注需高于当前档位');
  }
  const cost = betCost(stake, player.seen);
  payExact(player, cost);
  recordLedger(room, player, action === 'raise' ? '加注' : '跟注', -cost, `${player.seen ? '明牌' : '闷牌'}，档位 ${stake}`);
  if (action === 'raise') room.currentBet = stake;
  player.bet += cost;
  room.pot += cost;
  room.actionsInHand += 1;
  recordTableAction(room, player, action, { amount: cost, stake });
  room.log.push(`${player.name}${action === 'raise' ? '加注' : '跟注'} ${cost}${player.seen ? '（明牌）' : '（闷牌）'}`);
  settleOrAdvance(room, index);
  touch(room);
}

export function showdown(room, playerId, targetId) {
  if (room.pendingCompare) throw new Error('已有待确认的比牌请求');
  const { player, index } = currentPlayer(room, playerId);
  player.autoPlay = false;
  const alive = room.players.filter((candidate) => !candidate.folded);
  if (!player.seen && alive.length > 2) throw new Error('多人牌局中闷牌不能主动比牌，请先看牌');
  if (!canCompare(room)) throw new Error('至少完成一轮下注后才能比牌');
  const target = room.players.find((candidate) => candidate.id === targetId && !candidate.folded && candidate.id !== playerId);
  if (!target) throw new Error('请选择仍在牌局中的对手');
  // 比牌费只按发起者状态计算：闷牌付档位、明牌付2倍，不因对手状态再次翻倍。
  const cost = comparisonCost(room, player, target);
  if (player.chips < cost) throw new Error(`筹码不足，需要 ${cost}`);
  if (alive.length > 2 && player.seen && target.seen) {
    const currentTime = now();
    room.pendingCompare = {
      id: requestId('compare'),
      challengerId: player.id,
      challengerName: player.name,
      targetId: target.id,
      targetName: target.name,
      cost,
      createdAt: currentTime,
      expiresAt: currentTime + 10_000,
      remainingTurnMs: Math.max(1_000, (room.turnDeadline || currentTime + TURN_MS) - currentTime)
    };
    room.turnDeadline = null;
    room.log.push(`${player.name} 向 ${target.name} 发起比牌，等待对方确认`);
    touch(room);
    return { pending: true, requestId: room.pendingCompare.id };
  }
  return resolveShowdown(room, player, index, target, cost);
}

export function reviewComparison(room, reviewerId, requestIdValue, approved) {
  const request = room.pendingCompare;
  if (!request || request.id !== requestIdValue) throw new Error('比牌请求不存在或已处理');
  if (request.targetId !== reviewerId) throw new Error('只有被比牌玩家可以确认');
  const challenger = mustPlayer(room, request.challengerId);
  const target = mustPlayer(room, request.targetId);
  const challengerIndex = room.players.findIndex((candidate) => candidate.id === challenger.id);
  if (challenger.folded || target.folded || challengerIndex !== room.turn) {
    cancelPendingComparison(room, '牌局状态已变化');
    throw new Error('比牌双方已不在有效牌局中');
  }
  room.pendingCompare = null;
  if (!approved) {
    room.turnDeadline = now() + Math.max(1_000, request.remainingTurnMs || TURN_MS);
    room.log.push(`${target.name} 拒绝了 ${challenger.name} 的比牌请求`);
    touch(room);
    return { approved: false };
  }
  return resolveShowdown(room, challenger, challengerIndex, target, request.cost);
}

export function expireComparisonRequest(room, currentTime = now()) {
  const request = room.pendingCompare;
  if (!request || currentTime < request.expiresAt) return false;
  room.pendingCompare = null;
  room.turnDeadline = currentTime + Math.max(1_000, request.remainingTurnMs || TURN_MS);
  room.log.push(`${request.targetName} 未在10秒内确认，${request.challengerName} 的比牌请求已取消`);
  touch(room);
  return true;
}

function resolveShowdown(room, player, index, target, cost) {
  payExact(player, cost);
  recordLedger(room, player, '比牌费用', -cost, `与 ${target.name} 比牌`);
  player.bet += cost;
  room.pot += cost;
  room.actionsInHand += 1;
  const result = compareHandsWith235(player.hand, target.hand, room.special235);
  const winner = result > 0 ? player : target;
  const loser = result > 0 ? target : player;
  loser.folded = true;
  loser.eliminatedByCompare = true;
  recordTableAction(room, player, 'compare', { amount: cost, stake: room.currentBet, targetName: target.name });
  room.reveal = {
    id: requestId('reveal'),
    expiresAt: now() + 3_000,
    challengerId: player.id,
    challengerName: player.name,
    challengerHand: player.hand,
    challengerType: evaluateHand(player.hand).name,
    targetId: target.id,
    targetName: target.name,
    targetHand: target.hand,
    targetType: evaluateHand(target.hand).name,
    winnerId: winner.id,
    winnerName: winner.name,
    loserId: loser.id,
    loserName: loser.name,
    cost
  };
  room.log.push(`${player.name} 支付 ${cost} 与 ${target.name} 比牌，${winner.name} 获胜，${loser.name} 淘汰`);
  settleOrAdvance(room, index, '比牌获胜');
  if (room.status === 'waiting') room.reveal.expiresAt = null;
  touch(room);
  return room.reveal;
}

export function canCompare(room) {
  const alive = room.players.filter((player) => !player.folded);
  if (room.actionsInHand < alive.length) return false;
  // 剩 2 人:允许比牌(闷开/明看闷);多人局:必须全员看牌后才能主动比牌
  if (alive.length <= 2) return true;
  return alive.every((player) => player.seen);
}

export function comparisonAvailability(room, playerId) {
  const player = room.players.find((candidate) => candidate.id === playerId);
  if (room.status !== 'playing' || !player || player.folded) return { canCompare: false, compareTargetIds: [], compareCosts: {}, compareHint: '不可比' };
  if (room.pendingCompare) return { canCompare: false, compareTargetIds: [], compareCosts: {}, compareHint: '等待确认' };
  const alive = room.players.filter((candidate) => !candidate.folded);
  const opponents = alive.filter((candidate) => candidate.id !== playerId);
  const compareCosts = Object.fromEntries(opponents.map((candidate) => [candidate.id, comparisonCost(room, player, candidate)]));
  if (!canCompare(room)) return { canCompare: false, compareTargetIds: [], compareCosts, compareHint: alive.length <= 2 ? '首轮后' : '所有人看牌后可比' };
  // 剩 2 人:发起者闷/明均可主动比牌
  if (alive.length <= 2) return { canCompare: opponents.length > 0, compareTargetIds: opponents.map((candidate) => candidate.id), compareCosts, compareHint: '' };
  // 多人局:自己必须已看牌
  if (!player.seen) return { canCompare: false, compareTargetIds: [], compareCosts, compareHint: '看牌后可比' };
  if (!opponents.every((candidate) => candidate.seen)) return { canCompare: false, compareTargetIds: [], compareCosts, compareHint: '所有人看牌后可比' };
  return { canCompare: opponents.length > 0, compareTargetIds: opponents.map((candidate) => candidate.id), compareCosts, compareHint: '' };
}

export function expireTurn(room, currentTime = now()) {
  if (room.pendingCompare) return false;
  if (room.status !== 'playing' || room.turn < 0 || !room.turnDeadline || currentTime < room.turnDeadline) return false;
  const player = room.players[room.turn];
  if (!player || player.folded) return false;
  const timedOut = !player.autoPlay;
  player.autoPlay = true;
  const cost = betCost(room.currentBet, player.seen);
  if (player.chips >= cost) {
    payExact(player, cost);
    recordLedger(room, player, '托管跟注', -cost, `${player.seen ? '明牌' : '闷牌'}，档位 ${room.currentBet}`);
    player.bet += cost;
    room.pot += cost;
    room.actionsInHand += 1;
    recordTableAction(room, player, 'call', { amount: cost, stake: room.currentBet, automated: true });
    room.log.push(timedOut ? `${player.name} 30秒未操作，进入托管并自动跟注 ${cost}` : `${player.name} 托管自动跟注 ${cost}`);
  } else {
    player.folded = true;
    recordTableAction(room, player, 'fold', { automated: true });
    room.log.push(`${player.name} 托管时筹码不足，自动弃牌`);
  }
  settleOrAdvance(room, room.turn);
  touch(room);
  return true;
}

export function disconnectPlayer(room, playerId) {
  const player = room.players.find((candidate) => candidate.id === playerId);
  if (!player) return false;
  player.connected = false;
  player.ready = false;
  if (room.status === 'playing' && !player.folded) {
    player.autoPlay = true;
    const index = room.players.findIndex((candidate) => candidate.id === playerId);
    if (index === room.turn) room.turnDeadline = now() + TURN_MS;
  }
  player.lastSeenAt = now();
  room.log.push(`${player.name} 暂时离线`);
  touch(room);
  return true;
}

export function leavePlayer(room, playerId) {
  const index = room.players.findIndex((player) => player.id === playerId);
  if (index < 0) return { removed: false, closed: false };
  const player = room.players[index];
  if (room.pendingCompare && [room.pendingCompare.challengerId, room.pendingCompare.targetId].includes(playerId)) {
    cancelPendingComparison(room, '玩家离开');
  }
  const unsettledDebt = room.debts?.some((debt) => debt.outstanding > 0 && (debt.borrowerId === playerId || debt.lenderId === playerId));
  if (unsettledDebt) throw new Error('请先结清借入或借出的筹码后再退出房间');
  room.chipRequests = (room.chipRequests || []).filter((request) => request.playerId !== playerId || request.status !== 'pending');
  room.borrowRequests = (room.borrowRequests || []).filter((request) => (
    request.borrowerId !== playerId && request.lenderId !== playerId
  ) || !request.status?.startsWith('pending'));
  if (room.status === 'playing' && !player.folded) {
    player.folded = true;
    recordTableAction(room, player, 'fold');
    player.leaveAfterRound = true;
    player.connected = false;
    room.log.push(`${player.name} 退出房间并自动弃牌`);
    settleOrAdvance(room, index);
  } else {
    room.players.splice(index, 1);
    if (room.dealer > index) room.dealer -= 1;
    room.log.push(`${player.name} 离开房间`);
  }
  transferOwner(room);
  touch(room);
  return { removed: true, closed: room.players.length === 0 };
}

function transferOwner(room) {
  if (room.players.some((player) => player.id === room.ownerId && !player.leaveAfterRound)) return;
  // 房主优先转给真人玩家,避免机器人当房主(机器人无法开局)
  const nextOwner = room.players.find((player) => !player.bot && player.connected && !player.leaveAfterRound)
    || room.players.find((player) => !player.bot && !player.leaveAfterRound)
    || room.players.find((player) => !player.leaveAfterRound);
  room.ownerId = nextOwner?.id || null;
  if (nextOwner) room.log.push(`${nextOwner.name} 成为新房主`);
}

function currentPlayer(room, playerId) {
  if (room.status !== 'playing') throw new Error('当前没有进行中的牌局');
  if (room.reveal && room.reveal.expiresAt > now()) throw new Error('正在展示比牌结果，请稍候');
  const index = room.players.findIndex((player) => player.id === playerId);
  if (index !== room.turn) throw new Error('还没轮到你');
  const player = room.players[index];
  if (player.folded) throw new Error('你已退出本局');
  return { player, index };
}

function payExact(player, amount) {
  if (player.chips < amount) throw new Error(`筹码不足，需要 ${amount}，不允许部分跟注`);
  player.chips -= amount;
}

function comparisonCost(room, player, target) {
  return betCost(room.currentBet, player.seen);
}

function cancelPendingComparison(room, reason) {
  const request = room.pendingCompare;
  if (!request) return;
  room.pendingCompare = null;
  room.turnDeadline = now() + Math.max(1_000, request.remainingTurnMs || TURN_MS);
  room.log.push(`${request.challengerName} 与 ${request.targetName} 的比牌请求已取消（${reason}）`);
}

function nextEligibleIndex(room, from, eligibleIndexes) {
  for (let offset = 1; offset <= room.players.length; offset += 1) {
    const index = (from + offset) % room.players.length;
    if (eligibleIndexes.includes(index)) return index;
  }
  return eligibleIndexes[0];
}

function nextActiveIndex(room, from) {
  for (let offset = 1; offset <= room.players.length; offset += 1) {
    const index = (from + offset) % room.players.length;
    if (!room.players[index].folded) return index;
  }
  return -1;
}

function settleOrAdvance(room, from, finishReason = '成为最后玩家') {
  const alive = room.players.filter((player) => !player.folded);
  if (alive.length === 1) return finish(room, alive[0], finishReason);
  room.turn = nextActiveIndex(room, from);
  setTurnDeadline(room);
}

function setTurnDeadline(room) {
  const player = room.players[room.turn];
  const fastTrustee = player?.autoPlay && player.connected !== false;
  room.turnDeadline = room.status === 'playing' && room.turn >= 0 ? now() + (fastTrustee ? TRUSTEE_DELAY_MS : TURN_MS) : null;
}

function finish(room, winner, reason = '成为最后玩家') {
  const won = room.pot;
  winner.chips += won;
  recordLedger(room, winner, '赢得筹码池', won, `第 ${room.round} 局获胜`);
  const result = {
    id: requestId('hand'),
    round: room.round,
    winnerId: winner.id,
    winnerName: winner.name,
    pot: won,
    reason,
    handType: winner.hand.length === 3 ? evaluateHand(winner.hand).name : '',
    at: now(),
    players: room.players.map((player) => ({ id: player.id, name: player.name, bet: player.bet, chips: player.chips }))
  };
  room.log.push(`${winner.name} 赢得 ${won} 筹码`);
  room.winner = result;
  room.history.unshift(result);
  room.history = room.history.slice(0, 30);
  room.status = 'waiting';
  room.pot = 0;
  room.turn = -1;
  room.turnDeadline = null;
  room.pendingCompare = null;
  room.players.forEach((player) => { player.ready = false; player.autoPlay = false; });
  room.players = room.players.filter((player) => !player.leaveAfterRound);
  transferOwner(room);
  touch(room);
}

function ensureWaiting(room) { if (room.status !== 'waiting') throw new Error('只能在两局之间操作'); }
function ensureAmount(amount) { if (!CHIP_AMOUNTS.includes(Number(amount))) throw new Error('金额只能选择100、200、300或500'); }
function mustPlayer(room, id) { const player = room.players.find((candidate) => candidate.id === id); if (!player) throw new Error('玩家不存在'); return player; }

export function publicRoom(room, viewerId) {
  const comparison = comparisonAvailability(room, viewerId);
  const revealIds = new Set(room.reveal ? [room.reveal.challengerId, room.reveal.targetId] : []);
  const canSeeComparison = revealIds.has(viewerId);
  const publicReveal = room.reveal ? {
    ...room.reveal,
    cardsVisible: canSeeComparison,
    challengerHand: canSeeComparison ? room.reveal.challengerHand : room.reveal.challengerHand.map(() => null),
    challengerType: canSeeComparison ? room.reveal.challengerType : null,
    targetHand: canSeeComparison ? room.reveal.targetHand : room.reveal.targetHand.map(() => null),
    targetType: canSeeComparison ? room.reveal.targetType : null
  } : null;
  const compareParticipant = room.pendingCompare && [room.pendingCompare.challengerId, room.pendingCompare.targetId].includes(viewerId);
  const publicPendingCompare = room.pendingCompare ? (compareParticipant ? room.pendingCompare : {
    id: room.pendingCompare.id,
    expiresAt: room.pendingCompare.expiresAt
  }) : null;
  return {
    ...room,
    ledger: [],
    log: [],
    history: [],
    reveal: publicReveal,
    pendingCompare: publicPendingCompare,
    viewerId,
    ...comparison,
    chipRequests: room.chipRequests.filter((request) => request.playerId === viewerId || room.ownerId === viewerId),
    borrowRequests: room.borrowRequests.filter((request) => request.borrowerId === viewerId || request.lenderId === viewerId || room.ownerId === viewerId),
    debts: room.debts.filter((debt) => debt.borrowerId === viewerId || debt.lenderId === viewerId || room.ownerId === viewerId),
    players: room.players.map((player) => ({
      ...player,
      hand: ((player.id === viewerId && player.seen) || (canSeeComparison && revealIds.has(player.id))) ? player.hand : player.hand?.map(() => null)
    }))
  };
}
