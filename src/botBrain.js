// src/botBrain.js
// 机器人智能决策引擎:牌力评估 + 底池赔率 + 对手读牌(含加注威胁) + 诈唬 + 性格差异
// 设计原则:
//  1. 闷牌时绝不使用手牌信息(不透视),靠"半价跟注"赔率优势决策
//  2. 看牌后按牌型强度分级行动:超强牌价值最大化(钓鱼) / 强牌压榨 / 中牌控制 / 弱牌弃+小概率偷鸡
//  3. 用底池赔率(需要胜率)与估算胜率对比决定跟/弃,严格比真人会算
//  4. 读人:对手刚加注(威胁) → 收紧自己或强牌钓鱼;对手整体投注凶 → 牌可能真大
//  5. 每个机器人有性格(保守/激进/均衡),牌风不同
import { evaluateHand } from './poker.js';

// ---- 牌力强度 0~1(锚定真实牌型胜率:豹子≈99% > 同花顺≈96% > 金花≈72~85% > 顺子≈62~72% > 对子≈52~62% > 单张≈22~48%) ----
export function handStrength(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) return 0;
  const { category, tiebreak } = evaluateHand(cards);
  const top = tiebreak[0] || 0;
  switch (category) {
    case 5: return 0.99;                      // 豹子
    case 4: return 0.96;                      // 同花顺
    case 3: return 0.70 + (top / 14) * 0.24;  // 金花
    case 2: return 0.56 + (top / 14) * 0.14;  // 顺子
    case 1: return 0.30 + (top / 14) * 0.28;  // 对子
    default: return 0.10 + (top / 14) * 0.34; // 单张(高牌更有价值)
  }
}

// ---- 面对 n 个对手的估算胜率(单挑基准 + 多人衰减) ----
export function estEquity(strength, oppCount) {
  const n = Math.max(1, oppCount);
  const eq1 = 0.12 + strength * 0.86; // 单挑胜率
  return Math.pow(eq1, n * 0.9);
}

// ---- 底池赔率:跟注需要的最低胜率 ----
export function potOdds(cost, pot) {
  const total = pot + cost;
  return total > 0 ? cost / total : 1;
}

// ---- 性格:由名字哈希派生,让每个机器人牌风不同 ----
export function botPersonality(name) {
  const seed = [...String(name || '')].reduce((acc, ch) => acc + ch.codePointAt(0), 0) % 3;
  return seed === 0
    ? { tag: '保守', bluff: 0.05, tight: 1.3 }   // 小美:稳健,少偷鸡,跟注门槛高
    : seed === 1
      ? { tag: '激进', bluff: 0.17, tight: 0.75 } // 阿强:凶,爱偷鸡,跟注门槛低
      : { tag: '均衡', bluff: 0.10, tight: 1.0 };  // 旺财:标准
}

// ---- 加注档位:高于当前档位且取偶(game.js 强制偶数,保证明=2×闷) ----
export function nextLevel(currentBet, boost) {
  let level = currentBet + Math.max(1, Math.floor(boost));
  if (level % 2 === 1) level += 1;
  return level;
}

// ---- 主决策:返回 { action: 'call'|'fold'|'raise'|'see'|'compare', raiseTo?, targetId? } ----
// ctx: {
//   seen, hand(仅 seen 时有效), chips, currentBet, pot, actionsInHand,
//   oppCount, opponents:[{bet,seen}], canCompare,
//   compareTargetIds(已按投入降序,首项=最凶对手), personality
// }
export function chooseBotAction(ctx, random = Math.random) {
  const {
    seen, hand, chips, currentBet, pot, actionsInHand,
    oppCount, opponents, canCompare, compareTargetIds, personality,
    threat = false
  } = ctx;
  const pers = personality || botPersonality('旺财');
  const r = random();

  const cost = seen ? currentBet : Math.ceil(currentBet / 2);

  // 筹码不足以跟注:绝大多数弃(极小概率比牌拼一把)
  if (chips < cost) return r < 0.08 && canCompare && compareTargetIds.length ? pickCompare() : { action: 'fold' };

  // ============ 闷牌:不知道牌力,靠半价优势与赔率 ============
  if (!seen) {
    const po = potOdds(cost, pot);
    // 赔率差(成本占底池比例过高)且档位高:弃或看牌止损
    if (po > 0.5 && currentBet >= 60) return r < 0.55 ? { action: 'fold' } : { action: 'see' };
    // 成本吃掉筹码一大块(>40%)且赔率一般:弃
    if (cost / chips > 0.4 && po > 0.3 && r < 0.45) return { action: 'fold' };
    // 底池够大、档位适中:看牌拿信息(闷牌半价看牌很划算)
    if (pot >= 40 && currentBet <= 30 && r < 0.3) return { action: 'see' };
    // 半价偷鸡:性格激进的多闷加注施压(成本只有一半,风险低)
    if (r < pers.bluff && currentBet < 80) {
      const level = nextLevel(currentBet, 2);
      if (chips >= Math.ceil(level / 2)) return { action: 'raise', raiseTo: level };
    }
    // 单挑连续平跟多轮:半价闷开赌一把(真人会这么干,成本低)
    if (canCompare && oppCount <= 1 && r < 0.15 && actionsInHand >= 4) return pickCompare();
    return { action: 'call' };
  }

  // ============ 明牌:牌力 + 赔率 + 读人 ============
  const strength = handStrength(hand);
  const eq = estEquity(strength, oppCount);
  const po = potOdds(cost, pot);
  // 对手读牌:对手平均投入占底池比例高 → 他们牌可能真强,收紧自己
  const oppAgg = opponents.reduce((sum, o) => sum + (o.bet || 0), 0) / Math.max(1, oppCount || 1);
  const rich = pot > 0 && oppAgg > pot * 0.35;
  const busy = actionsInHand >= Math.max(2, (oppCount + 1) * 2); // 多轮下注,牌力普遍抬升
  // 连续平跟多轮无人加注 → 大家都跟烦了,该开牌终结(真人心理)
  const stall = actionsInHand >= Math.max(4, (oppCount + 1) * 3);

  // 1) 超强牌(豹子/同花顺/大金花):价值最大化,以钓鱼为主,但平跟久了也该开牌清人
  if (strength >= 0.85) {
    if (canCompare && compareTargetIds.length) {
      const clear = oppCount <= 1
        ? (r < (stall ? 0.6 : 0.4) && !threat)
        : (strength >= 0.95 ? r < (stall ? 0.4 : 0.2) : r < (stall ? 0.25 : 0.08));
      if (clear) return pickCompare();
    }
    const boost = strength >= 0.95 ? 3 + Math.floor(r * 5) : 2 + Math.floor(r * 4);
    const level = nextLevel(currentBet, boost);
    if (chips >= level) return { action: 'raise', raiseTo: level };
    return { action: 'call' };
  }

  // 2) 强牌(金花/顺子):主动加注压榨;平跟久了直接开牌清人;对手刚加注时不比(钓鱼)
  if (eq > 0.58) {
    if (canCompare && compareTargetIds.length && oppCount <= 2 && r < (stall ? 0.7 : 0.45) && !threat) return pickCompare();
    if (r < 0.45) {
      const boost = strength >= 0.75 ? 2 + Math.floor(r * 3) : 1 + Math.floor(r * 2);
      const level = nextLevel(currentBet, boost);
      if (chips >= level) return { action: 'raise', raiseTo: level };
    }
    return { action: 'call' };
  }

  // 3) 中牌(对子/大单张):赔率够就跟;平跟久了会主动开牌赌对方更弱(真人常干);对手凶/威胁则收紧
  if (eq > po * pers.tight * 1.15) {
    if (canCompare && !threat) {
      if (oppCount <= 1 && eq > 0.5 && r < (stall ? 0.5 : 0.3)) return pickCompare();
      if (oppCount >= 2 && r < (stall ? 0.35 : 0.15)) return pickCompare();
    }
    if (r < 0.12 && !rich && !threat && currentBet < 80) {
      const level = nextLevel(currentBet, 1 + Math.floor(r * 2));
      if (chips >= level) return { action: 'raise', raiseTo: level };
    }
    return { action: 'call' };
  }

  // 4) 边缘牌:赔率勉强够 → 跟;对手凶/轮次多/刚加注 → 弃;单挑平跟久了小概率赌开
  if (eq > po * pers.tight) {
    if (canCompare && oppCount <= 1 && !threat && r < (stall ? 0.16 : 0.06)) return pickCompare();
    return rich || busy || threat ? { action: 'fold' } : { action: 'call' };
  }

  // 5) 弱牌:人少+便宜时小概率偷鸡,否则弃
  if (r < pers.bluff && oppCount <= 2 && currentBet < 60 && pot > 25) {
    const level = nextLevel(currentBet, 1);
    if (chips >= level) return { action: 'raise', raiseTo: level };
  }
  return { action: 'fold' };

  // 比牌挑投入最凶的对手(最大威胁/价值最大)
  function pickCompare() {
    return { action: 'compare', targetId: compareTargetIds[0] };
  }
}
