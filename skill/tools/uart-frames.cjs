#!/usr/bin/env node
// uart-frames.cjs —— 从自研抓取的裸 .bin 里解 8N1 UART，按帧头切帧，并做逐字节变化分析。
// 用法: node uart-frames.cjs <file.bin> <sampleRate> <channelIndex> <baud> [headerHex]
// 例:   node uart-frames.cjs uv-light.bin 1000000 2 9600 AB2060001400
//
// 逐字节分析是关键：把"亮"和"暗"两次抓取的同一位置对比，
// 哪个字节跟着读数变，那个位置就是测量值字段。

const fs = require('fs');
const file = process.argv[2];
const sr = Number(process.argv[3]);
const ch = Number(process.argv[4]);
const baud = Number(process.argv[5]);
const headerHex = (process.argv[6] || 'AB2060001400').toUpperCase();

if (!file || !sr || isNaN(ch) || !baud) {
  console.error('usage: node uart-frames.cjs <file.bin> <sampleRate> <channelIndex> <baud> [headerHex]');
  process.exit(2);
}
const buf = fs.readFileSync(file);
const N = buf.length;
const spb = sr / baud;
const bit = i => (buf[i] >> ch) & 1;

// ---- UART 8N1 解码（空闲高，LSB first，起始位下降沿，停止位校验） ----
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

console.log('# ' + file + '  ch' + ch + ' @' + baud + ' baud, ' + sr + ' Hz');
console.log('解出 ' + bytes.length + ' 字节, 覆盖 ' + (N / sr).toFixed(2) + ' s');

const hdr = [];
for (let k = 0; k + 1 < headerHex.length; k += 2) hdr.push(parseInt(headerHex.substr(k, 2), 16));

const starts = [];
for (let p = 0; p + hdr.length <= bytes.length; p++) {
  let ok = true;
  for (let k = 0; k < hdr.length; k++) if (bytes[p + k] !== hdr[k]) { ok = false; break; }
  if (ok) { starts.push(p); p += hdr.length - 1; }
}
console.log('按帧头 ' + headerHex + ' 切出 ' + starts.length + ' 个帧起始');

if (!starts.length) {
  console.log('前 64 字节: ' + bytes.slice(0, 64).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' '));
  process.exit(0);
}

const frames = [];
for (let f = 0; f < starts.length; f++) {
  const a = starts[f];
  const b = (f + 1 < starts.length) ? starts[f + 1] : bytes.length;
  frames.push({ t: samples[a] / sr, data: bytes.slice(a, b) });
}
console.log('帧长度分布: ' + [...new Set(frames.map(f => f.data.length))].sort((x, y) => x - y).join(', '));
console.log('');
for (const f of frames) {
  console.log('t=' + f.t.toFixed(3) + 's len=' + String(f.data.length).padStart(3) + '  ' +
    f.data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' '));
}

// ---- 逐字节变化分析（只统计最常见帧长的那些帧） ----
const lenCount = {};
for (const f of frames) lenCount[f.data.length] = (lenCount[f.data.length] || 0) + 1;
const mainLen = Number(Object.keys(lenCount).sort((a, b) => lenCount[b] - lenCount[a])[0]);
const eq = frames.filter(f => f.data.length === mainLen);
console.log('');
console.log('=== 逐字节分析（帧长 ' + mainLen + '，共 ' + eq.length + ' 帧） ===');
console.log('pos  uniq  values(first 8)          flag');
for (let p = 0; p < mainLen; p++) {
  const vals = eq.map(f => f.data[p]);
  const uniq = [...new Set(vals)];
  const hex = v => v.toString(16).padStart(2, '0').toUpperCase();
  console.log(String(p).padStart(3) + '  ' + String(uniq.length).padStart(4) + '  ' +
    uniq.slice(0, 8).map(hex).join(' ').padEnd(24) + (uniq.length > 1 ? ' <== 变化' : ''));
}
