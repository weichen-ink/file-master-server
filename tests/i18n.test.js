const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.resolve(__dirname, '../src/public');

function usedKeys(html) {
  return [...html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)].map((match) => match[1]);
}

test('Console translations cover both languages, schema fields and module UI labels', async () => {
  const { messages, translations } = await import('../src/public/assets/admin/locale.mjs');
  const { schemas } = await import('../src/public/assets/admin/features/settings-schema.mjs');
  assert.deepEqual(Object.keys(translations.zh).sort(), Object.keys(translations.en).sort());
  const keys = new Set([...Object.keys(messages), ...Object.keys(translations.zh)]);
  for (const [key, pair] of Object.entries(messages)) {
    assert.equal(pair.length, 2, key);
    assert.ok(pair.every((value) => typeof value === 'string' && value.length), key);
  }
  for (const fields of Object.values(schemas)) for (const field of fields) {
    assert.ok(keys.has(field.label), field.label);
    for (const [, label] of field.options || []) assert.ok(keys.has(label), label);
  }
  const folder = path.join(publicDir, 'assets/admin');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  for (const file of walk(folder).filter((file) => file.endsWith('.mjs') && !file.endsWith('translations.mjs'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [, , key] of text.matchAll(/(?:\bt|\bbutton|\bheading|\bempty|\bkv)\(\s*(['"])([^'"]+)\1/g)) {
      assert.ok(keys.has(key) || ['SHA-256'].includes(key), `${path.basename(file)}: ${key}`);
    }
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
