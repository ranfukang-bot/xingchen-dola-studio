'use strict';
/**
 * 队列：文件夹约定。
 *
 *   queue/
 *     001-椰子水/
 *       prompt.txt        提示词（UTF-8 纯文本）
 *       1.jpg  2.jpg      这条任务自己的参考图，按文件名排序
 *     002-手机壳/
 *       prompt.txt
 *       a.png
 *
 * 按文件夹名排序依次生成。完成的整个文件夹移到 queue-done/，失败的移到 queue-failed/。
 */
const fs = require('fs');
const path = require('path');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.apng']);
// 原版 dola-reference-materials.js 里 MATERIAL_LIMITS.image = 30
const MAX_IMAGES = 30;

function readPrompt(dir) {
  for (const name of ['prompt.txt', 'prompt.md', '提示词.txt']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      // 去掉 BOM，保留内部换行
      return fs.readFileSync(p, 'utf8').replace(/^﻿/, '').trim();
    }
  }
  return '';
}

function listImages(dir) {
  return fs.readdirSync(dir)
    .filter((n) => IMAGE_EXT.has(path.extname(n).toLowerCase()))
    .filter((n) => !n.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
    .slice(0, MAX_IMAGES)
    .map((n) => path.join(dir, n));
}

/**
 * 扫描队列目录。
 * @returns {Array<{id,dir,name,prompt,images,problems}>}
 */
function scan(queueDir) {
  if (!fs.existsSync(queueDir)) return [];

  const out = [];
  const names = fs.readdirSync(queueDir)
    .filter((n) => !n.startsWith('.') && !n.startsWith('_'))
    .filter((n) => {
      try { return fs.statSync(path.join(queueDir, n)).isDirectory(); }
      catch (_) { return false; }
    })
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));

  for (const name of names) {
    const dir = path.join(queueDir, name);
    const prompt = readPrompt(dir);
    const images = listImages(dir);
    const problems = [];
    if (!prompt) problems.push('缺少 prompt.txt 或内容为空');
    if (!images.length) problems.push('文件夹里没有图片');

    out.push({ id: name, dir, name, prompt, images, problems });
  }
  return out;
}

/** 任务做完后把整个文件夹挪走，天然实现「不重复生成」。 */
function archive(task, targetRoot) {
  fs.mkdirSync(targetRoot, { recursive: true });
  let dest = path.join(targetRoot, task.name);
  let i = 1;
  while (fs.existsSync(dest)) dest = path.join(targetRoot, task.name + '_' + i++);
  try {
    fs.renameSync(task.dir, dest);
  } catch (err) {
    // 跨盘符时 rename 会失败，退化成复制 + 删除
    copyDir(task.dir, dest);
    fs.rmSync(task.dir, { recursive: true, force: true });
  }
  return dest;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const n of fs.readdirSync(src)) {
    const s = path.join(src, n);
    const d = path.join(dst, n);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = { scan, archive, IMAGE_EXT, MAX_IMAGES };
