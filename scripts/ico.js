'use strict';

/**
 * Packs square PNG images into one .ico file. Entries keep their PNG encoding, which Windows
 * reads at every size since Vista.
 * @param {{size: number, png: Buffer}[]} images sizes from 1 to 256
 * @returns {Buffer}
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) throw new RangeError(`icon size ${size} is out of range`);
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size % 256, 0); // 0 means 256
    entry.writeUInt8(size % 256, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map(i => i.png)]);
}

module.exports = { encodeIco };
