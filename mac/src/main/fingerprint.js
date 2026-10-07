'use strict';
/**
 * 每账号稳定指纹。
 *
 * 对应原版 ApplyFingerprintProfileAsync / ApplyCoherentWebGlProfile。
 * 要点是「相干性」：UA、平台、WebGL 渲染器、屏幕、时区必须互相自洽 ——
 * 一个声称是 macOS 的 UA 配上 NVIDIA 的 WebGL 渲染器反而比不改更可疑。
 *
 * 指纹由账号 code 用 HMAC 派生，重启不漂移。
 */
const crypto = require('crypto');

// 相干的 macOS / Apple Silicon 组合
const MAC_WEBGL = [
  { vendor: 'Apple Inc.', renderer: 'Apple M1' },
  { vendor: 'Apple Inc.', renderer: 'Apple M1 Pro' },
  { vendor: 'Apple Inc.', renderer: 'Apple M2' },
  { vendor: 'Apple Inc.', renderer: 'Apple M2 Pro' },
  { vendor: 'Apple Inc.', renderer: 'Apple M3' },
  { vendor: 'Apple Inc.', renderer: 'Apple M3 Pro' },
  { vendor: 'Apple Inc.', renderer: 'Apple M4' }
];

const SCREENS = [
  { width: 1512, height: 982, availHeight: 950 },   // 14" MacBook Pro
  { width: 1728, height: 1117, availHeight: 1085 }, // 16" MacBook Pro
  { width: 1470, height: 956, availHeight: 924 },   // 13" MacBook Air M2/M3
  { width: 1920, height: 1080, availHeight: 1055 },
  { width: 2560, height: 1440, availHeight: 1415 }
];

const CORES = [8, 10, 12, 14];
const MEMORY = [8, 16, 32];

function digest(code, salt) {
  return crypto.createHmac('sha256', 'xingchen-dola-fp').update(code + '|' + salt).digest();
}

function pick(code, salt, arr) {
  return arr[digest(code, salt)[0] % arr.length];
}

/**
 * 生成账号指纹。
 * @param {string} code 账号唯一码
 * @param {object} [override] 可选覆盖（例如沿用 Windows UA 保持登录态连续）
 */
function profileFor(code, override = {}) {
  const gl = pick(code, 'webgl', MAC_WEBGL);
  const screen = pick(code, 'screen', SCREENS);
  const chromeMajor = 131;

  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/' + chromeMajor + '.0.0.0 Safari/537.36';

  return Object.assign({
    userAgent: ua,
    platform: 'MacIntel',
    // navigator.userAgentData
    uaBrands: [
      { brand: 'Google Chrome', version: String(chromeMajor) },
      { brand: 'Chromium', version: String(chromeMajor) },
      { brand: 'Not_A Brand', version: '24' }
    ],
    uaPlatform: 'macOS',
    webglVendor: gl.vendor,
    webglRenderer: gl.renderer,
    screen,
    hardwareConcurrency: pick(code, 'cores', CORES),
    deviceMemory: pick(code, 'mem', MEMORY),
    // 画布/音频噪声种子：同账号恒定，跨账号不同
    canvasSeed: digest(code, 'canvas').readUInt32BE(0),
    audioSeed: digest(code, 'audio').readUInt32BE(0),
    languages: ['zh-CN', 'zh', 'en-US', 'en'],
    timezone: 'Asia/Shanghai'
  }, override);
}

module.exports = { profileFor };
