import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('标准英美牌组包含52张牌和统一牌背', () => {
  const cardsDirectory = path.join(__dirname, '..', 'public', 'assets', 'cards-standard');
  const suits = ['c', 'd', 'h', 's'];
  const ranks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

  for (const suit of suits) {
    for (const rank of ranks) {
      const file = path.join(cardsDirectory, `${rank}${suit}.svg`);
      assert.ok(fs.existsSync(file), `缺少牌面：${rank}${suit}.svg`);
      const svg = fs.readFileSync(file, 'utf8');
      assert.match(svg, /<svg\b/);
      assert.ok(/viewBox="0 0 [^"]+"/.test(svg) || (/width="225"/.test(svg) && /height="314"/.test(svg)));
    }
  }

  assert.ok(fs.existsSync(path.join(cardsDirectory, 'blueBack.svg')));
});
