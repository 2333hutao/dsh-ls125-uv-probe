#!/usr/bin/env node
// uv-analyze.cjs —— 对 ch2 的 28 字节帧做结构分析（ASCII 输出，避免控制台编码问题）
// 用法: node uv-analyze.cjs <file.bin> <sampleRate> <channel> <baud>
// 做三件事:
//   1. 逐字节位置的变化统计（哪些位置在变、变多少种值）
//   2. 扫描所有 4 字节窗口，找出"在所有帧里都是合理浮点数"的候选字段，并给时间序列
//   3. 打印关键字段的时间序列（用于和亮/暗动作对齐）

const fs = require('fs');
const file = process.argv[2];
const sr = Number(process.argv[3]);
const ch = Number(process.argv[4]);
const baud = Number(process.argv[5]);
const buf = fs.readFileSync(file);
const N = buf.length;
const spb = sr / baud;
const bit = i => (buf[i] >> ch) & 1;

// ---- UART 8N1 decode ----
const bytes = [], samples = [];
let i = 1;
while (i < N) {
  if (bit(i - 1) === 1 && bit(i) === 0) {
    const start = i;
    const at = k => bit(Math.min(N - 1, Math.round(start + spb * (k + 0.5))));
    if (at(0) === 0) {
      let v = 0;
      for (let k = 1; k <= 8; k++) if (at(k)) v |= (1 << (k - 1));
      if (at(9) === 1) { bytes.push(v); samples.push(start); }
      i = Math.round(start + spb * 10);
      continue;
    }
  }
  i++;
}

const HDR = [0xAB, 0x20, 0x60, 0x00, 0x14, 0x00];
const starts = [];
for (let p = 0; p + HDR.length <= bytes.length; p++) {
  let ok = true;
  for (let k = 0; k < HDR.length; k++) if (bytes[p + k] !== HDR[k]) { ok = false; break; }
  if (ok) { starts.push(p); p += HDR.length - 1; }
}
const lenCount = {};
const rawFrames = [];
for (let f = 0; f < starts.length; f++) {
  const a = starts[f], b = (f + 1 < starts.length) ? starts[f + 1] : bytes.length;
  const d = bytes.slice(a, b);
  lenCount[d.length] = (lenCount[d.length] || 0) + 1;
  rawFrames.push({ t: samples[a] / sr, d });
}
const mainLen = Number(Object.keys(lenCount).sort((x, y) => lenCount[y] - lenCount[x])[0]);
const F = rawFrames.filter(f => f.d.length === mainLen);
const hex = v => v.toString(16).padStart(2, '0').toUpperCase();

console.log('frames total=' + rawFrames.length + '  mainLen=' + mainLen + '  used=' + F.length);
console.log('duration=' + (N / sr).toFixed(2) + 's  frame interval=' + (F.length > 1 ? ((F[F.length - 1].t - F[0].t) / (F.length - 1)).toFixed(3) : '?') + 's');

// ---- 1. per-position variation ----
console.log('');
console.log('--- per-position variation ---');
console.log('pos  uniq  min    max    first8');
const varying = [];
for (let p = 0; p < mainLen; p++) {
  const vals = F.map(f => f.d[p]);
  const uniq = [...new Set(vals)].sort((a, b) => a - b);
  if (uniq.length > 1) varying.push(p);
  console.log(String(p).padStart(3) + '  ' + String(uniq.length).padStart(4) + '  ' +
    hex(uniq[0]).padEnd(6) + hex(uniq[uniq.length - 1]).padEnd(6) +
    vals.slice(0, 8).map(hex).join(' ') + (uniq.length > 1 ? '  <== varies' : ''));
}
console.log('varying positions: ' + (varying.join(',') || '(none)'));

// ---- 2. float field scan ----
console.log('');
console.log('--- 4-byte little-endian float candidates (all frames sane) ---');
const cands = [];
for (let o = 0; o + 4 <= mainLen; o++) {
  const vals = [];
  let sane = true;
  for (const f of F) {
    const b = Buffer.from([f.d[o], f.d[o + 1], f.d[o + 2], f.d[o + 3]]);
    const v = b.readFloatLE(0);
    if (!isFinite(v) || Math.abs(v) > 1e9) { sane = false; break; }
    vals.push(v);
  }
  if (sane) {
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const uniq = new Set(vals.map(v => Math.round(v * 1000))).size;
    cands.push({ o, mn, mx, uniq, vals });
  }
}
for (const c of cands) {
  console.log('offset ' + String(c.o).padStart(2) + '  range ' + c.mn.toFixed(4) + ' .. ' + c.mx.toFixed(4) +
    '  distinct(milli)=' + c.uniq + (c.mx - c.mn > 1e-9 ? '   <== CHANGES' : '   (constant)'));
}

// ---- 3. time series of interesting fields ----
console.log('');
console.log('--- time series: t, [varying bytes], [changing floats] ---');
const changingFloats = cands.filter(c => c.mx - c.mn > 1e-9);
const step = Math.max(1, Math.floor(F.length / 60));
for (let k = 0; k < F.length; k += step) {
  const f = F[k];
  const vs = varying.map(p => hex(f.d[p])).join(' ');
  const fs2 = changingFloats.map(c => {
    const b = Buffer.from([f.d[c.o], f.d[c.o + 1], f.d[c.o + 2], f.d[c.o + 3]]);
    return 'f' + c.o + '=' + b.readFloatLE(0).toFixed(3);
  }).join('  ');
  console.log('t=' + f.t.toFixed(2).padStart(7) + 's  [' + vs + ']  ' + fs2);
}

// ---- 4. jump report: 找浮点字段的突变（用于对齐"照紫外光"这类外部动作） ----
console.log('');
console.log('--- jump report: frames whose float delta is a big outlier ---');
const readF = (d, o) => Buffer.from([d[o], d[o + 1], d[o + 2], d[o + 3]]).readFloatLE(0);
for (const c of changingFloats) {
  const d = [];
  for (let k = 1; k < F.length; k++) {
    d.push({ t: F[k].t, delta: readF(F[k].d, c.o) - readF(F[k - 1].d, c.o), v: readF(F[k].d, c.o) });
  }
  const abs = d.map(x => Math.abs(x.delta)).sort((x, y) => x - y);
  const med = abs[Math.floor(abs.length / 2)] || 0;
  const thr = Math.max(med * 4, 1e-6);
  const jumps = d.filter(x => Math.abs(x.delta) > thr);
  console.log('offset ' + c.o + ': median|delta|=' + med.toFixed(4) + '  thr=' + thr.toFixed(4) + '  jumps=' + jumps.length);
  for (const j of jumps.slice(0, 100)) {
    console.log('   t=' + j.t.toFixed(2) + 's  delta=' + j.delta.toFixed(3) + '  value=' + j.v.toFixed(3));
  }
}
