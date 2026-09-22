#!/usr/bin/env node
// checksum-hunt.cjs —— 在抓到的帧里反推校验和算法。
//
// 用法: node checksum-hunt.cjs <file.bin> <sampleRate> <channel> <baud>
//
// 做法:
//   1. 解 8N1 UART，按帧头 AB 20 60 00 14 00 切出定长帧（默认 28 字节 D2 帧）
//   2. 把最后 2 字节当作校验和候选（同时试小端/大端）
//   3. 依次试: 累加和、异或和、16 位字和，然后 **暴力扫 65536 个 CRC-16 多项式**
//      （MSB-first 与 LSB-first 两种位序 × init 0x0000/0xFFFF/0x1D0F）
//      以及若干常见 CRC-16 变体
//   4. 覆盖范围试 [0,26) [0,25) [6,26) [0,28)
//   任何一条能同时命中所有帧的，就是算法。

const fs = require('fs');
const file = process.argv[2];
const sr = Number(process.argv[3]);
const ch = Number(process.argv[4]);
const baud = Number(process.argv[5]);

const buf = fs.readFileSync(file);
const N = buf.length;
const spb = sr / baud;
const bit = i => (buf[i] >> ch) & 1;

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
const raw = [];
for (let f = 0; f < starts.length; f++) {
  const a = starts[f], b = (f + 1 < starts.length) ? starts[f + 1] : bytes.length;
  const d = bytes.slice(a, b);
  lenCount[d.length] = (lenCount[d.length] || 0) + 1;
  raw.push(d);
}
const mainLen = Number(Object.keys(lenCount).sort((x, y) => lenCount[y] - lenCount[x])[0]);
const F = raw.filter(d => d.length === mainLen);
console.log('file=' + file);
console.log('frames=' + F.length + '  frameLen=' + mainLen);
const H = v => v.toString(16).padStart(2, '0').toUpperCase();

// ---------- 工具 ----------
const reflect8 = b => { let r = 0; for (let i = 0; i < 8; i++) r = (r << 1) | ((b >> i) & 1); return r & 0xFF; };
const reflect16 = v => { let r = 0; for (let i = 0; i < 16; i++) r = (r << 1) | ((v >> i) & 1); return r & 0xFFFF; };

function crc16msb(data, poly, init) {          // MSB-first
  let crc = init & 0xFFFF;
  for (const b of data) {
    crc ^= (b << 8);
    for (let k = 0; k < 8; k++) crc = (crc & 0x8000) ? ((crc << 1) ^ poly) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc & 0xFFFF;
}
function crc16lsb(data, poly, init) {          // LSB-first (reflected)
  let crc = init & 0xFFFF;
  for (const b of data) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc & 1) ? ((crc >> 1) ^ poly) & 0xFFFF : (crc >> 1) & 0xFFFF;
  }
  return crc & 0xFFFF;
}

// ---------- 候选校验和位置与取法 ----------
const take = [
  { name: 'LE(26,27)', get: d => d[mainLen - 2] | (d[mainLen - 1] << 8) },
  { name: 'BE(26,27)', get: d => (d[mainLen - 2] << 8) | d[mainLen - 1] },
];
const ranges = [
  { name: '[0,' + (mainLen - 2) + ')', s: 0, e: mainLen - 2 },
  { name: '[0,' + (mainLen - 3) + ')', s: 0, e: mainLen - 3 },
  { name: '[6,' + (mainLen - 2) + ')', s: 6, e: mainLen - 2 },
  { name: '[0,' + mainLen + ')', s: 0, e: mainLen },
];

const hits = [];
const sampleFrames = F.slice(0, Math.min(F.length, 12));   // 用少量帧先筛

// ---------- 1) 简单算法 ----------
for (const tk of take) {
  const want = sampleFrames.map(tk.get);
  for (const rg of ranges) {
    const data = sampleFrames.map(d => Array.from(d.slice(rg.s, rg.e)));
    const tests = {
      'sum8':      a => a.reduce((x, y) => (x + y) & 0xFF, 0),
      'sum16':     a => a.reduce((x, y) => (x + y) & 0xFFFF, 0),
      'xor8':      a => a.reduce((x, y) => x ^ y, 0),
      'sum16wordsLE': a => { let s = 0; for (let k = 0; k + 1 < a.length; k += 2) s = (s + a[k] + (a[k + 1] << 8)) & 0xFFFF; return s; },
      'sum16wordsBE': a => { let s = 0; for (let k = 0; k + 1 < a.length; k += 2) s = (s + (a[k] << 8) + a[k + 1]) & 0xFFFF; return s; },
    };
    for (const [nm, fn] of Object.entries(tests)) {
      let ok = true;
      for (let k = 0; k < data.length; k++) if ((fn(data[k]) & 0xFFFF) !== (want[k] & 0xFFFF)) { ok = false; break; }
      if (ok) hits.push('SIMPLE ' + nm + ' over ' + rg.name + ' -> ' + tk.name);
    }
  }
}

// ---------- 2) 常见 CRC-16 变体 ----------
const named = [
  ['CCITT-FALSE', 0x1021, 0xFFFF, 'msb'],
  ['XMODEM', 0x1021, 0x0000, 'msb'],
  ['AUG-CCITT', 0x1021, 0x1D0F, 'msb'],
  ['GENIBUS', 0x1021, 0xFFFF, 'msb'],
  ['ARC', 0x8005, 0x0000, 'lsb'],
  ['MODBUS', 0x8005, 0xFFFF, 'lsb'],
  ['USB', 0xA001, 0xFFFF, 'lsb'],
  ['MAXIM', 0x8005, 0x0000, 'lsb'],
  ['DNP', 0xA6BC, 0x0000, 'lsb'],
];
for (const tk of take) {
  const want = sampleFrames.map(tk.get);
  for (const rg of ranges) {
    const data = sampleFrames.map(d => Array.from(d.slice(rg.s, rg.e)));
    for (const [nm, poly, init, dir] of named) {
      const fn = dir === 'msb' ? crc16msb : crc16lsb;
      const variants = [{ suffix: '', post: v => v }, { suffix: ' ^0xFFFF', post: v => v ^ 0xFFFF }];
      for (const va of variants) {
        let ok = true;
        for (let k = 0; k < data.length; k++) {
          if ((va.post(fn(data[k], poly, init)) & 0xFFFF) !== (want[k] & 0xFFFF)) { ok = false; break; }
        }
        if (ok) hits.push('CRC16 ' + nm + va.suffix + ' over ' + rg.name + ' -> ' + tk.name);
      }
    }
  }
}

// ---------- 3) 暴力扫 65536 个多项式 ----------
console.log('brute forcing 65536 polys x 2 directions x 3 inits ...');
for (const tk of take) {
  const want = sampleFrames.map(tk.get);
  for (const rg of ranges) {
    const data = sampleFrames.map(d => Array.from(d.slice(rg.s, rg.e)));
    for (const [dir, fn, inits] of [['msb', crc16msb, [0x0000, 0xFFFF, 0x1D0F]], ['lsb', crc16lsb, [0x0000, 0xFFFF]]]) {
      for (const init of inits) {
        for (let poly = 1; poly < 0x10000; poly++) {
          let ok = true;
          for (let k = 0; k < data.length; k++) {
            if (fn(data[k], poly, init) !== want[k]) { ok = false; break; }
          }
          if (ok) hits.push('BRUTE CRC16 ' + dir + ' poly=0x' + poly.toString(16).toUpperCase() +
            ' init=0x' + init.toString(16).toUpperCase() + ' over ' + rg.name + ' -> ' + tk.name);
        }
      }
    }
  }
}

console.log('');
if (hits.length === 0) {
  console.log('=== 没有命中任何已知算法 ===');
  console.log('前 8 帧的最后 4 字节:');
  F.slice(0, 8).forEach((d, k) => {
    console.log('  #' + k + '  ... ' + d.slice(mainLen - 4).map(H).join(' ') +
      '   全帧: ' + d.map(H).join(' '));
  });
} else {
  console.log('=== 命中 ' + hits.length + ' 条 ===');
  hits.forEach(h => console.log('  ' + h));
}

// ---------- 4) 用命中的算法去验证 D0 的 8 字节命令 ----------
const d0 = bytes.slice(0, 8);   // 仅供参考：D0 是另一条线，需另跑
console.log('');
console.log('提示: D0 的固定命令 AB 20 60 00 14 00 89 07 里，末两字节若是同款校验，');
console.log('      可用上面命中的算法对前 6 字节算一遍做交叉验证。');
