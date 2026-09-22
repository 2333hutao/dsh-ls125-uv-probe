// fx2cap.cjs —— 绕过 sigrok 自带的老 libusb，直接用官方 libusb 1.0.27 + fx2lafw 协议抓取。
//
// 用法:
//   node fx2cap.cjs --rate 1000000 --ms 3000 --out capture.bin          # 定时抓取
//   node fx2cap.cjs --wait --timeout 600000 --post 3000 --out t.bin     # 软触发：等到有边沿才开始记录
//
// 为什么要有 --wait: sigrok 的 fx2lafw 驱动**没有触发能力**（-t/-w 会被静默忽略），
// 且单次抓取受 ~3.5 s 限制。本工具自己实现"等到边沿"+"任意时长"。
// --wait 模式下每 5 秒打印一次进度（收到多少采样、出现过哪些电平值），
// 用来区分「设备没在传数据」和「数据恒定没有边沿」。
//
// 协议来源: sigrok libsigrok src/hardware/fx2lafw/{protocol.c,protocol.h}
//   库对设备只用 3 个控制传输；本工具复现其中两个必需项：
//   CMD_GET_FW_VERSION = 0xb0 (vendor IN, 2 字节)  返回值=收到的字节数
//   CMD_START          = 0xb1 (vendor OUT, 3 字节 [flags, delay_h, delay_l])
//     flags bit6 = CLK_48MHZ(1)/CLK_30MHZ(0); bit5 = 16bit; bit4 = CLK_CTL2(模拟)
//     delay = 时钟/采样率 - 1
//   数据: 接口 0 的批量 IN 端点 0x82，1 字节/采样（bit0=D0 ... bit7=D7）

const fs = require('fs');
const path = require('path');
// portable koffi lookup: local node_modules -> DSH profile -> global
const koffi = (() => {
  const cands = [
    path.join(__dirname, 'node_modules', 'koffi'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'node_modules', 'koffi'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'web', 'node_modules', 'koffi'),
    'koffi',
  ];
  for (const c of cands) { try { return require(c); } catch (e) { } }
  throw new Error('koffi not found. Tried:' + cands.join(' | '));
})();

const DEFAULT_DLL = path.join(__dirname, 'lib', 'libusb-1.0.dll');
const VID = 0x1d50, PID = 0x608c;
const IFACE = 0, EP_IN = 0x82;
const CMD_GET_FW_VERSION = 0xb0, CMD_START = 0xb1;
const BUFSZ = 262144;
const PRE_MAX = 2 * 1024 * 1024;

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const hasFlag = n => process.argv.includes('--' + n);

const rate = parseInt(arg('rate', '1000000'), 10);
const ms = parseInt(arg('ms', '3000'), 10);
const useTrigger = hasFlag('wait');
const timeoutMs = parseInt(arg('timeout', '600000'), 10);
const postMs = parseInt(arg('post', '3000'), 10);
const outFile = arg('out', path.join(__dirname, '..', 'captures', 'fx2cap.bin'));
const dll = arg('dll', DEFAULT_DLL).replace(/\//g, path.sep);
// --stopfile <path>: capture until that file appears, then finish cleanly.
// Needed for open-ended captures: killing the process would lose everything
// (the sample buffer is only written out at the end).
const stopFile = arg('stopfile', '');

if (!fs.existsSync(dll)) { console.error('找不到 libusb DLL: ' + dll); process.exit(2); }
process.chdir(path.dirname(dll));
const lib = koffi.load(path.basename(dll));

const libusb_init = lib.func('int libusb_init(void *ctx)');
const libusb_exit = lib.func('void libusb_exit(void *ctx)');
const openVidPid = lib.func('void *libusb_open_device_with_vid_pid(void *ctx, uint16_t vid, uint16_t pid)');
const claimIface = lib.func('int libusb_claim_interface(void *dev, int iface)');
const releaseIface = lib.func('void libusb_release_interface(void *dev, int iface)');
const ctrlTransfer = lib.func('int libusb_control_transfer(void *dev, uint8_t bmRequestType, uint8_t bRequest, uint16_t wValue, uint16_t wIndex, uint8_t *data, uint16_t wLength, unsigned int timeout)');
const bulkTransfer = lib.func('int libusb_bulk_transfer(void *dev, uint8_t endpoint, uint8_t *data, int length, _Out_ int *transferred, unsigned int timeout)');
const libusb_close = lib.func('void libusb_close(void *dev)');
const errName = lib.func('const char *libusb_error_name(int code)');
const libusb_reset_device = lib.func('int libusb_reset_device(void *dev)');

console.log('DLL  = ' + dll);
console.log('init = ' + libusb_init(null));

function sleep(ms) { const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } }

// ★ fx2lafw 协议里**没有 STOP 命令**（只有 GET_FW_VERSION / START / GET_REVID），
//   libsigrok 的 abort 也只是取消 libusb 传输、对设备什么都不发。
//   ⇒ 主机一旦停读，FX2 的 FIFO 填满就卡死（表现为"只发一包然后全是 timeout"），
//     被强杀进程中断的采集尤其会留下这个状态。唯一软件恢复手段是 USB 复位，否则要拔插。
//   所以默认每次都先复位；用 --no-reset 可跳过。
if (!hasFlag('no-reset')) {
  const h0 = openVidPid(null, VID, PID);
  if (h0) {
    console.log('reset_device = ' + libusb_reset_device(h0));
    libusb_close(h0);
    sleep(2500);
  } else {
    console.log('reset: 复位前打不开设备，直接尝试打开');
  }
}

let h = null;
for (let k = 0; k < 20 && !h; k++) { h = openVidPid(null, VID, PID); if (!h) sleep(500); }
if (!h) { console.error('打不开设备（复位后仍失败，可能需要拔插一次）'); process.exit(3); }
console.log('open = OK');

let r = claimIface(h, IFACE);
console.log('claim iface ' + IFACE + ' = ' + r);
if (r !== 0) { libusb_close(h); libusb_exit(null); process.exit(4); }

const vi = Buffer.alloc(2);
const gotFw = ctrlTransfer(h, 0xc0, CMD_GET_FW_VERSION, 0, 0, vi, 2, 1000);
console.log('fw version = v' + vi[0] + '.' + vi[1] + '  (' + gotFw + ' 字节)');

let flags = 0, delay = 0, clk = 0;
if (48000000 % rate === 0) { flags = 0x40; clk = 48; delay = 48000000 / rate - 1; }
else if (30000000 % rate === 0) { flags = 0x00; clk = 30; delay = 30000000 / rate - 1; }
else { console.error('该采样率无法由 48/30 MHz 整除得到'); process.exit(5); }
if (delay > 6 * 256) { console.error('delay 超限: ' + delay); process.exit(5); }
const cmd = Buffer.from([flags & 0xff, (delay >> 8) & 0xff, delay & 0xff]);
console.log('rate = ' + rate + ' Hz, clock = ' + clk + ' MHz, delay = ' + delay + ', flags = 0x' + cmd[0].toString(16));

const sent = ctrlTransfer(h, 0x40, CMD_START, 0, 0, cmd, 3, 1000);
console.log('CMD_START = ' + sent + ' 字节');
if (sent !== 3) { releaseIface(h, IFACE); libusb_close(h); libusb_exit(null); process.exit(6); }

// ---------- 读取循环 ----------
const rb = Buffer.alloc(BUFSZ);
const tr = [0];
const chunks = [];
let total = 0;
const pre = [];
let preBytes = 0;
let triggered = !useTrigger;
let triggerAt = 0;
let prevByte = -1;
let stopReason = '';
let receivedTotal = 0;
let bulkTimeouts = 0;
const seen = new Set();
let lastReport = 0;
const t0 = Date.now();

if (useTrigger) console.log('软触发模式：等待任意通道出现边沿（上限 ' + (timeoutMs / 1000) + ' s），每 5 秒报一次进度...');

for (;;) {
  const el = Date.now() - t0;
  if (stopFile && fs.existsSync(stopFile)) { stopReason = 'stop file appeared -> finishing'; break; }
  if (!triggered) {
    if (el >= timeoutMs) { stopReason = '等待超时（' + (el / 1000).toFixed(1) + ' s 内没有任何边沿）'; break; }
  } else {
    if (triggerAt === 0) triggerAt = Date.now();
    if (useTrigger ? (Date.now() - triggerAt >= postMs) : (el >= ms)) { stopReason = '采集完成'; break; }
  }

  tr[0] = 0;
  const rr = bulkTransfer(h, EP_IN, rb, BUFSZ, tr, 1000);
  if (tr[0] > 0) {
    const chunk = Buffer.from(rb.subarray(0, tr[0]));
    receivedTotal += chunk.length;
    if (!triggered && seen.size < 24) {
      for (let i = 0; i < chunk.length; i++) { seen.add(chunk[i]); if (seen.size >= 24) break; }
    }
    let found = false;
    if (!triggered) {
      if (prevByte >= 0 && chunk[0] !== prevByte) found = true;
      for (let i = 1; i < chunk.length; i++) { if (chunk[i] !== chunk[i - 1]) { found = true; break; } }
      prevByte = chunk[chunk.length - 1];
    }
    if (!triggered) {
      pre.push(chunk); preBytes += chunk.length;
      while (preBytes > PRE_MAX) { preBytes -= pre[0].length; pre.shift(); }
      if (found) {
        triggered = true;
        triggerAt = Date.now();
        console.log('>>> 检测到边沿！等待了 ' + ((triggerAt - t0) / 1000).toFixed(2) + ' s，含前置上下文 ' + preBytes + ' 字节');
        for (const c of pre) { chunks.push(c); total += c.length; }
        pre.length = 0; preBytes = 0;
      }
    } else {
      chunks.push(chunk); total += chunk.length;
    }
  } else if (rr === -7) {
    bulkTimeouts++;
  }
  if (rr !== 0 && rr !== 2 && rr !== -7) { console.log('bulk: ' + rr + ' ' + String(errName(rr))); break; }

  if (!triggered && Date.now() - lastReport >= (useTrigger ? 5000 : 30000)) {
    lastReport = Date.now();
    const vals = [...seen].slice(0, 12).map(v => '0x' + v.toString(16).padStart(2, '0')).join(' ');
    console.log('[' + ((Date.now() - t0) / 1000).toFixed(0) + 's] 收到 ' + receivedTotal + ' 采样, bulk超时 ' + bulkTimeouts +
      ' 次, 出现过的电平: ' + (vals || '(还没收到任何数据)') + (seen.size > 12 ? ' ...共' + seen.size + '种' : ''));
  }
}

const wall = (Date.now() - t0) / 1000;
const data = Buffer.concat(chunks, total);
console.log('');
console.log('停止: ' + stopReason);
console.log('共收到 ' + receivedTotal + ' 采样, 墙钟 ' + wall.toFixed(2) + ' s, 本次写出 ' + total + ' 采样');
if (total === 0) { console.log('没有数据可写。'); releaseIface(h, IFACE); libusb_close(h); libusb_exit(null); process.exit(0); }
fs.writeFileSync(outFile, data);
console.log('隐含采样率 = ' + Math.round(total / wall) + ' Hz (请求 ' + rate + ')  -> ' + outFile);

// ---------- 逐通道统计 ----------
const N = data.length;
const SLICES = 100;
const sliceEdges = new Array(SLICES).fill(0);
console.log('');
console.log('ch   edges    high%   minRun  maxRun  firstEdge        lastEdge');
for (let c = 0; c < 8; c++) {
  const mask = 1 << c;
  let edges = 0, highs = 0, minRun = Infinity, maxRun = 0;
  let prev = (data[0] & mask) ? 1 : 0;
  if (prev) highs++;
  let runStart = 0, firstEdge = -1, lastEdge = -1;
  const hist = new Map();
  for (let i = 1; i < N; i++) {
    const cur = (data[i] & mask) ? 1 : 0;
    if (cur) highs++;
    if (cur !== prev) {
      const len = i - runStart;
      if (len < minRun) minRun = len;
      if (len > maxRun) maxRun = len;
      hist.set(len, (hist.get(len) || 0) + 1);
      edges++;
      if (firstEdge < 0) firstEdge = i;
      lastEdge = i;
      sliceEdges[Math.min(SLICES - 1, Math.floor(i * SLICES / N))]++;
      runStart = i; prev = cur;
    }
  }
  const tail = N - runStart;
  if (tail < minRun) minRun = tail;
  if (tail > maxRun) maxRun = tail;
  hist.set(tail, (hist.get(tail) || 0) + 1);
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (minRun === Infinity) minRun = N;
  const pct = v => v < 0 ? '-' : (v + '(' + (100 * v / N).toFixed(1) + '%)');
  console.log(('D' + c).padEnd(4) + String(edges).padEnd(9) + (100 * highs / N).toFixed(2).padEnd(8) +
    String(minRun).padEnd(8) + String(maxRun).padEnd(8) + pct(firstEdge).padEnd(16) + pct(lastEdge));
  console.log('    游程簇: ' + top.map(([len, n]) => len + '(' + (1e6 * len / rate).toFixed(2) + 'us):' + n).join('  '));
}

const sliceMs = (N / rate) / SLICES * 1000;
const maxE = Math.max(1, ...sliceEdges);
const spark = ' .:-=+*#%@';
let line = '';
for (let i = 0; i < SLICES; i++) {
  line += spark[Math.min(9, Math.round(Math.log10(1 + sliceEdges[i]) / Math.log10(1 + maxE) * 9))];
}
console.log('');
console.log('边沿密度(100 格, 每格 ' + sliceMs.toFixed(2) + ' ms):');
console.log('|' + line + '|');

releaseIface(h, IFACE);
libusb_close(h);
libusb_exit(null);
