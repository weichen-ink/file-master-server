const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.resolve(__dirname, '../src/public');

function usedKeys(html) {
  return [...html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)].map((match) => match[1]);
}

test('console has Chinese and English copy for every translated element', () => {
  const source = fs.readFileSync(path.join(publicDir, 'assets/i18n.js'), 'utf8');
  const html = fs.readFileSync(path.join(publicDir, 'console.html'), 'utf8');
  const strings = new Function('localStorage', `${source}\nreturn I18N;`)({ getItem: () => null });

  assert.deepEqual(Object.keys(strings.zh).sort(), Object.keys(strings.en).sort());
  for (const language of ['zh', 'en']) {
    assert.deepEqual(usedKeys(html).filter((key) => !(key in strings[language])), []);
  }
});

test('setup page has Chinese and English copy for every translated element', () => {
  const html = fs.readFileSync(path.join(publicDir, 'setup.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new Function(script);

  const start = script.indexOf('const setupCopy');
  const end = script.indexOf('let setupLocale');
  assert.ok(start >= 0 && end > start);
  const strings = new Function(`${script.slice(start, end)}\nreturn setupCopy;`)();

  assert.deepEqual(Object.keys(strings.zh).sort(), Object.keys(strings.en).sort());
  for (const language of ['zh', 'en']) {
    assert.deepEqual(usedKeys(html).filter((key) => !(key in strings[language])), []);
  }
});
