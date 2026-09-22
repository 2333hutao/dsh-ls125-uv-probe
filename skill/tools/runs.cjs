#!/usr/bin/env node
// runs.cjs —— 打印某个通道的原始电平游程（从第一个边沿开始），用于手工核对 UART 时序。
// 用法: node runs.cjs <file.bin> <sampleRate> <channel> [maxRuns]

const fs = require('fs');
const file = process.argv[2];
const sr = Number(process.argv[3]);
const ch = Number(process.argv[4]);
const maxRuns = Number(process.argv[5] || 60);

const buf = fs.readFileSync(file);
const N = buf.length;
const bit = i => (buf[i] >> ch) & 1;

let i = 0;
// 跳到第一个边沿
while (i + 1 < N && bit(i) === bit(i + 1)) i++;
if (i + 1 >= N) { console.log('该通道没有边沿'); process.exit(0); }

console.log('# ' + file + '  ch' + ch + ' @' + sr + ' Hz   (1 bit @9600 = ' +
  (sr / 9600).toFixed(2) + ' 采样 / ' + (1e6 / 9600).toFixed(1) + ' us)');
console.log('# 从第一个边沿（采样 ' + i + '，t=' + (i / sr).toFixed(4) + 's）开始:');
console.log('run  level  samples      us      bits@9600');

let run = 0, lvl = bit(i), n = 0;
const t0 = i;
for (let k = i; k < N && n < maxRuns; k++) {
  if (bit(k) === lvl) {
    run++;
  } else {
    console.log(String(n).padStart(3) + '   ' + lvl + '     ' + String(run).padStart(7) +
      '  ' + (1e6 * run / sr).toFixed(1).padStart(8) + '   ' + (run / (sr / 9600)).toFixed(2).padStart(6));
    n++;
    lvl = bit(k);
    run = 1;
  }
}
console.log('(前 ' + n + ' 个游程，覆盖 ' + (1e6 * (maxRuns ? run : 0) / sr).toFixed(0) + ' us 量级)');
