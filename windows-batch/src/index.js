'use strict';
/**
 * 批量生成主流程。
 *
 *   队列(文件夹) × 账号池  ->  逐条提交  ->  额度耗尽自动换号  ->  断点续跑
 *
 * 不修改创作台本体，完全独立运行。
 */
const fs = require('fs');
const path = require('path');

const log = require('./log');
const queue = require('./queue');
const state = require('./state');
const browser = require('./browser');
const C = require('./composer');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

function readJson(file, what) {
  if (!fs.existsSync(file)) throw new Error('找不到 ' + what + '：' + file);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(what + ' 不是合法 JSON：' + err.message);
  }
}

function rand(min, max) {
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

async function main() {
  const cfg = readJson(path.join(ROOT, 'config.json'), 'config.json');
  const paths = cfg['路径'] || {};
  const logFile = log.init(path.join(ROOT, paths['日志目录'] || 'logs'));

  log.step('星辰Dola 批量生成');
  log.dim('日志：' + logFile);

  /* ---- 账号 ---- */
  const accountsFile = path.join(ROOT, 'accounts.json');
  if (!fs.existsSync(accountsFile)) {
    log.err('还没有 accounts.json。把 accounts.json.example 复制成 accounts.json 并填入你的账号 Cookie。');
    process.exit(1);
  }
  const accounts = readJson(accountsFile, 'accounts.json')
    .filter((a) => a && a.cookie && a.enabled !== false);
  if (!accounts.length) {
    log.err('accounts.json 里没有可用账号');
    process.exit(1);
  }

  /* ---- 队列 ---- */
  const queueDir = path.join(ROOT, paths['队列目录'] || 'queue');
  const tasks = queue.scan(queueDir);
  const good = tasks.filter((t) => !t.problems.length);
  const bad = tasks.filter((t) => t.problems.length);

  log.info('账号 ' + accounts.length + ' 个，任务 ' + good.length + ' 条可用' +
    (bad.length ? '，' + bad.length + ' 条有问题' : ''));
  for (const t of bad) log.warn('跳过 ' + t.name + '：' + t.problems.join('；'));

  if (!good.length) {
    log.err('队列里没有可执行的任务。每个任务是一个文件夹，里面要有 prompt.txt 和至少一张图片。');
    process.exit(1);
  }

  /* ---- 状态 ---- */
  const stateFile = path.join(ROOT, paths['进度文件'] || 'state.json');
  const st = state.load(stateFile);
  const quota = Number(cfg['每个账号生成条数']) || 2;
  const prefix = String(cfg['提示词前缀'] || '');
  const gen = cfg['生成参数'] || {};
  const thr = cfg['节流'] || {};
  const sel = cfg['_选择器'] || {};

  const capacity = accounts.reduce((s, a) => s + Math.max(0, quota - state.used(st, a.id)), 0);
  log.info('今日剩余产能 ' + capacity + ' 条（' + accounts.length + ' 账号 × ' + quota + '，日期 ' + st.date + '）');
  if (capacity < good.length) {
    log.warn('产能不足以跑完队列，本次会先做 ' + capacity + ' 条，其余留在 queue/ 里下次继续');
  }

  if (DRY) {
    log.step('试运行，不启动浏览器');
    for (const t of good.slice(0, capacity)) {
      log.ok(t.name + ' — ' + t.images.length + ' 张图，提示词 ' + t.prompt.length + ' 字');
      log.dim('  最终提示词：' + (prefix + t.prompt).slice(0, 90) + '…');
    }
    return;
  }

  /* ---- 跑 ---- */
  const doneDir = path.join(ROOT, paths['完成目录'] || 'queue-done');
  const failDir = path.join(ROOT, paths['失败目录'] || 'queue-failed');
  let pending = good.slice();
  let okCount = 0;
  let failCount = 0;

  try {
    for (const acct of accounts) {
      if (!pending.length) break;
      let left = quota - state.used(st, acct.id);
      if (left <= 0) {
        log.dim('账号 ' + (acct.name || acct.id) + ' 今日额度已用完，跳过');
        continue;
      }

      log.step('切换到账号：' + (acct.name || acct.id) + '（今日还可 ' + left + ' 条）');
      let ctx = null;
      try {
        ctx = await browser.contextFor(acct, cfg);
        const page = await ctx.newPage();
        await C.gotoChat(page);

        if (!(await C.ensureLoggedIn(page))) {
          log.err('账号 ' + (acct.name || acct.id) + ' 登录态失效，跳过。请在创作台里重新登录后重新导出 Cookie。');
          state.record(st, { account: acct.id, code: C.OUTCOME.LOGIN_REQUIRED });
          state.save(stateFile, st);
          continue;
        }

        while (left > 0 && pending.length) {
          const task = pending[0];
          const res = await runTask(page, task, { prefix, gen, thr, sel });

          state.record(st, { account: acct.id, task: task.name, code: res.code, msg: res.msg });

          if (res.code === C.OUTCOME.ACCEPTED) {
            pending.shift();
            state.bump(st, acct.id);
            left--;
            okCount++;
            const dest = queue.archive(task, doneDir);
            log.ok(task.name + ' 已提交' + (res.conversationId ? '（会话 ' + res.conversationId + '）' : '') +
              '，文件夹移到 ' + path.basename(dest));
          } else if (res.code === C.OUTCOME.QUOTA_EXHAUSTED ||
                     res.code === C.OUTCOME.CREDITS_INSUFFICIENT ||
                     res.code === C.OUTCOME.EXPERT_QUOTA) {
            log.warn('账号 ' + (acct.name || acct.id) + ' 额度耗尽：' + res.msg + ' → 换下一个账号');
            state.exhaust(st, acct.id, quota);
            left = 0;
          } else if (res.code === C.OUTCOME.LOGIN_REQUIRED) {
            log.err('账号登录态在中途失效 → 换下一个账号');
            left = 0;
          } else if (res.code === C.OUTCOME.RATE_LIMITED) {
            log.warn('被限流，等 3 分钟后换账号');
            await C.sleep(180000);
            left = 0;
          } else {
            // UNCERTAIN：不确定是否受理，保守处理 —— 不重复提交，移到失败区待人工确认
            pending.shift();
            failCount++;
            const dest = queue.archive(task, failDir);
            log.warn(task.name + ' 结果不确定（' + res.msg + '），已移到 ' + path.basename(dest) +
              '。请到创作台里确认是否已生成，确认没有再挪回 queue/。');
            state.bump(st, acct.id);
            left--;
          }

          state.save(stateFile, st);

          if (left > 0 && pending.length) {
            const wait = rand(Number(thr['提交间隔最小']) || 45000, Number(thr['提交间隔最大']) || 90000);
            log.dim('等待 ' + Math.round(wait / 1000) + ' 秒后继续…');
            await C.sleep(wait);
          }
        }
      } catch (err) {
        log.err('账号 ' + (acct.name || acct.id) + ' 出错：' + err.message);
        state.record(st, { account: acct.id, code: 'ERROR', msg: err.message });
        state.save(stateFile, st);
      } finally {
        if (ctx) await ctx.close().catch(() => {});
      }

      if (pending.length) {
        const w = Number(thr['换账号间隔']) || 20000;
        log.dim('换号冷却 ' + Math.round(w / 1000) + ' 秒…');
        await C.sleep(w);
      }
    }
  } finally {
    await browser.closeBrowser();
  }

  log.step('本次结束');
  log.ok('成功提交 ' + okCount + ' 条');
  if (failCount) log.warn('待确认 ' + failCount + ' 条（在 queue-failed/）');
  if (pending.length) log.info('队列里还剩 ' + pending.length + ' 条，明天额度恢复后再跑即可');
}

/** 跑一条任务 */
async function runTask(page, task, { prefix, gen, thr, sel }) {
  log.step('任务 ' + task.name + '（' + task.images.length + ' 张图）');

  // 每条任务都开新对话，避免上下文串味
  await C.gotoChat(page);
  await C.ensureVideoMode(page);

  await C.setModel(page, gen['模型'] || '2.5', sel['模型控件']);
  await C.setDuration(page, gen['时长秒'] || 30, sel['时长控件']);
  await C.setRatio(page, gen['比例'] || '9:16', sel['比例控件']);

  await C.uploadImages(page, task.images, sel['图片输入']);

  const full = prefix + task.prompt;
  await C.fillPrompt(page, full, sel['提示词输入框']);

  await C.submit(page, sel['发送按钮']);

  const res = await C.awaitOutcome(page, Number(thr['单条超时']) || 180000);
  if (res.code === C.OUTCOME.ACCEPTED) log.ok('受理：' + res.msg);
  else log.warn('结果：' + res.code + ' — ' + res.msg);
  return res;
}

main().catch((err) => {
  log.err(err.stack || err.message);
  process.exit(1);
});
