'use strict';
/**
 * 进度状态：断点续跑 + 每日额度计数。
 *
 * Dola 的生成额度按天重置，所以账号计数以「本地日期」为键，
 * 跨天自动归零，不用手动清理。
 */
const fs = require('fs');
const path = require('path');

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function load(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s.date !== today()) {
      // 跨天：额度重置，但保留历史累计
      return { date: today(), used: {}, done: s.done || [], failed: s.failed || [], history: s.history || [] };
    }
    s.used = s.used || {};
    s.done = s.done || [];
    s.failed = s.failed || [];
    s.history = s.history || [];
    return s;
  } catch (_) {
    return { date: today(), used: {}, done: [], failed: [], history: [] };
  }
}

function save(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

/** 某账号今天已用次数 */
function used(state, accountId) {
  return Number(state.used[accountId] || 0);
}

function bump(state, accountId) {
  state.used[accountId] = used(state, accountId) + 1;
}

/** 标记账号今日额度耗尽（不等于用满配置条数，是服务端说没了） */
function exhaust(state, accountId, quota) {
  state.used[accountId] = Math.max(used(state, accountId), quota);
}

function record(state, entry) {
  state.history.push({ at: new Date().toISOString(), ...entry });
  if (state.history.length > 2000) state.history.splice(0, state.history.length - 2000);
}

module.exports = { load, save, used, bump, exhaust, record, today };
