// test/bot.test.js — 机器人智能决策引擎测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botPersonality, chooseBotAction, estEquity, handStrength, nextLevel, potOdds } from '../src/botBrain.js';

// 异花色普通牌(避免误判同花/同花顺), 同花用 suited()
const offSuit = (ranks) => ranks.map((r, i) => ({ suit: ['♠', '♥', '♦'][i % 3], rank: r }));
const suited = (ranks, suit = '♥') => ranks.map((r) => ({ suit, rank: r }));
const always = (v) => () => v;

// 显式性格(不依赖名字哈希,测试稳定)
const P = {
  保守: { tag: '保守', bluff: 0.05, tight: 1.3, blindSeeRound: 1, blindKeep: 0.08 },
  均衡: { tag: '均衡', bluff: 0.10, tight: 1.0, blindSeeRound: 3, blindKeep: 0.12 },
  激进: { tag: '激进', bluff: 0.17, tight: 0.75, blindSeeRound: 4, blindKeep: 0.2 }
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

test('诈唬性格差异:同场景激进出手,保守弃牌', () => {
  const weakCtx = base({
    hand: offSuit([2, 4, 7]), currentBet: 20, pot: 30,
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
  const d = chooseBotAction(base({ seen: false, hand: [] }), always(0.55));
  assert.equal(d.action, 'call');
});

test('闷牌:底池够大且便宜时看牌获取信息', () => {
  const d = chooseBotAction(base({ seen: false, hand: [], pot: 80, currentBet: 10, actionsInHand: 8 }), always(0.2));
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

test('读人:对手刚加注(威胁)时,豹子不急着比牌,改加注钓鱼', () => {
  const d = chooseBotAction(base({ hand: suited([7, 7, 7]), threat: true }), always(0.1));
  assert.equal(d.action, 'raise'); // 0.1<0.4 但 threat → 不清人
  assert.ok(d.raiseTo > 2);
});

test('读人:对手刚加注(威胁)时,边缘牌力收紧弃牌', () => {
  const d = chooseBotAction(base({
    hand: offSuit([8, 8, 2]), currentBet: 50, pot: 50,
    opponents: [{ bet: 12, seen: true }], threat: true, personality: P.均衡
  }), always(0.5));
  assert.equal(d.action, 'fold');
});

test('读人:无威胁时同等边缘牌,赔率够则跟注', () => {
  const d = chooseBotAction(base({
    hand: offSuit([8, 8, 2]), currentBet: 50, pot: 50,
    opponents: [{ bet: 12, seen: true }], personality: P.均衡
  }), always(0.5));
  assert.equal(d.action, 'call');
});

test('多人平跟多轮(stall):中牌对子主动开牌终结,不再无限跟注', () => {
  const d = chooseBotAction(base({
    hand: offSuit([9, 9, 2]), oppCount: 3, actionsInHand: 15,
    opponents: [{ bet: 6, seen: true }, { bet: 6, seen: true }, { bet: 6, seen: true }],
    compareTargetIds: ['p2', 'p3', 'p4']
  }), always(0.1));
  assert.equal(d.action, 'compare');
});

test('多人平跟多轮(stall):金花主动比牌清人', () => {
  const d = chooseBotAction(base({
    hand: suited([2, 4, 6]), oppCount: 2, actionsInHand: 12,
    opponents: [{ bet: 5, seen: true }, { bet: 5, seen: true }],
    compareTargetIds: ['p2', 'p3']
  }), always(0.3));
  assert.equal(d.action, 'compare');
});

test('单挑平跟多轮:闷牌半价闷开赌一把', () => {
  const d = chooseBotAction(base({
    seen: false, hand: [], actionsInHand: 6, pot: 30,
    opponents: [{ bet: 4, seen: true }]
  }), always(0.1));
  assert.equal(d.action, 'compare');
});

test('闷牌第4轮起:70%概率看牌,不再无限闷(真实打法:单局闷≤4轮)', () => {
  const d = chooseBotAction(base({
    seen: false, hand: [], actionsInHand: 12, oppCount: 2, pot: 30,
    opponents: [{ bet: 2, seen: false }, { bet: 2, seen: false }]
  }), always(0.5));
  assert.equal(d.action, 'see'); // 0.5<0.7
});

test('闷牌第4轮起:20%概率止损弃牌', () => {
  const d = chooseBotAction(base({
    seen: false, hand: [], actionsInHand: 12, oppCount: 2, pot: 30,
    opponents: [{ bet: 2, seen: false }, { bet: 2, seen: false }]
  }), always(0.8));
  assert.equal(d.action, 'fold'); // 0.7<=0.8<0.9
});

test('闷牌第4轮起:仅10%继续闷跟(心理战),不会无限闷', () => {
  const d = chooseBotAction(base({
    seen: false, hand: [], actionsInHand: 12, oppCount: 2, pot: 30,
    opponents: [{ bet: 2, seen: false }, { bet: 2, seen: false }]
  }), always(0.95));
  assert.equal(d.action, 'call');
});

test('闷牌第2~3轮:底池值得时看牌获取信息', () => {
  const d = chooseBotAction(base({
    seen: false, hand: [], actionsInHand: 4, oppCount: 1, pot: 40,
    opponents: [{ bet: 4, seen: true }]
  }), always(0.2));
  assert.equal(d.action, 'see'); // 0.2>0.12不闷开, blindRound=3, seeP=0.75, 0.2<0.75
});

// ---------- 三机器人固定人设(用户指定) ----------
test('人设映射:潘=激进闷牌流(闷≥3轮),王=保守看牌流(首轮看),谢=平衡偷鸡流(第2轮看)', () => {
  const pan = botPersonality('潘');
  const wang = botPersonality('王');
  const xie = botPersonality('谢');
  assert.equal(pan.blindSeeRound, 5);
  assert.equal(pan.tag, '激进闷牌');
  assert.equal(wang.blindSeeRound, 1);
  assert.equal(wang.tag, '保守看牌');
  assert.equal(xie.blindSeeRound, 2);
  assert.equal(xie.tag, '平衡偷鸡');
  // 偷鸡频率:谢(常偷)>潘(偶偷)>王(偶偷最少)
  assert.ok(xie.bluff > pan.bluff && pan.bluff > wang.bluff);
  // 跟注门槛:王最高(有牌才上)
  assert.ok(wang.tight > xie.tight && xie.tight > pan.tight);
});

test('潘:闷牌前3轮不决策,继续闷着吊明牌', () => {
  const d = chooseBotAction(base({
    seen: false, hand: [], actionsInHand: 4, oppCount: 1, pot: 40,
    opponents: [{ bet: 4, seen: true }], personality: botPersonality('潘')
  }), always(0.9));
  assert.equal(d.action, 'call'); // blindRound=3 < 5, 闷着不出手
});

test('王:首轮就看牌(保守打法)', () => {
  const d = chooseBotAction(base({
    seen: false, hand: [], actionsInHand: 1, oppCount: 1, pot: 10,
    opponents: [{ bet: 2, seen: true }], personality: botPersonality('王')
  }), always(0.5));
  assert.equal(d.action, 'see'); // blindRound=1 >= 1 → 75%看牌
});

test('谢:第一轮跟着闷,第二轮看牌', () => {
  const d1 = chooseBotAction(base({
    seen: false, hand: [], actionsInHand: 1, oppCount: 1, pot: 10,
    opponents: [{ bet: 2, seen: true }], personality: botPersonality('谢')
  }), always(0.5));
  assert.equal(d1.action, 'call'); // 第一轮闷跟
  const d2 = chooseBotAction(base({
    seen: false, hand: [], actionsInHand: 3, oppCount: 1, pot: 20,
    opponents: [{ bet: 3, seen: true }], personality: botPersonality('谢')
  }), always(0.5));
  assert.equal(d2.action, 'see'); // 第二轮看牌
});
