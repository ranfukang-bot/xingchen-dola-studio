'use strict';
/**
 * 保险库：账号与 Cookie 的加密落盘。
 *
 * Windows 原版用 DPAPI（System.Security.Cryptography.ProtectedData）把 Cookie
 * 绑定到当前用户。macOS 上的等价物是钥匙串 —— Electron 的 safeStorage 正是
 * 封装了 Keychain，加密密钥由系统保管，不出现在磁盘上。
 */
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const MAGIC = 'XCDOLA1';

function dataRoot() {
  // 对应原版 ResolveAccountDataRoot()
  return path.join(app.getPath('userData'), 'AccountData');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

/** 写入：优先钥匙串加密，不可用时降级为明文并在文件头标注，便于排查。 */
function writeSecure(file, obj) {
  ensureDir(path.dirname(file));
  const json = JSON.stringify(obj);
  if (canEncrypt()) {
    const blob = safeStorage.encryptString(json);
    const out = Buffer.concat([Buffer.from(MAGIC + 'E', 'utf8'), blob]);
    fs.writeFileSync(file, out, { mode: 0o600 });
  } else {
    fs.writeFileSync(file, MAGIC + 'P' + json, { mode: 0o600 });
  }
}

function readSecure(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file);
    const head = raw.subarray(0, MAGIC.length + 1).toString('utf8');
    if (head === MAGIC + 'E') {
      const body = raw.subarray(MAGIC.length + 1);
      return JSON.parse(safeStorage.decryptString(body));
    }
    if (head === MAGIC + 'P') {
      return JSON.parse(raw.subarray(MAGIC.length + 1).toString('utf8'));
    }
    // 兼容早期明文 JSON
    return JSON.parse(raw.toString('utf8'));
  } catch (err) {
    console.error('[vault] 读取失败', file, err.message);
    return fallback;
  }
}

module.exports = { dataRoot, ensureDir, writeSecure, readSecure, canEncrypt };
