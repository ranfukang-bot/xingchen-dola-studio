'use strict';
/**
 * 校准模式。
 *
 * 用第一个账号打开页面，把动作条控件、菜单项、输入框、文件 input、发送按钮
 * 的真实结构全部导出到 probe-report.json，并截两张图。
 *
 * 这个工具是在连不上 dola.com 的环境里写的，选择器都是按原版脚本里出现过的
 * 属性推导的。跑一次 probe，把 probe-report.json 发回来，就能把选择器钉死。
 */
const fs = require('fs');
const path = require('path');
const log = require('./log');
const browser = require('./browser');
const C = require('./composer');

const ROOT = path.join(__dirname, '..');

async function main() {
  log.init(path.join(ROOT, 'logs'));
  log.step('校准模式');

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^﻿/, ''));
  const accountsFile = path.join(ROOT, 'accounts.json');
  if (!fs.existsSync(accountsFile)) {
    log.err('先把 accounts.json.example 复制成 accounts.json 并填入至少一个账号');
    process.exit(1);
  }
  const accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8').replace(/^﻿/, ''))
    .filter((a) => a && a.cookie && a.enabled !== false);
  if (!accounts.length) { log.err('accounts.json 里没有可用账号'); process.exit(1); }

  // 校准一定要看得见
  cfg['浏览器'] = { ...(cfg['浏览器'] || {}), headless: false };

  const report = { 生成时间: new Date().toISOString(), 账号: accounts[0].name || accounts[0].id };
  const ctx = await browser.contextFor(accounts[0], cfg);
  const page = await ctx.newPage();

  try {
    await C.gotoChat(page);
    report.页面标题 = await page.title().catch(() => '');
    report.当前地址 = page.url();
    report.登录态正常 = await C.ensureLoggedIn(page);
    log.info('登录态：' + (report.登录态正常 ? '正常' : '失效 —— 下面的结果会不准'));

    await page.screenshot({ path: path.join(ROOT, 'probe-1-进入.png'), fullPage: false }).catch(() => {});

    await C.ensureVideoMode(page);
    await C.sleep(1500);
    await page.screenshot({ path: path.join(ROOT, 'probe-2-视频模式.png'), fullPage: false }).catch(() => {});

    /* ---- 动作条控件 ---- */
    report.动作条控件 = await page.evaluate((attr) => {
      return Array.from(document.querySelectorAll('[' + attr + ']')).map((el) => ({
        key: el.getAttribute(attr),
        文本: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        标签: el.tagName.toLowerCase(),
        aria: el.getAttribute('aria-label') || '',
        可见: !!(el.offsetWidth || el.offsetHeight)
      }));
    }, C.CTRL_ATTR).catch(() => []);
    log.ok('动作条控件 ' + report.动作条控件.length + ' 个');
    for (const c of report.动作条控件) log.dim(c.key + '  →  「' + c.文本 + '」');

    /* ---- 逐个点开，记录菜单项 ---- */
    report.控件菜单 = {};
    for (const c of report.动作条控件) {
      if (!c.可见) continue;
      try {
        const before = await snapshotVisibleText(page);
        await page.locator('[' + C.CTRL_ATTR + '="' + c.key + '"]').first().click({ timeout: 5000 });
        await C.sleep(700);
        const after = await snapshotVisibleText(page);
        const added = after.filter((t) => !before.includes(t)).slice(0, 40);
        report.控件菜单[c.key] = added;
        log.dim(c.key + ' 菜单项：' + (added.join(' | ') || '(没捕捉到)'));
        await page.keyboard.press('Escape').catch(() => {});
        await C.sleep(400);
      } catch (err) {
        report.控件菜单[c.key] = ['(点开失败: ' + err.message + ')'];
      }
    }

    /* ---- 输入框 / 文件 input / 发送按钮 ---- */
    report.候选输入框 = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('textarea, [contenteditable="true"], input[type=text]').forEach((el) => {
        out.push({
          标签: el.tagName.toLowerCase(),
          placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
          contenteditable: el.getAttribute('contenteditable') || '',
          类名: (el.className || '').toString().slice(0, 100),
          testid: el.getAttribute('data-testid') || '',
          可见: !!(el.offsetWidth || el.offsetHeight)
        });
      });
      return out;
    }).catch(() => []);

    report.文件输入 = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input[type=file]')).map((el) => ({
        accept: el.getAttribute('accept') || '',
        multiple: el.hasAttribute('multiple'),
        类名: (el.className || '').toString().slice(0, 100),
        可见: !!(el.offsetWidth || el.offsetHeight)
      }));
    }).catch(() => []);

    report.候选发送按钮 = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('button, [role=button]').forEach((el) => {
        const aria = el.getAttribute('aria-label') || '';
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (/发送|send|提交|↑/i.test(aria + ' ' + txt)) {
          out.push({
            aria, 文本: txt.slice(0, 30),
            testid: el.getAttribute('data-testid') || '',
            类名: (el.className || '').toString().slice(0, 100)
          });
        }
      });
      return out;
    }).catch(() => []);

    /* ---- 原版脚本是否注入成功 ---- */
    report.原版脚本 = await page.evaluate(() => ({
      参考图脚本: !!window.__WANWAN_DOLA_REFERENCE_MATERIALS_V1__,
      素材面板API: typeof window.__WANWAN_MATERIAL_UPLOAD__ === 'object',
      时长改写: !!window.__WANWAN_DOLA_DURATION_REQUEST_PATCH__,
      开关_30s: (() => { try { return localStorage.getItem('intl_doubao_enable_30s_v1'); } catch (_) { return null; } })(),
      开关_15s: (() => { try { return localStorage.getItem('intl_doubao_enable_15s_v1'); } catch (_) { return null; } })()
    })).catch(() => ({}));

    log.ok('原版脚本注入：' + JSON.stringify(report.原版脚本, null, 0));

    const out = path.join(ROOT, 'probe-report.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
    log.ok('已导出 ' + out);
    log.info('把 probe-report.json 和两张 probe-*.png 发回来，我据此把选择器钉死。');
    log.info('浏览器窗口保持打开 60 秒，你可以手动点点看。');
    await C.sleep(60000);
  } finally {
    await ctx.close().catch(() => {});
    await browser.closeBrowser();
  }
}

async function snapshotVisibleText(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('div,span,li,button,[role=menuitem],[role=option]').forEach((el) => {
      if (!(el.offsetWidth || el.offsetHeight)) return;
      if (el.children.length) return;           // 只要叶子节点，避免整段文本
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 24) out.push(t);
    });
    return [...new Set(out)];
  }).catch(() => []);
}

main().catch((err) => {
  log.err(err.stack || err.message);
  process.exit(1);
});
