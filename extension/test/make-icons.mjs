// Dev tool: draws the toolbar icons from the Tangent mark (a circle with a line across its top).
// Run: node test/make-icons.mjs   (needs rsvg-convert). The PNGs are committed; loading the
// extension never runs this.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'icons');
const tmp = mkdtempSync(join(tmpdir(), 'tangent-icons-'));

function svg(size, on) {
  // Thicker strokes at small sizes so the mark stays crisp.
  const stroke = size <= 16 ? 2.5 : size <= 32 ? 2.1 : size <= 48 ? 1.9 : 1.7;
  const radius = size <= 16 ? 3.5 : 6;
  const color = on ? '#f3f2ee' : 'rgba(243,242,238,0.42)';
  const bg = on ? '#060606' : '#111111';
  // Mark lives in a 26 unit box; centre it inside a 32 unit tile.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect x="0" y="0" width="32" height="32" rx="${radius}" fill="${bg}"/>
  <g transform="translate(2.5 0)" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round">
    <circle cx="11" cy="16" r="7"/>
    <path d="M3 9h21"/>
  </g>
</svg>`;
}

for (const on of [true, false]) {
  for (const size of [16, 32, 48, 128]) {
    const f = join(tmp, `${on ? 'on' : 'off'}-${size}.svg`);
    writeFileSync(f, svg(size, on));
    execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', join(out, `${on ? 'on' : 'off'}-${size}.png`), f]);
  }
}
console.log('icons written to', out);
