// Small display helpers shared by the popup and the tests.

// "7Hk2V9...q9Fa" style: first 4 and last 4 characters around an ellipsis.
export function shortId(id) {
  const s = String(id ?? '');
  if (s.length <= 10) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// Bytes in plain units. Returns '' for zero or bad input so callers can hide the value.
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = v;
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
  const digits = i === 0 || x >= 100 ? 0 : x >= 10 ? 1 : 2;
  return `${x.toFixed(digits)} ${units[i]}`;
}

// Time since a moment, in words. Returns '' when there is nothing to show.
export function formatDuration(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 1000) return '';
  const s = Math.floor(v / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} h ${rm} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}
