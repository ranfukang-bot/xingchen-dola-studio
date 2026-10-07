'use strict';
/**
 * 页面操作层：进视频模式 -> 选模型/比例 -> 传图 -> 填提示词 -> 提交 -> 判结果。
 *
 * 说明：本工具在无法访问 dola.com 的环境中写成，页面选择器是依据原版注入脚本
 * 里出现过的真实属性推导的（data-input-engine-actionbar-control-key 等）。
 * 因此每个动作都做了多级降级，并把命中的策略打进日志；跑 probe 可以把真实
 * 结构导出来，再用 config.json 的 _选择器 段钉死。
 */
const log = require('./log');

const CHAT_URL = 'https://www.dola.com/chat';

/* ============ 结果分类：与原版 ba_curl_submit.py 的 classify() 对齐 ============ */
const OUTCOME = {
  ACCEPTED: 'ACCEPTED',
  QUOTA_EXHAUSTED: 'BA_QUOTA_EXHAUSTED',
  CREDITS_INSUFFICIENT: 'BA_VIDEO_CREDITS_INSUFFICIENT',
  EXPERT_QUOTA: 'BA_EXPERT_QUOTA_EXHAUSTED',
  LOGIN_REQUIRED: 'BA_LOGIN_REQUIRED',
  RATE_LIMITED: 'BA_RATE_LIMITED',
  UNCERTAIN: 'BA_POST_SUBMIT_UNCERTAIN'
};

function classify(text) {
  const t = String(text || '');
  if (t.includes('无法生成该视频') && t.includes('视频生成额度') && t.includes('剩余')) {
    return { code: OUTCOME.CREDITS_INSUFFICIENT, msg: '本次配置额度不足' };
  }
  for (const kw of ['今天的生成次数已经达到上限', '明天再来免费生成', '视频生成额度不足']) {
    if (t.includes(kw)) return { code: OUTCOME.QUOTA_EXHAUSTED, msg: '今天的生成次数已经达到上限' };
  }
  if ((t.includes('mode_downgrade_reason') && t.includes('user_quota')) || t.includes('今日专家模式使用已达上限')) {
    return { code: OUTCOME.EXPERT_QUOTA, msg: '今日专家模式使用已达上限' };
  }
  if (t.includes('游客') || t.includes('请登录') || /log ?in/i.test(t)) {
    return { code: OUTCOME.LOGIN_REQUIRED, msg: '登录态失效' };
  }
  if (t.includes('频繁') || t.includes('稍后再试') || /try again later/i.test(t)) {
    return { code: OUTCOME.RATE_LIMITED, msg: '访问频繁，被限流' };
  }
  return null;
}

/* ============ 通用小工具 ============ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    if (!sel) continue;
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1200 })) return { loc, sel };
    } catch (_) { /* 下一个 */ }
  }
  return null;
}

/** 按可见文本找可点元素 */
async function byText(page, pattern, tags = ['button', '[role=button]', '[role=menuitem]', '[role=option]', 'div', 'span', 'li']) {
  for (const tag of tags) {
    try {
      const loc = page.locator(tag, { hasText: pattern }).last();
      if (await loc.isVisible({ timeout: 800 })) return loc;
    } catch (_) { /* 继续 */ }
  }
  return null;
}

/* ============ 动作条控件 ============ */
const CTRL_ATTR = 'data-input-engine-actionbar-control-key';

/**
 * 找动作条上的某个控件。
 * @param kind 'model' | 'duration' | 'ratio'
 */
async function findControl(page, kind, override) {
  if (override) {
    const hit = await firstVisible(page, [override]);
    if (hit) return { loc: hit.loc, how: 'config 覆盖' };
  }

  const exact = [
    `[${CTRL_ATTR}="video-${kind}"]`,
    `[${CTRL_ATTR}="${kind}"]`,
    `[${CTRL_ATTR}*="${kind}"]`
  ];
  const hit = await firstVisible(page, exact);
  if (hit) return { loc: hit.loc, how: hit.sel };

  // 兜底：扫全部控件，用文本特征认
  const patterns = {
    model: /模型|seedance|\d\.\d/i,
    duration: /^\s*\d+\s*(s|秒)\s*$|时长/i,
    ratio: /\d+\s*[:：]\s*\d+|比例/
  };
  const all = page.locator(`[${CTRL_ATTR}]`);
  const n = await all.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    const txt = ((await el.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (patterns[kind] && patterns[kind].test(txt)) {
      return { loc: el, how: '文本匹配 "' + txt + '"' };
    }
  }
  return null;
}

async function controlText(ctrl) {
  return ((await ctrl.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
}

/**
 * 点开控件，在弹出菜单里选中目标项。
 * @param target 目标文本，如 '2.5' / '9:16' / '30s'
 * @param accept 判定是否已选中的正则
 */
async function pickOption(page, ctrl, target, accept, label) {
  const before = await controlText(ctrl);
  if (accept.test(before)) {
    log.dim(label + '已经是目标值（' + before + '），跳过');
    return true;
  }

  await ctrl.click({ timeout: 8000 }).catch(() => {});
  await sleep(500);

  // 目标项可能写成 "9:16" 也可能 "9：16"，或 "30s" / "30秒"
  const variants = optionVariants(target);
  for (const v of variants) {
    const item = await byText(page, v);
    if (item) {
      await item.click({ timeout: 6000 }).catch(() => {});
      await sleep(600);
      const after = await controlText(ctrl);
      if (accept.test(after)) {
        log.dim(label + '已设为 ' + target + '（命中「' + v + '」）');
        return true;
      }
    }
  }

  // 菜单没关掉的话按 Esc 复位，避免挡住后续操作
  await page.keyboard.press('Escape').catch(() => {});
  const after = await controlText(ctrl);
  if (accept.test(after)) return true;

  log.warn(label + '未能设为 ' + target + '（当前显示「' + after + '」）');
  return false;
}

function optionVariants(target) {
  const t = String(target);
  const out = [t];
  if (/^\d+:\d+$/.test(t)) out.push(t.replace(':', '：'));
  if (/^\d+$/.test(t)) out.push(t + 's', t + '秒');
  if (/^\d+s$/i.test(t)) out.push(t.replace(/s$/i, '秒'), t.replace(/s$/i, ''));
  if (t === '2.5') out.push('Seedance 2.5', 'seedance2.5', '2.5 ');
  return [...new Set(out)];
}

/* ============ 各步骤 ============ */

async function gotoChat(page) {
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await sleep(1500);
}

/** 确认登录态：没登录就没法往下做 */
async function ensureLoggedIn(page) {
  const txt = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  const hit = classify(txt);
  if (hit && hit.code === OUTCOME.LOGIN_REQUIRED) return false;
  if (/登录|Log ?in/i.test(txt) && !/新对话|发送消息|描述你想要/.test(txt)) return false;
  return true;
}

/** 进入「视频生成」模式 */
async function ensureVideoMode(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  // 已经是视频模式：输入框上方会挂着「视频生成 ×」的 chip
  if (/视频生成\s*[×x✕]/.test(body)) {
    log.dim('已处于视频生成模式');
    return true;
  }

  const btn = await byText(page, /^\s*视频生成\s*$/);
  if (btn) {
    await btn.click({ timeout: 8000 }).catch(() => {});
    await sleep(1200);
    log.dim('已点选「视频生成」');
    return true;
  }

  log.warn('没找到「视频生成」入口，可能页面已默认在视频模式');
  return false;
}

async function setModel(page, model, override) {
  const c = await findControl(page, 'model', override);
  if (!c) { log.warn('没找到模型控件'); return false; }
  log.dim('模型控件定位方式：' + c.how);
  return pickOption(page, c.loc, model, new RegExp(String(model).replace('.', '\\.')), '模型');
}

async function setRatio(page, ratio, override) {
  const c = await findControl(page, 'ratio', override);
  if (!c) { log.warn('没找到比例控件'); return false; }
  log.dim('比例控件定位方式：' + c.how);
  const esc = String(ratio).replace(':', '\\s*[:：]\\s*');
  return pickOption(page, c.loc, ratio, new RegExp(esc), '比例');
}

/**
 * 时长：优先靠原版 hook 的 localStorage 开关（它会改写请求里的
 * ability_param.duration），UI 控件只是让界面显示一致。
 */
async function setDuration(page, seconds, override) {
  const v = Number(seconds) === 15 ? 15 : 30;
  await page.evaluate((sec) => {
    try {
      localStorage.setItem('intl_doubao_enable_' + sec + 's_v1', '1');
      localStorage.setItem('intl_doubao_enable_' + (sec === 15 ? 30 : 15) + 's_v1', '0');
      window.dispatchEvent(new CustomEvent('wanwan-duration-change', { detail: sec }));
    } catch (_) {}
  }, v).catch(() => {});

  const c = await findControl(page, 'duration', override);
  if (c) {
    log.dim('时长控件定位方式：' + c.how);
    await pickOption(page, c.loc, v + 's', new RegExp('\\b' + v + '\\s*(s|秒)'), '时长');
  }
  log.dim('时长开关已写入（' + v + ' 秒），请求改写由原版 hook 负责');
  return true;
}

/** 上传这条任务自己的参考图 */
async function uploadImages(page, files, override) {
  if (!files || !files.length) return true;

  // 策略 1：直接给文件 input 喂文件（最稳，不依赖弹窗）
  const selectors = [
    override,
    'input[type=file][accept*="webp"]',
    'input[type=file][accept*="image"]',
    'input[type=file][multiple]',
    'input[type=file]'
  ].filter(Boolean);

  for (const sel of selectors) {
    try {
      const input = page.locator(sel).first();
      if (await input.count()) {
        await input.setInputFiles(files, { timeout: 30000 });
        log.dim('已通过 ' + sel + ' 提交 ' + files.length + ' 张图');
        await waitUploads(page, files.length);
        return true;
      }
    } catch (_) { /* 下一个 */ }
  }

  // 策略 2：点「+」触发文件选择器
  try {
    const plus = await byText(page, /^\s*\+\s*$/) ||
      page.locator('[aria-label*="上传"], [aria-label*="附件"], [aria-label*="添加"]').first();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      plus.click({ timeout: 6000 })
    ]);
    await chooser.setFiles(files);
    log.dim('已通过文件选择器提交 ' + files.length + ' 张图');
    await waitUploads(page, files.length);
    return true;
  } catch (_) { /* 落到失败 */ }

  log.warn('图片上传入口没找到，这条任务会在无参考图的情况下生成');
  return false;
}

/** 等缩略图出现 / 上传进度结束 */
async function waitUploads(page, count) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const busy = await page.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      return /上传中|正在上传|uploading/i.test(t);
    }).catch(() => false);
    if (!busy) {
      await sleep(1200);
      return true;
    }
    await sleep(1500);
  }
  log.warn('等待图片上传超时（120s），继续往下走');
  return false;
}

async function fillPrompt(page, text, override) {
  const hit = await firstVisible(page, [
    override,
    'textarea[placeholder*="描述"]',
    'textarea[placeholder*="发送消息"]',
    '[contenteditable="true"][data-slate-editor]',
    '[contenteditable="true"]',
    'textarea'
  ]);
  if (!hit) throw new Error('没找到提示词输入框');

  await hit.loc.click({ timeout: 8000 });
  await sleep(200);

  // contenteditable 用键盘输入，textarea 用 fill
  const tag = await hit.loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  if (tag === 'textarea' || tag === 'input') {
    await hit.loc.fill(text, { timeout: 15000 });
  } else {
    await page.keyboard.insertText(text);
  }
  await sleep(400);
  log.dim('提示词已填入（' + text.length + ' 字，入口 ' + hit.sel + '）');
  return true;
}

async function submit(page, override) {
  const hit = await firstVisible(page, [
    override,
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    '[data-testid*="send"]',
    'button[type=submit]'
  ]);
  if (hit) {
    await hit.loc.click({ timeout: 8000 });
    log.dim('已点击发送（' + hit.sel + '）');
    return true;
  }
  // 兜底：回车
  await page.keyboard.press('Enter');
  log.dim('已按回车提交');
  return true;
}

/**
 * 等待提交结果。
 * 同时盯两路：/chat/completion 的响应体，以及页面上出现的回复文案。
 */
async function awaitOutcome(page, timeoutMs) {
  let netResult = null;

  const onResponse = async (res) => {
    try {
      if (!/\/chat\/completion\/?($|\?)/.test(res.url())) return;
      const body = await res.text().catch(() => '');
      if (!body) return;
      if (body.includes('SSE_ACK')) {
        const m = body.match(/conversation_id"\s*:\s*"(\d{10,25})/);
        netResult = { code: OUTCOME.ACCEPTED, msg: '已提交', conversationId: m ? m[1] : '', raw: body.slice(0, 600) };
        return;
      }
      const hit = classify(body);
      if (hit) netResult = { ...hit, raw: body.slice(0, 600) };
    } catch (_) { /* 忽略 */ }
  };

  page.on('response', onResponse);

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (netResult) return netResult;

      // 页面文案兜底。
      //
      // 先认「受理」再认「失败」：成功的回复里本来就带着
      // 「将消耗 2 个视频生成额度…今日剩余 0 个视频生成额度」这种句子，
      // 而扫的是整个 body（含历史消息），先判错容易把成功误伤成额度耗尽。
      // 这两类文案在同一条回复里是互斥的，所以这个顺序是安全的。
      const txt = await page.locator('body').innerText().catch(() => '');
      if (/将消耗\s*\d+\s*个视频生成额度|预计等待|视频生成好后/.test(txt)) {
        return { code: OUTCOME.ACCEPTED, msg: '已提交（页面已确认受理）', raw: '(来自页面文案)' };
      }
      const hit = classify(txt);
      if (hit) return { ...hit, raw: '(来自页面文案)' };

      await sleep(2000);
    }
    return { code: OUTCOME.UNCERTAIN, msg: '等待超时，未能确认是否受理', raw: '' };
  } finally {
    page.off('response', onResponse);
  }
}

module.exports = {
  CHAT_URL, OUTCOME, classify,
  gotoChat, ensureLoggedIn, ensureVideoMode,
  setModel, setRatio, setDuration,
  uploadImages, fillPrompt, submit, awaitOutcome,
  sleep, findControl, CTRL_ATTR
};
