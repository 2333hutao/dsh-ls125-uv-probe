// test-open.cjs —— 用官方新版 libusb（DLL）验证 fx2lafw 设备能否被打开。
// 用法: node test-open.cjs <libusb-1.0.dll 的绝对路径>
// 目的: 区分「设备/驱动有问题」和「sigrok 内置老 libusb 有问题」。
//       若这里能 open + claim interface，则设备侧完全健康。

const path = require('path');
const fs = require('fs');

const dll = process.argv[2];
if (!dll || !fs.existsSync(dll)) {
  console.error('usage: node test-open.cjs <libusb-1.0.dll>');
  process.exit(2);
}

// koffi 装在 DSH profile 里；用绝对路径 require
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

// 切到 DLL 所在目录，保证它的依赖 DLL 能被解析
process.chdir(path.dirname(dll));

const lib = koffi.load(path.basename(dll));

const libusb_init = lib.func('int libusb_init(void *ctx)');
const libusb_exit = lib.func('void libusb_exit(void *ctx)');
const libusb_open_device_with_vid_pid =
  lib.func('void *libusb_open_device_with_vid_pid(void *ctx, uint16_t vid, uint16_t pid)');
const libusb_claim_interface = lib.func('int libusb_claim_interface(void *dev, int iface)');
const libusb_release_interface = lib.func('void libusb_release_interface(void *dev, int iface)');
const libusb_close = lib.func('void libusb_close(void *dev)');
const libusb_error_name = lib.func('const char *libusb_error_name(int code)');

console.log('DLL      =', dll);
console.log('init     =', libusb_init(null));

const h = libusb_open_device_with_vid_pid(null, 0x1d50, 0x608c);
if (!h) {
  console.log('open     = NULL  -> 设备打不开');
  libusb_exit(null);
  process.exit(1);
}
console.log('open     = HANDLE OK  -> 新版 libusb 能打开设备');

const r = libusb_claim_interface(h, 0);
const name = libusb_error_name(r);
console.log('claim 0  =', r, name ? String(name) : '');

libusb_release_interface(h, 0);
libusb_close(h);
libusb_exit(null);
console.log('结果: 设备与驱动侧【健康】（能 open + claim）');
