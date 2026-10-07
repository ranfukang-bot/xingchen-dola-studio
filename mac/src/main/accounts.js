'use strict';
/**
 * 多账号管理与浏览器隔离。
 *
 * Windows 原版给每个账号建一个 CoreWebView2Profile（独立 UserDataFolder），
 * 从而隔离 Cookie / localStorage / IndexedDB。
 *
 * Electron 的等价物是 session.fromPartition('persist:<name>')：每个分区拥有
 * 完全独立的 Cookie 罐、缓存、存储与 Service Worker 注册表，互不可见。
 * 这比原版更干净 —— 不需要手动清理孤儿 profile 目录。
 */
const path = require('path');
const crypto = require('crypto');
const { session } = require('electron');
const vault = require('./vault');
const { profileFor } = require('./fingerprint');

const STORE = () => path.join(vault.dataRoot(), 'accounts.vault');

/** @type {{accounts: Array, groups: Array}} */
let state = null;

function load() {
  if (state) return state;
  state = vault.readSecure(STORE(), null) || {
    accounts: [],
    groups: [{ id: 'default', name: '默认分组' }]
  };
  if (!Array.isArray(state.groups) || !state.groups.length) {
    state.groups = [{ id: 'default', name: '默认分组' }];
  }
  if (!Array.isArray(state.accounts)) state.accounts = [];
  return state;
}

function save() {
  vault.writeSecure(STORE(), load());
}

function partitionName(code) {
  return 'persist:dola-' + code;
}

/** 取得（并初始化）某账号的隔离 session。 */
function sessionFor(code) {
  const ses = session.fromPartition(partitionName(code));
  applyProxy(code, ses);
  return ses;
}

function applyProxy(code, ses) {
  const acct = get(code);
  const proxy = acct && acct.proxy;
  try {
    if (proxy && proxy.trim()) {
      ses.setProxy({ proxyRules: proxy.trim(), proxyBypassRules: '<local>' });
    } else {
      ses.setProxy({ mode: 'direct' });
    }
  } catch (err) {
    console.error('[accounts] 代理设置失败', code, err.message);
  }
}

function list() {
  return load().accounts.map((a) => ({ ...a, partition: partitionName(a.code) }));
}

function get(code) {
  return load().accounts.find((a) => a.code === code) || null;
}

function groups() {
  return load().groups.slice();
}

function create(opts = {}) {
  const st = load();
  const code = opts.code || crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const seq = st.accounts.length + 1;
  const acct = {
    code,
    seq,
    name: opts.name || ('Dola Cookie ' + seq),
    groupId: opts.groupId || 'default',
    kind: opts.kind || 'dola',          // dola | facebook | password
    loggedIn: false,
    accountId: '',
    accountName: '',
    email: '',
    proxy: opts.proxy || '',
    // 每个账号一套稳定的指纹（UA / WebGL / 时区 / 分辨率），由 code 派生，
    // 保证重启后不漂移 —— 这点与原版 ApplyFingerprintProfileAsync 一致。
    fingerprint: profileFor(code),
    createdAt: Date.now(),
    lastUsedAt: 0
  };
  st.accounts.push(acct);
  save();
  return acct;
}

function update(code, patch) {
  const acct = get(code);
  if (!acct) return null;
  Object.assign(acct, patch || {});
  save();
  if (patch && 'proxy' in patch) applyProxy(code, session.fromPartition(partitionName(code)));
  return acct;
}

async function remove(code) {
  const st = load();
  const idx = st.accounts.findIndex((a) => a.code === code);
  if (idx < 0) return false;
  st.accounts.splice(idx, 1);
  save();
  // 清空该账号的隔离分区，等价于原版 DeleteIdentityProfileDirectory()
  try {
    const ses = session.fromPartition(partitionName(code));
    await ses.clearStorageData();
    await ses.clearCache();
  } catch (err) {
    console.error('[accounts] 清理分区失败', code, err.message);
  }
  return true;
}

async function clearAll() {
  const st = load();
  const codes = st.accounts.map((a) => a.code);
  st.accounts = [];
  save();
  await Promise.all(codes.map(async (c) => {
    try {
      const ses = session.fromPartition(partitionName(c));
      await ses.clearStorageData();
      await ses.clearCache();
    } catch (_) { /* 忽略 */ }
  }));
}

function addGroup(name) {
  const st = load();
  const g = { id: crypto.randomUUID().slice(0, 8), name: name || '新分组' };
  st.groups.push(g);
  save();
  return g;
}

function renameGroup(id, name) {
  const g = load().groups.find((x) => x.id === id);
  if (!g) return null;
  g.name = name;
  save();
  return g;
}

function removeGroup(id) {
  const st = load();
  if (id === 'default') return false;
  st.groups = st.groups.filter((g) => g.id !== id);
  st.accounts.forEach((a) => { if (a.groupId === id) a.groupId = 'default'; });
  save();
  return true;
}

module.exports = {
  load, save, list, get, groups, create, update, remove, clearAll,
  addGroup, renameGroup, removeGroup,
  sessionFor, partitionName, applyProxy
};
