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
}

function viewerId() { return room?.viewerId || me?.id; }

async function init() {
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
    } else {
      showScreen('#login');
    }
    const invitedRoom = new URLSearchParams(location.search).get('room');
    if (invitedRoom) $('#roomCode').value = invitedRoom.slice(0, 6);
  } catch {
    toast('页面连接失败，请刷新重试');
  }
}

function connect() {
  socket?.disconnect();
  socket = io();
  socket.on('connect', () => {
    setNetwork(true);
    const code = new URLSearchParams(location.search).get('room')?.slice(0, 6);
    if (!code) return;
    socket.timeout(5_000).emit('join-room', { code }, (timeoutError, response) => {
      if (timeoutError || !response?.ok) return toast(response?.error || '恢复房间失败，请重新加入');
      showScreen('#table');
    });
  });
  socket.on('disconnect', () => setNetwork(false));
  socket.on('connect_error', () => setNetwork(false));
  socket.on('room', (state) => {
    const potIncreased = room && state.pot > previousPot;
    const nextTurnKey = `${state.round}:${state.turn}`;
    if (nextTurnKey !== lastTurnKey) raiseOpen = false;
    lastTurnKey = nextTurnKey;
    room = state;
    previousPot = state.pot;
    render();
    if (potIncreased) animateChip();
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

$('#logout').onclick = () => confirmAction('切换账号', '将退出当前登录账号，确定继续吗？', async () => {
  if (room) return toast('请先退出房间');
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/';
});

$('#create').onclick = () => emit('create-room', {}, (response) => {
  history.replaceState(null, '', `/?room=${response.code}`);
  showScreen('#table');
});
$('#joinForm').onsubmit = (event) => {
  event.preventDefault();
  const code = $('#roomCode').value.trim();
  emit('join-room', { code }, () => {
    history.replaceState(null, '', `/?room=${code}`);
    showScreen('#table');
  });
};

function render() {
  if (!room || !me) return;
  showScreen('#table');
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
  renderPlayers();
  renderHand(mine);
  renderActions(mine, turnPlayer);
  renderBadge();
  renderCompare();
  renderWinner();
  renderTrustee(mine);
}

function renderPlayers() {
  const playerCount = room.players.length;
  const newDeal = room.status === 'playing' && room.round > lastAnimatedRound;
  const myIndex = room.players.findIndex((player) => player.id === viewerId());
  const layout = seatLayouts[playerCount] || seatLayouts[10];
  $('#players').innerHTML = room.players.map((player, index) => {
    const relativeIndex = (index - myIndex + playerCount) % playerCount;
    const seatIndex = layout[relativeIndex] ?? 5;
    const [x, y] = seatPositions[seatIndex];
    const isTurn = room.turn === index && room.status === 'playing';
    const state = player.connected === false ? (player.autoPlay ? '离线 · 托管' : '离线') : room.status === 'playing' && player.autoPlay ? (player.folded ? '托管 · 已弃牌' : '托管中') : room.status === 'playing' && player.folded ? (player.eliminatedByCompare ? '比牌淘汰' : '已弃牌') : room.status === 'waiting' ? (player.ready ? '已准备' : player.chips < room.baseBet ? '需筹码' : '未准备') : player.seen ? '已看牌' : '';
    const isMe = player.id === viewerId();
    const showOpponentCards = room.status === 'playing' && !isMe && !player.folded;
    const classes = [isTurn ? 'turn' : '', player.connected === false ? 'offline' : '', player.folded && room.status === 'playing' ? 'folded' : '', player.autoPlay ? 'trustee' : '', seatIndex === 0 ? 'top-seat' : '', `seat-${seatIndex}`, isMe ? 'me' : ''].join(' ');
    return `<div class="player-seat ${classes}" style="--x:${x};--y:${y}" data-player-id="${esc(player.id)}">
      ${state ? `<span class="seat-state">${state}</span>` : ''}
      <div class="avatar">${isTurn ? '<span class="turn-time" id="turnCountdown"></span><b class="turn-seconds" id="turnSeconds">30</b>' : esc(player.name.slice(0, 1))}${index === room.dealer ? '<span class="seat-badge">庄</span>' : ''}</div>
      <div class="seat-name">${esc(player.name)}</div><b class="seat-chips">${player.chips}</b>
      ${showOpponentCards ? `<div class="opponent-cards ${newDeal ? 'deal' : ''}" aria-label="三张未公开的牌"><i></i><i></i><i></i></div>` : ''}
    </div>`;
  }).join('');
  updateCountdown();
}

function renderHand(mine) {
  const newDeal = room.status === 'playing' && room.round > lastAnimatedRound;
  if (newDeal) lastAnimatedRound = room.round;
  if (room.round !== lastSeenRound) {
    lastSeenRound = room.round;
    lastSeenState = false;
  }
  const revealNow = room.status === 'playing' && Boolean(mine?.seen) && !lastSeenState;
  if (mine?.seen) lastSeenState = true;
  const cards = mine?.hand || [];
  $('#cards').classList.toggle('revealed', Boolean(mine?.seen));
  $('#cards').innerHTML = cards.map((card, index) => card
    ? cardHtml(card, revealNow ? 'flip' : '', `--i:${index}`)
    : cardHtml(null, newDeal ? 'deal' : '', `--i:${index}`)).join('');
  if (room.status !== 'playing') $('#handState').textContent = mine?.ready ? '已准备，等待房主开局' : '准备后等待开局';
  else if (mine?.folded) $('#handState').textContent = mine.eliminatedByCompare ? '本局已比牌淘汰' : '本局已弃牌';
  else $('#handState').textContent = mine?.seen ? `明牌 · 跟注 ${room.currentBet * 2}` : `闷牌 · 跟注 ${room.currentBet}`;
  $('#myStats').textContent = mine ? `我的筹码 ${mine.chips} · 本局已下 ${mine.bet}` : '';
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
    const summary = available.length >= 2 ? `${available.length}人已准备，可以开局` : `${room.players.length}人在线 · ${available.length}人已准备`;
    const readyDetail = blockers.length ? `<div class="ready-detail">还需 ${blockers.map(esc).join('；')}</div>` : '';
    const ownPending = (room.chipRequests || []).find((request) => request.playerId === viewerId() && request.status === 'pending');
    const quickChips = mine.chips < room.baseBet ? ownPending
      ? `<div class="quick-notice">已申请 ${ownPending.amount} 筹码，等待房主批准</div>`
      : `<div class="quick-chips"><b>先申请筹码：</b>${CHIP_AMOUNTS.map((amount) => `<button data-quick-chip="${amount}">+${amount}</button>`).join('')}</div>` : '';
    const quickReviews = room.ownerId === viewerId() ? (room.chipRequests || []).filter((request) => request.status === 'pending').map((request) => `<div class="quick-review"><span>${esc(request.playerName)}申请${request.amount}</span><button data-quick-review="${request.id}" data-ok="1">同意</button><button data-quick-review="${request.id}" data-ok="0">拒绝</button></div>`).join('') : '';
    $('#waitingBar').innerHTML = `<div class="ready-summary">${esc(summary)}</div>${readyDetail}${quickChips}${quickReviews}<div class="ready-buttons"><button id="readyButton" class="${mine?.ready ? '' : 'primary'}" ${mine.chips < room.baseBet ? 'disabled' : ''}>${mine.chips < room.baseBet ? '筹码到账后准备' : readyLabel}</button>${room.ownerId === viewerId() ? `<button id="startButton" class="primary" ${available.length < 2 ? 'disabled' : ''}>${available.length < 2 ? '等待玩家就绪' : '开始游戏'}</button>` : '<span>等待房主开始</span>'}</div>`;
    $('#readyButton').onclick = () => emit('set-ready', { code: room.code, ready: !mine.ready });
    if ($('#startButton')) $('#startButton').onclick = () => emit('start-game', { code: room.code });
    $('#waitingBar').querySelectorAll('[data-quick-chip]').forEach((button) => button.onclick = () => emit('request-chips', { code: room.code, amount: Number(button.dataset.quickChip) }, () => toast('申请已提交，等待房主批准')));
    $('#waitingBar').querySelectorAll('[data-quick-review]').forEach((button) => button.onclick = () => emit('review-chips', { code: room.code, requestId: button.dataset.quickReview, approved: button.dataset.ok === '1' }, () => toast(button.dataset.ok === '1' ? '筹码已批准' : '申请已拒绝')));
    $('#actions').innerHTML = '';
    return;
  }

  const mineTurn = turnPlayer?.id === viewerId() && !mine?.folded;
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
  const activePlayers = room.players.filter((player) => !player.folded);
  const compareReady = Boolean(room.canCompare) || (room.actionsInHand >= activePlayers.length && (mine.seen || activePlayers.length === 2));
  const nextLevel = BET_LEVELS.find((level) => level > room.currentBet);
  if (raiseOpen) {
    const levels = BET_LEVELS.filter((level) => level > room.currentBet && mine.chips >= level * factor);
    $('#actions').classList.add('raise-picker');
    $('#actions').innerHTML = `<button data-raise-back>返回</button>${levels.map((level) => `<button data-raise-level="${level}" class="main-action">加到${level}<small>支付${level * factor}</small></button>`).join('')}`;
    $('#actions').querySelector('[data-raise-back]').onclick = () => { raiseOpen = false; renderActions(mine, turnPlayer); };
    $('#actions').querySelectorAll('[data-raise-level]').forEach((button) => button.onclick = () => {
      const level = Number(button.dataset.raiseLevel);
      emit('action', { code: room.code, action: 'raise', raiseTo: level }, () => { raiseOpen = false; toast(`已加注到 ${level}`); });
    });
    return;
  }
  $('#actions').innerHTML = `
    <button data-action="fold" class="danger">弃牌</button>
    <button data-action="see" ${mine.seen ? 'disabled' : ''}>看牌</button>
    <button data-action="call" class="main-action" ${mine.chips < callCost ? 'disabled' : ''}>跟注<small>${callCost}</small></button>
    <button data-action="raise" ${!nextLevel || mine.chips < nextLevel * factor ? 'disabled' : ''}>加注<small>选择档位</small></button>
    <button type="button" data-action="compare" class="compare-action" ${!compareReady || mine.chips < callCost ? 'disabled' : ''}>比牌<small>${compareReady ? callCost : (room.compareHint || '不可比')}</small></button>`;
  $('#actions').querySelectorAll('[data-action]').forEach((button) => button.onclick = () => handleAction(button.dataset.action));
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
  button.disabled = room.status !== 'playing' || (!active && mine?.folded);
}

$('#trusteeButton').onclick = () => {
  const mine = room?.players.find((player) => player.id === viewerId());
  if (!mine || room.status !== 'playing') return toast('开局后才能使用托管');
  emit('set-trustee', { code: room.code, enabled: !mine.autoPlay }, () => toast(mine.autoPlay ? '已取消托管' : '已进入托管'));
};

function showRaiseSheet() {
  const mine = room.players.find((player) => player.id === viewerId());
  const factor = mine.seen ? 2 : 1;
  const levels = BET_LEVELS.filter((level) => level > room.currentBet);
  showSheet(`<h3>选择加注档位</h3><p class="meta">${mine.seen ? '明牌支付档位的2倍' : '闷牌按档位支付'}</p><div class="choice-grid">${levels.map((level) => `<button data-raise="${level}" ${mine.chips < level * factor ? 'disabled' : ''}>${level}<small>付${level * factor}</small></button>`).join('')}</div>`);
  $('#sheetContent').querySelectorAll('[data-raise]').forEach((button) => button.onclick = () => {
    const level = Number(button.dataset.raise);
    button.disabled = true;
    button.textContent = '提交中';
    emit('action', { code: room.code, action: 'raise', raiseTo: level }, () => { closeSheet(); toast(`已加注到 ${level}`); });
  });
}

function showCompareTargets() {
  const allowedTargets = new Set(room.compareTargetIds || []);
  const activeOpponents = room.players.filter((player) => !player.folded && player.id !== viewerId());
  const choices = room.players.filter((player) => allowedTargets.has(player.id));
  if (!choices.length && activeOpponents.length === 1) choices.push(activeOpponents[0]);
  if (choices.length === 1) {
    const target = choices[0];
    return confirmAction('确认比牌', `确定与“${target.name}”比牌吗？牌面仅比牌双方可见。`, () => emit('action', { code: room.code, action: 'compare', targetId: target.id }));
  }
  showSheet(`<h3>选择比牌对手</h3><p class="meta">只有比牌双方能看到牌面，其他玩家只能看到胜负结果。</p>${choices.map((player) => `<button class="player-choice" data-target="${esc(player.id)}"><span class="avatar-small">${esc(player.name[0])}</span>${esc(player.name)} · ${player.chips}筹码</button>`).join('')}`);
  $('#sheetContent').querySelectorAll('[data-target]').forEach((button) => button.onclick = () => {
    const target = room.players.find((player) => player.id === button.dataset.target);
    closeSheet();
    confirmAction('确认比牌', `确定与“${target?.name || '该玩家'}”比牌吗？牌面仅比牌双方可见。`, () => emit('action', { code: room.code, action: 'compare', targetId: button.dataset.target }));
  });
}

function renderCompare() {
  const reveal = room.reveal;
  const visible = reveal && reveal.id !== dismissedRevealId;
  $('#compareOverlay').classList.toggle('hidden', !visible);
  if (!visible) return;
  const side = (name, cards, type, id) => `<div class="compare-side ${id === reveal.winnerId ? 'winner' : 'loser'}"><b>${esc(name)}</b><div class="mini-cards">${cards.map((card) => cardHtml(card)).join('')}</div><strong>${esc(type || '牌面保密')}</strong></div>`;
  $('#compareHands').innerHTML = side(reveal.challengerName, reveal.challengerHand, reveal.challengerType, reveal.challengerId) + side(reveal.targetName, reveal.targetHand, reveal.targetType, reveal.targetId);
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
  if (room.reveal || room.winner.id === lastWinnerId) return;
  lastWinnerId = room.winner.id;
  $('#resultTitle').textContent = `${room.winner.winnerName} 赢得本局`;
  $('#resultText').textContent = `获得筹码池 ${room.winner.pot}`;
  $('#resultRows').innerHTML = room.winner.players.map((player) => `<div class="result-row"><span>${esc(player.name)} · 本局下注 ${player.bet}</span><b>${player.chips}</b></div>`).join('');
  $('#resultOverlay').classList.remove('hidden');
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
  if (room.status !== 'waiting') html += '<div class="sheet-section">牌局进行中，筹码操作将在本局结束后开放。</div>';
  else {
    const ownPending = (room.chipRequests || []).find((request) => request.playerId === viewerId() && request.status === 'pending');
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

$('#logButton').onclick = () => showLedger();

function showLedger(selectedPlayer = 'all') {
  const ledger = room.ledger || [];
  const filtered = selectedPlayer === 'all' ? ledger : ledger.filter((entry) => entry.playerId === selectedPlayer);
  const summaries = room.players.map((player) => {
    const entries = ledger.filter((entry) => entry.playerId === player.id);
    const income = entries.filter((entry) => entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0);
    const expense = entries.filter((entry) => entry.amount < 0).reduce((sum, entry) => sum - entry.amount, 0);
    return `<div class="ledger-summary"><b>${esc(player.name)}</b><span>收入 +${income}</span><span>支出 -${expense}</span><strong>余额 ${player.chips}</strong></div>`;
  }).join('');
  const filters = [`<button data-ledger-player="all" class="${selectedPlayer === 'all' ? 'active' : ''}">全部</button>`, ...room.players.map((player) => `<button data-ledger-player="${esc(player.id)}" class="${selectedPlayer === player.id ? 'active' : ''}">${esc(player.name)}</button>`)].join('');
  const rows = filtered.slice(-200).reverse().map((entry) => {
    const sign = entry.amount > 0 ? '+' : '';
    const time = new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return `<div class="ledger-row"><div><b>${esc(entry.playerName)}</b><span>${entry.round ? `第${entry.round}局 · ` : ''}${esc(entry.type)} · ${time}</span><small>${esc(entry.note || '')}</small></div><div class="ledger-money ${entry.amount >= 0 ? 'plus' : 'minus'}"><b>${sign}${entry.amount}</b><span>余额 ${entry.balance}</span></div></div>`;
  }).join('') || '<p class="empty-ledger">暂无筹码流水</p>';
  const events = room.log.slice(-30).reverse().map((line) => `<div class="event-line">${esc(line)}</div>`).join('') || '<p>暂无事件记录</p>';
  showSheet(`<h3>牌局记录</h3><div class="ledger-summaries">${summaries}</div><div class="ledger-filters">${filters}</div><div class="ledger-list">${rows}</div><details class="event-details"><summary>查看事件记录</summary>${events}</details>`);
  $('#sheetContent').querySelectorAll('[data-ledger-player]').forEach((button) => button.onclick = () => showLedger(button.dataset.ledgerPlayer));
}
$('#rulesButton').onclick = showRules;
$('#tableRulesButton').onclick = showRules;
function showRules() {
  showSheet(`<h3>房间规则</h3><ol class="rules-list"><li>每局底注1，第一局随机庄家，以后顺时针轮庄，庄家下家先操作。</li><li>闷牌按当前档位支付；看牌免费且不换人，看牌后下注为2倍。</li><li>加注档位：1、2、5、10、20、50、100、200、500。</li><li>完成第一轮下注后可以比牌；明牌发起支付2倍，闷牌发起支付1倍。闷牌只有在剩两名玩家时才能主动比牌，包括双方都闷牌的“闷开”。</li><li>比牌牌面仅比牌双方可见，其他玩家只能看到胜负结果；普通弃牌不公开。</li><li>牌型：豹子＞顺金＞金花＞顺子＞对子＞散牌。A23为最小顺子，花色不分大小。</li><li>不同花色235只在遇到豹子时获胜；完全同牌时主动比牌者输。</li><li>每次操作限时30秒，超时或离线后进入托管并自动跟注；明牌按2倍跟注，筹码不足时自动弃牌。</li></ol>`);
}

$('#leave').onclick = () => confirmAction('退出房间', room?.status === 'playing' ? '退出后将自动弃牌，并在本局结束后离开房间。' : '确定退出当前房间吗？', async () => {
  const response = await fetch('/api/leave-room', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: room.code }) });
  const data = await response.json();
  if (!response.ok) return toast(data.error || '退出失败，请重试');
  room = null;
  previousPot = 0;
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
  const link = `${location.origin}/?room=${room.code}`;
  const text = `我在“三张牌”房间 ${room.code} 等你：${link}`;
  try {
    if (navigator.share) await navigator.share({ title: '三张牌', text, url: link });
    else await navigator.clipboard.writeText(text);
    toast('邀请信息已准备好');
  } catch (error) {
    if (error.name !== 'AbortError') showSheet(`<h3>邀请好友</h3><p>房间号：<b>${room.code}</b></p><input value="${esc(link)}" readonly onclick="this.select()"><p class="meta">长按上面的链接复制后发送给好友。</p>`);
  }
};

function showSheet(html) {
  $('#sheetContent').innerHTML = html;
  $('#sheetBackdrop').classList.remove('hidden');
}
function closeSheet() { $('#sheetBackdrop').classList.add('hidden'); }
$('#closeSheet').onclick = closeSheet;
$('#sheetBackdrop').onclick = (event) => { if (event.target === $('#sheetBackdrop')) closeSheet(); };

function confirmAction(title, text, onConfirm) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOverlay').classList.remove('hidden');
  $('#confirmOk').onclick = () => { $('#confirmOverlay').classList.add('hidden'); onConfirm(); };
}
$('#confirmCancel').onclick = () => $('#confirmOverlay').classList.add('hidden');
$('#closeResult').onclick = () => $('#resultOverlay').classList.add('hidden');

function animateChip() {
  const chip = $('#chipFlight');
  chip.classList.remove('hidden');
  chip.textContent = room.currentBet;
  setTimeout(() => chip.classList.add('hidden'), 600);
}

function updateCountdown() {
  const ring = $('#turnCountdown');
  if (!ring || !room?.turnDeadline) return;
  const remaining = Math.max(0, room.turnDeadline - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  ring.style.setProperty('--progress', Math.min(100, Math.round(remaining / 30_000 * 100)));
  ring.parentElement.title = `${seconds}秒`;
  const label = $('#turnSeconds');
  if (label) label.textContent = seconds;
}
setInterval(updateCountdown, 250);

function cardHtml(card, extraClass = '', inlineStyle = '') {
  const className = `card ${card ? '' : 'back'} ${extraClass}`.trim();
  const fileName = card ? cardAssetName(card) : 'blueBack.svg';
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
