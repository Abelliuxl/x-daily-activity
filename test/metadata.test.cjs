const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'x-daily-activity.user.js');
const source = fs.readFileSync(file, 'utf8');
const header = source.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/)?.[0];

assert.ok(header, '缺少 UserScript 元数据块');
assert.match(header, /@match\s+https:\/\/x\.com\/\*/);
assert.match(header, /@match\s+https:\/\/twitter\.com\/\*/);
assert.match(header, /@version\s+\d+\.\d+\.\d+/);
assert.match(header, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/Abelliuxl\/x-daily-activity\/main\/x-daily-activity\.user\.js/);
assert.match(header, /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/Abelliuxl\/x-daily-activity\/main\/x-daily-activity\.user\.js/);
assert.doesNotMatch(source, /gho_[A-Za-z0-9]+/i, '不应包含 GitHub token');

console.log('✓ userscript metadata');
