'use strict';
/**
 * chrome.downloads -> Electron 下载。
 *
 * 不用 session.downloadURL，而是走 net.request 自己拉流，原因有两个：
 *   1. 这些媒体 CDN（byteintlapi / everphoto-media 等）校验 Referer，
 *      必须按来源页带上，否则 403；
 *   2. 要给前端回 DOLA_NATIVE_DOWNLOAD_PROGRESS 进度事件。
 *
 * 下载统一落到「作品库」目录，对应截图底部的作品库面板。
 */
const fs = require('fs');
const path = require('path');
const { app, net, shell } = require('electron');
const accounts = require('./accounts');

let nextId = 1;
/** id -> {state, received, total, filename, url} */
const items = new Map();
let onChanged = () => {};

function setOnChanged(fn) {
  onChanged = typeof fn === 'function' ? fn : () => {};
}

function libraryRoot() {
  const dir = path.join(app.getPath('downloads'), '星辰Dola作品库');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitize(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180) || ('dola-' + Date.now());
}

function guessExt(url, contentType) {
  const fromUrl = (url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  if (fromUrl) return '.' + fromUrl.toLowerCase();
  const map = {
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif'
  };
  return map[String(contentType || '').split(';')[0].trim()] || '.bin';
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  let i = 1;
  while (fs.existsSync(p)) {
    p = path.join(dir, base + '(' + i + ')' + ext);
    i++;
  }
  return p;
}

/**
 * @param {object} opts {url, filename, referer, accountCode, subdir, headers}
 * @returns {Promise<number>} downloadId
 */
function download(opts = {}) {
  const url = String(opts.url || '');
  if (!/^https?:/i.test(url)) return Promise.reject(new Error('下载地址无效: ' + url));

  const id = nextId++;
  const rec = { id, state: 'in_progress', received: 0, total: 0, filename: '', url };
  items.set(id, rec);

  const ses = opts.accountCode ? accounts.sessionFor(opts.accountCode) : undefined;

  const req = net.request({ url, method: 'GET', session: ses, useSessionCookies: !!ses });
  if (opts.referer) req.setHeader('Referer', opts.referer);
  req.setHeader('Accept', '*/*');
  for (const [k, v] of Object.entries(opts.headers || {})) {
    try { req.setHeader(k, String(v)); } catch (_) {}
  }

  return new Promise((resolve, reject) => {
    req.on('response', (res) => {
      if (res.statusCode >= 400) {
        rec.state = 'interrupted';
        rec.error = 'HTTP ' + res.statusCode;
        onChanged(rec);
        res.resume();
        reject(new Error('下载失败 HTTP ' + res.statusCode));
        return;
      }

      // net 模块的 header 值可能是 string 也可能是 string[]，两种都要吃得下
      const head = (name) => {
        const v = res.headers[name];
        return Array.isArray(v) ? (v[0] || '') : (v == null ? '' : String(v));
      };
      const ctype = head('content-type');
      rec.total = Number(head('content-length')) || 0;

      const dir = opts.subdir
        ? path.join(libraryRoot(), sanitize(opts.subdir))
        : libraryRoot();
      fs.mkdirSync(dir, { recursive: true });

      const rawBase = sanitize(opts.filename || path.basename(url.split('?')[0]) || ('dola-' + Date.now()));
      const hasExt = /\.[a-z0-9]{2,5}$/i.test(rawBase);
      const base = hasExt ? rawBase.replace(/\.[a-z0-9]{2,5}$/i, '') : rawBase;
      const ext = hasExt ? rawBase.slice(base.length) : guessExt(url, ctype);
      const dest = uniquePath(dir, base, ext);

      rec.filename = dest;
      const out = fs.createWriteStream(dest);

      res.on('data', (chunk) => {
        rec.received += chunk.length;
        out.write(chunk);
        onChanged(rec);
      });
      res.on('end', () => {
        out.end(() => {
          rec.state = 'complete';
          onChanged(rec);
          resolve(id);
        });
      });
      res.on('error', (err) => {
        rec.state = 'interrupted';
        rec.error = err.message;
        onChanged(rec);
        out.destroy();
        reject(err);
      });
    });

    req.on('error', (err) => {
      rec.state = 'interrupted';
      rec.error = err.message;
      onChanged(rec);
      reject(err);
    });

    req.end();
  });
}

function search(query = {}) {
  let list = Array.from(items.values());
  if (query.id != null) list = list.filter((x) => x.id === Number(query.id));
  if (query.state) list = list.filter((x) => x.state === query.state);
  return list;
}

function listLibrary() {
  const root = libraryRoot();
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else out.push({ name, path: full, size: st.size, mtime: st.mtimeMs });
    }
  };
  try { walk(root, 0); } catch (_) {}
  return out.sort((a, b) => b.mtime - a.mtime);
}

function revealLibrary() {
  shell.openPath(libraryRoot());
}

module.exports = { download, search, setOnChanged, libraryRoot, listLibrary, revealLibrary };
