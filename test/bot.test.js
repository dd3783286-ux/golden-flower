// test/bot.test.js — 机器人智能决策引擎测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseBotAction, estEquity, handStrength, nextLevel, potOdds } from '../src/botBrain.js';

// 异花色普通牌(避免误判同花/同花顺), 同花用 suited()
const offSuit = (ranks) => ranks.map((r, i) => ({ suit: ['♠', '♥', '♦'][i % 3], rank: r }));
const suited = (ranks, suit = '♥') => ranks.map((r) => ({ suit, rank: r }));
const always = (v) => () => v;

// 显式性格(不依赖名字哈希,测试稳定)
const P = {
  保守: { tag: '保守', bluff: 0.05, tight: 1.3 },
  均衡: { tag: '均衡', bluff: 0.10, tight: 1.0 },
  激进: { tag: '激进', bluff: 0.17, tight: 0.75 }
};

function base(overrides = {}) {
  return {
    seen: true,
    hand: offSuit([2, 4, 7]),
    chips: 1000,
    currentBet: 2,
    pot: 30,
    actionsInHand: 3,
    oppCount: 1,
    opponents: [{ bet: 4, seen: true }],
    canCompare: true,
    compareTargetIds: ['p2'],
    personality: P.均衡,
    ...overrides
  };
}

// ---------- 牌力评估 ----------
test('牌力强度单调:豹子>同花顺>金花>顺子>对子>单张', () => {
  assert.equal(handStrength(suited([7, 7, 7])), 0.99); // 豹子
  assert.ok(handStrength(suited([12, 13, 14])) > handStrength(suited([2, 9, 13]))); // 同花顺 > 金花
  assert.ok(handStrength(suited([2, 9, 13])) > handStrength(offSuit([3, 4, 5])));   // 金花 > 顺子
  assert.ok(handStrength(offSuit([3, 4, 5])) > handStrength(offSuit([9, 9, 2])));   // 顺子 > 对子
  assert.ok(handStrength(offSuit([9, 9, 2])) > handStrength(offSuit([2, 4, 7])));   // 对子 > 单张
});

test('豹子:同点数不同牌型,豹子恒最强', () => {
  assert.equal(handStrength(suited([7, 7, 7])), 0.99);
  assert.ok(handStrength(suited([7, 7, 7])) > handStrength(offSuit([9, 9, 2])));
});

// ---------- 赔率与胜率 ----------
test('底池赔率计算', () => {
  assert.equal(potOdds(10, 90), 0.1);
  assert.equal(potOdds(50, 50), 0.5);
});

test('胜率:牌越强越高,对手越多衰减', () => {
  assert.ok(estEquity(0.9, 1) > estEquity(0.5, 1));
  assert.ok(estEquity(0.7, 1) > estEquity(0.7, 3));
});

test('加注档位:高于当前档位且取偶', () => {
  assert.equal(nextLevel(2, 1), 4);
  assert.equal(nextLevel(2, 2), 4);
  assert.equal(nextLevel(10, 1), 12);
  assert.equal(nextLevel(20, 0), 22);
});

// ---------- 决策 ----------
test('豹子:价值加注(单挑时多数加注钓鱼,不弃)', () => {
  const d = chooseBotAction(base({ hand: suited([7, 7, 7]) }), always(0.7));
  assert.equal(d.action, 'raise');
  assert.ok(d.raiseTo > 2);
});

test('豹子单挑:小概率直接比牌清人', () => {
  const d = chooseBotAction(base({ hand: suited([7, 7, 7]) }), always(0.1));
  assert.equal(d.action, 'compare');
  assert.equal(d.targetId, 'p2');
});

test('金花:强牌主动加注', () => {
  const d = chooseBotAction(base({ hand: suited([2, 9, 13]) }), always(0.7));
  assert.equal(d.action, 'raise');
});

test('对子3人局:中牌控制,跟注为主,不主动加注不比牌', () => {
  const d = chooseBotAction(base({
    hand: offSuit([9, 9, 2]),
    oppCount: 3,
    opponents: [{ bet: 4, seen: true }, { bet: 2, seen: true }, { bet: 2, seen: true }]
  }), always(0.5));
  assert.equal(d.action, 'call');
});

test('对子被重注压(保守牌风):赔率差则弃牌', () => {
  const d = chooseBotAction(base({
    hand: offSuit([9, 9, 2]), currentBet: 100, pot: 120,
    opponents: [{ bet: 60, seen: true }], personality: P.保守
  }), always(0.5));
  assert.equal(d.action, 'fold');
});

test('烂单张+便宜跟注+多人:胜率衰减,弃牌', () => {
  const d = chooseBotAction(base({
    hand: offSuit([2, 4, 7]), oppCount: 3, pot: 10,
    opponents: [{ bet: 2, seen: true }, { bet: 2, seen: false }, { bet: 2, seen: false }]
  }), always(0.5));
  assert.equal(d.action, 'fold');
});

test('诈唬性格差异:同场景激进偷鸡,保守弃牌', () => {
  const weakCtx = base({
    hand: offSuit([2, 4, 7]), currentBet: 10, pot: 30,
    opponents: [{ bet: 2, seen: true }]
  });
  const tight = chooseBotAction({ ...weakCtx, personality: P.保守 }, always(0.1));
  const loose = chooseBotAction({ ...weakCtx, personality: P.激进 }, always(0.1));
  assert.equal(tight.action, 'fold');
  assert.equal(loose.action, 'raise');
});

test('弱牌被高额档位压:即使激进性格也不偷鸡(风险失控)', () => {
  const d = chooseBotAction(base({
    hand: offSuit([2, 4, 7]), currentBet: 200, pot: 60,
    opponents: [{ bet: 60, seen: true }], personality: P.激进
  }), always(0.01));
  assert.equal(d.action, 'fold');
});

test('闷牌:赔率正常时跟注为主(半价优势)', () => {
  const d = chooseBotAction(base({ seen: false, hand: [] }), always(0.5));
  assert.equal(d.action, 'call');
});

test('闷牌:底池够大且便宜时看牌获取信息', () => {
  const d = chooseBotAction(base({ seen: false, hand: [], pot: 80, currentBet: 10 }), always(0.1));
  assert.equal(d.action, 'see');
});

test('闷牌:档位极高且赔率差时弃牌止损', () => {
  const d = chooseBotAction(base({ seen: false, hand: [], currentBet: 200, pot: 50 }), always(0.1));
  assert.equal(d.action, 'fold');
});

test('筹码不足:绝大多数弃牌', () => {
  const d = chooseBotAction(base({ chips: 1, currentBet: 10 }), always(0.5));
  assert.equal(d.action, 'fold');
});

test('比牌目标:挑投入最凶的对手', () => {
  const d = chooseBotAction(base({
    hand: suited([7, 7, 7]),
    compareTargetIds: ['aggressive', 'passive'],
    opponents: [{ bet: 80, seen: true }, { bet: 4, seen: true }]
  }), always(0.1));
  assert.equal(d.action, 'compare');
  assert.equal(d.targetId, 'aggressive');
});

test('性格:保守牌风跟注门槛更高(同样边缘牌,保守弃、激进跟)', () => {
  const weakCtx = base({
    hand: offSuit([2, 4, 7]), currentBet: 30, pot: 60,
    opponents: [{ bet: 20, seen: true }]
  });
  const tight = chooseBotAction({ ...weakCtx, personality: P.保守 }, always(0.5));
  const loose = chooseBotAction({ ...weakCtx, personality: P.激进 }, always(0.5));
  assert.equal(tight.action, 'fold');
  assert.equal(loose.action, 'call');
});
