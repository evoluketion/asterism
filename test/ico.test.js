'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeIco } = require('../scripts/ico');

test('encodeIco writes a directory entry per image and appends the PNGs in order', () => {
  const a = Buffer.from('first-png');
  const b = Buffer.from('second');
  const ico = encodeIco([{ size: 16, png: a }, { size: 256, png: b }]);

  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);

  const dataStart = 6 + 16 * 2;
  assert.equal(ico.readUInt8(6), 16);
  assert.equal(ico.readUInt8(7), 16);
  assert.equal(ico.readUInt16LE(6 + 4), 1);
  assert.equal(ico.readUInt16LE(6 + 6), 32);
  assert.equal(ico.readUInt32LE(6 + 8), a.length);
  assert.equal(ico.readUInt32LE(6 + 12), dataStart);

  assert.equal(ico.readUInt8(22), 0, '256 is stored as 0');
  assert.equal(ico.readUInt8(23), 0);
  assert.equal(ico.readUInt32LE(22 + 8), b.length);
  assert.equal(ico.readUInt32LE(22 + 12), dataStart + a.length);

  assert.deepEqual(ico.subarray(dataStart), Buffer.concat([a, b]));
});

test('encodeIco rejects sizes an icon directory cannot hold', () => {
  assert.throws(() => encodeIco([{ size: 512, png: Buffer.alloc(1) }]), RangeError);
  assert.throws(() => encodeIco([{ size: 0, png: Buffer.alloc(1) }]), RangeError);
});
