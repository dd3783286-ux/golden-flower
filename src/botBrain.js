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

// ---- 性格:三个机器人固定人设(用户指定),其他名字走默认均衡 ----
// blindSeeRound:闷牌到第几轮才强制决策看牌(潘5=闷3轮+、王1=首轮看牌、谢2=第二轮看牌)
// blindKeep:过了决策轮仍继续闷的概率(心理战/陪闷)
// bluff:偷鸡频率; tight:跟注门槛倍率(高=更挑牌)
export function botPersonality(name) {
  switch (String(name || '')) {
    case '潘':
      // 激进型·爱闷牌:闷牌至少三轮吊明牌(半价养池),偶尔偷鸡
      return { tag: '激进闷牌', bluff: 0.14, tight: 0.8, blindSeeRound: 5, blindKeep: 0.30 };
    case '王':
      // 保守型:首轮就看牌,有牌就上没牌就弃,偶尔偷鸡
      return { tag: '保守看牌', bluff: 0.06, tight: 1.4, blindSeeRound: 1, blindKeep: 0.08 };
    case '谢':
      // 平衡型:第一轮跟着闷,第二轮看牌,经常偷鸡,偶尔陪闷
      return { tag: '平衡偷鸡', bluff: 0.18, tight: 0.95, blindSeeRound: 2, blindKeep: 0.16 };
    default:
      return { tag: '均衡', bluff: 0.10, tight: 1.0, blindSeeRound: 3, blindKeep: 0.12 };
  }
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

  // ============ 闷牌:半价跟注 + 轮数控制(真人不会无限闷,搜证:开局闷2~3轮、单局闷≤4轮) ============
  if (!seen) {
    const po = potOdds(cost, pot);
    const blindRound = Math.floor(actionsInHand / Math.max(1, oppCount + 1)) + 1; // 当前第几轮
    // 1) 赔率差(成本占底池比例过高)且档位高:弃或看牌止损
    if (po > 0.5 && currentBet >= 60) return r < 0.5 ? { action: 'fold' } : { action: 'see' };
    // 2) 成本吃掉筹码一大块(>40%)且赔率一般:弃
    if (cost / chips > 0.4 && po > 0.3 && r < 0.45) return { action: 'fold' };
    // 3) 单挑连续平跟:小概率半价闷开赌一把(成本低,真人会这么干;概率低,不挡看牌决策)
    if (canCompare && oppCount <= 1 && r < 0.12 && actionsInHand >= 3) return pickCompare();
    // 4) 闷牌轮数控制(按性格):到 blindSeeRound 才强制决策——潘5=闷3轮+吊明牌,王1=首轮看,谢2=第二轮看
    const blindSee = pers.blindSeeRound || 3;
    if (blindRound >= blindSee) {
      const seeP = blindSee >= 4 ? 0.55 : 0.75; // 晚看牌的性格看牌概率略低(更爱继续闷)
      if (r < seeP) return { action: 'see' };
      if (r < seeP + 0.15) return { action: 'fold' };
      // 剩余概率按 blindKeep 继续闷(心理战/陪闷),兜底看牌绝不无限闷
      if (r < seeP + 0.15 + (pers.blindKeep ?? 0.12)) return { action: 'call' };
      return { action: 'see' };
    }
    // 5) 未到决策轮:半价闷跟/闷加注(吊明牌核心:便宜跟注撑底池,逼明牌玩家付全额)
    if (r < pers.bluff && currentBet < 80) {
      const level = nextLevel(currentBet, 2);
      if (chips >= Math.ceil(level / 2)) return { action: 'raise', raiseTo: level };
    }
    // 6) 默认:半价跟注
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
  // 连续平跟多轮无人加注 → 大家都跟烦了,该开牌终结(真人一圈没人开就会有人忍不住)
  const stall = actionsInHand >= Math.max(4, (oppCount + 1) * 2);

  // 1) 超强牌(豹子/同花顺/大金花):价值最大化,以钓鱼为主,但平跟久了果断开牌清人
  if (strength >= 0.85) {
    if (canCompare && compareTargetIds.length) {
      const clear = oppCount <= 1
        ? (r < (stall ? 0.65 : 0.45) && !threat)
        : (strength >= 0.95 ? r < (stall ? 0.5 : 0.3) : r < (stall ? 0.4 : 0.2));
      if (clear) return pickCompare();
    }
    const boost = strength >= 0.95 ? 3 + Math.floor(r * 5) : 2 + Math.floor(r * 4);
    const level = nextLevel(currentBet, boost);
    if (chips >= level) return { action: 'raise', raiseTo: level };
    return { action: 'call' };
  }

  // 2) 强牌(金花/顺子):主动加注压榨,随时开牌清人;对手刚加注时不比(钓鱼)
  if (eq > 0.58) {
    if (canCompare && compareTargetIds.length && oppCount <= 2 && r < (stall ? 0.8 : 0.55) && !threat) return pickCompare();
    if (r < 0.55) {
      const boost = strength >= 0.75 ? 2 + Math.floor(r * 3) : 1 + Math.floor(r * 2);
      const level = nextLevel(currentBet, boost);
      if (chips >= level) return { action: 'raise', raiseTo: level };
    }
    return { action: 'call' };
  }

  // 3) 中牌(对子/大单张):赔率够就跟,但绝不无限跟——要么开牌赌,要么弃;对手凶/威胁则收紧
  if (eq > po * pers.tight * 1.15) {
    if (canCompare && !threat) {
      if (oppCount <= 1 && eq > 0.5 && r < (stall ? 0.7 : 0.45)) return pickCompare();
      if (oppCount >= 2 && r < (stall ? 0.5 : 0.3)) return pickCompare();
    }
    if (r < 0.22 && !rich && !threat && currentBet < 80) {
      const level = nextLevel(currentBet, 1 + Math.floor(r * 2));
      if (chips >= level) return { action: 'raise', raiseTo: level };
    }
    // 多轮跟注后牌力未升级:中牌选择开牌或弃,不再干耗(真人跟几圈会烦)
    if (busy && r < 0.5) return canCompare && !threat ? pickCompare() : { action: 'fold' };
    return { action: 'call' };
  }

  // 4) 边缘牌:赔率勉强够 → 跟;对手凶/轮次多/刚加注 → 弃;单挑平跟久了小概率赌开
  if (eq > po * pers.tight) {
    if (canCompare && oppCount <= 1 && !threat && r < (stall ? 0.25 : 0.1)) return pickCompare();
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
