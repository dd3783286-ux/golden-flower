export const RANK_NAMES = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J' };
export const SUITS = ['♠', '♥', '♣', '♦'];

export function createDeck() {
  return SUITS.flatMap((suit) => Array.from({ length: 13 }, (_, i) => ({ suit, rank: i + 2 })));
}

export function shuffle(deck, random = Math.random) {
  const cards = [...deck];
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function evaluateHand(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) throw new Error('需要三张牌');
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const flush = cards.every((c) => c.suit === cards[0].suit);
  let straightHigh = null;
  if (ranks[0] - ranks[1] === 1 && ranks[1] - ranks[2] === 1) straightHigh = ranks[0];
  if (ranks.join(',') === '14,3,2') straightHigh = 3;
  const counts = new Map();
  ranks.forEach((r) => counts.set(r, (counts.get(r) || 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  if (groups[0][1] === 3) return { category: 5, name: '豹子', tiebreak: [groups[0][0]] };
  if (flush && straightHigh) return { category: 4, name: '同花顺', tiebreak: [straightHigh] };
  if (flush) return { category: 3, name: '金花', tiebreak: ranks };
  if (straightHigh) return { category: 2, name: '顺子', tiebreak: [straightHigh] };
  if (groups[0][1] === 2) return { category: 1, name: '对子', tiebreak: [groups[0][0], groups[1][0]] };
  return { category: 0, name: '单张', tiebreak: ranks };
}

export function compareHands(a, b) {
  const ea = evaluateHand(a);
  const eb = evaluateHand(b);
  if (ea.category !== eb.category) return Math.sign(ea.category - eb.category);
  for (let i = 0; i < Math.max(ea.tiebreak.length, eb.tiebreak.length); i++) {
    if ((ea.tiebreak[i] || 0) !== (eb.tiebreak[i] || 0)) return Math.sign((ea.tiebreak[i] || 0) - (eb.tiebreak[i] || 0));
  }
  return 0;
}

export function isDifferentSuit235(cards) {
  return cards.map((c) => c.rank).sort((a, b) => a - b).join(',') === '2,3,5' && new Set(cards.map((c) => c.suit)).size === 3;
}

export function compareHandsWith235(a, b, enabled = true) {
  if (enabled) {
    const a235 = isDifferentSuit235(a), b235 = isDifferentSuit235(b);
    const aLeopard = evaluateHand(a).category === 5, bLeopard = evaluateHand(b).category === 5;
    if (a235 && bLeopard) return 1;
    if (b235 && aLeopard) return -1;
  }
  return compareHands(a, b);
}

export function cardText(card) {
  return `${card.suit}${RANK_NAMES[card.rank] || card.rank}`;
}
