// tools/simulate-bot-game.mjs — 模拟三机器人全明牌对局,统计结束速度
import { act, addPlayer, makeRoom, setReady, showdown, startGame } from '../src/game.js';
import { botPersonality, chooseBotAction } from '../src/botBrain.js';

function runOneGame(seedFn = Math.random) {
  const room = makeRoom('SIM', { id: 'bot1', name: '潘', bot: true });
  addPlayer(room, { id: 'bot2', name: '谢', bot: true });
  addPlayer(room, { id: 'bot3', name: '王', bot: true });
  for (const p of room.players) { p.chips = 1000; setReady(room, p.id, true); }
  startGame(room, 'bot1', seedFn);
  // 所有人先看牌,然后循环决策直到牌局结束
  let actions = 0;
  while (room.status === 'playing' && actions < 200) {
    actions += 1;
    const bot = room.players[room.turn];
    if (!bot || bot.folded) { actions += 1; continue; }
    if (!bot.seen) {
      act(room, bot.id, 'see');
      actions += 1;
      const bot2 = room.players[room.turn];
      if (!bot2 || bot2.folded) continue;
    }
    const current = room.players[room.turn];
    if (!current || current.folded) continue;
    const active = room.players.filter((p) => !p.folded);
    const opponents = active.filter((p) => p.id !== current.id).sort((a, b) => b.bet - a.bet);
    const { canCompare, compareTargetIds } = (() => {
      const alive = room.players.filter((p) => !p.folded);
      const opps = alive.filter((p) => p.id !== current.id);
      const oppIds = opps.map((p) => p.id);
      // 简化:可比较条件同 game.js canCompare
      const ok = room.actionsInHand >= alive.length && alive.every((p) => p.seen);
      return { canCompare: ok, compareTargetIds: oppIds };
    })();
    const d = chooseBotAction({
      seen: current.seen,
      hand: current.hand,
      chips: current.chips,
      currentBet: room.currentBet,
      pot: room.pot,
      actionsInHand: room.actionsInHand,
      oppCount: opponents.length,
      opponents: opponents.map((o) => ({ bet: o.bet, seen: o.seen })),
      canCompare,
      compareTargetIds: opponents.filter((o) => compareTargetIds.includes(o.id)).map((o) => o.id),
      personality: botPersonality(current.name),
      threat: Boolean(room.lastAction?.type === 'raise' && room.lastAction.playerId !== current.id && !room.players.find((p) => p.id === room.lastAction.playerId)?.folded)
    }, seedFn);
    try {
      if (d.action === 'compare') showdown(room, current.id, d.targetId);
      else if (d.action === 'raise') act(room, current.id, 'raise', d.raiseTo);
      else act(room, current.id, d.action);
    } catch (e) {
      // 加注超筹码等异常:尝试跟注
      try { act(room, current.id, 'call'); } catch { /* 牌局可能已结束 */ }
    }
  }
  return { actions, status: room.status, winner: room.winner?.name || null, pot: room.pot };
}

// 跑200局统计
let total = 0, finished = 0, early = 0, maxActions = 0;
for (let i = 0; i < 200; i += 1) {
  const res = runOneGame();
  total += 1;
  if (res.status === 'waiting') { finished += 1; if (res.actions <= 30) early += 1; }
  maxActions = Math.max(maxActions, res.actions);
}
console.log(`200局: 结束${finished}局, 30手内结束${early}局, 最长${maxActions}手, 平均${(total / 200).toFixed(1)}局`);
