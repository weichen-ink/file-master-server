const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  CONFIG_PATH,
  prepareRawConfigYaml,
  prepareConfigPatch
} = require('../src/core/config');

test('Config preview validates and normalizes without writing config.yaml', () => {
  const writeFileSync = fs.writeFileSync;
  fs.writeFileSync = function (file, ...args) {
    if (file === CONFIG_PATH || file === `${CONFIG_PATH}.tmp`) {
      throw new Error('Config preview attempted to write config.yaml');
    }
    return writeFileSync.call(this, file, ...args);
  };

  try {
    assert.throws(() => prepareRawConfigYaml('invalid scalar'), /root element must be a key-value object/);
    assert.throws(() => prepareRawConfigYaml('image_host: invalid\n'), /image_host must be a key-value object/);
    assert.throws(
      () => prepareRawConfigYaml('image_host:\n  watermark_image: ../../outside.png\n'),
      /Invalid watermark_image path/
    );

    const prepared = prepareConfigPatch({ image_host: { max_width: 640 } });
    assert.equal(prepared.config.image_host.max_width, 640);
    assert.equal(prepared.config.image_host.webp_quality > 0, true);

    assert.equal(prepareConfigPatch({image_host:{rename_alias_days:14}}).config.image_host.rename_alias_days,14);
    for(const days of [0,-1,1.5,366,'seven']) assert.throws(()=>prepareConfigPatch({image_host:{rename_alias_days:days}}), /whole number/);

    const credentials = prepareConfigPatch({ password: 'new-password' });
    assert.match(credentials.config.password, /^scrypt:/);
  } finally {
    fs.writeFileSync = writeFileSync;
  }
});
