'use strict';
const fs = require('fs');
const path = require('path');

let stream = null;

const COLOR = {
  info: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m',
  err: '\x1b[31m', dim: '\x1b[90m', reset: '\x1b[0m'
};

function init(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  stream = fs.createWriteStream(path.join(logDir, 'run-' + stamp + '.log'), { flags: 'a' });
  return path.join(logDir, 'run-' + stamp + '.log');
}

function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function write(level, msg) {
  const line = '[' + ts() + '] ' + msg;
  const color = COLOR[level] || '';
  console.log(color + line + COLOR.reset);
  if (stream) stream.write(line + '\n');
}

module.exports = {
  init,
  info: (m) => write('info', m),
  ok: (m) => write('ok', '✓ ' + m),
  warn: (m) => write('warn', '! ' + m),
  err: (m) => write('err', '✗ ' + m),
  dim: (m) => write('dim', '  ' + m),
  step: (m) => write('info', '— ' + m)
};
