/**
 * Utilitas murni JavaScript untuk menyisipkan dan membaca metadata
 * Exchangeable Image File Format (EXIF) paket stiker WhatsApp pada berkas
 * Resource Interchange File Format (RIFF) Web Picture (WebP) tanpa dependensi luar.
 */

const EXIF_HEADER_TEMPLATE = Buffer.from([
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x41, 0x57, 0x07, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x16, 0x00, 0x00, 0x00
]);

/**
 * Membangun payload EXIF sesuai spesifikasi stiker WhatsApp.
 */
function buildWhatsAppExifPayload({
  packId = 'com.anotherme.whatsapp.stickers',
  packName = 'Another Me',
  author = 'Fariez',
  emojis = ['✨']
} = {}) {
  const metadata = {
    'sticker-pack-id': String(packId || 'com.anotherme.whatsapp.stickers'),
    'sticker-pack-name': String(packName || 'Another Me').slice(0, 64),
    'sticker-pack-publisher': String(author || 'Fariez').slice(0, 64),
    emojis: Array.isArray(emojis) && emojis.length > 0 ? emojis : ['✨']
  };
  const jsonBuf = Buffer.from(JSON.stringify(metadata), 'utf-8');
  const header = Buffer.from(EXIF_HEADER_TEMPLATE);
  header.writeUInt32LE(jsonBuf.length, 14);
  return Buffer.concat([header, jsonBuf]);
}

/**
 * Memecah kontainer RIFF WEBP menjadi daftar chunk { tag, payload }.
 */
function parseWebpChunks(webpBuffer) {
  if (!Buffer.isBuffer(webpBuffer) || webpBuffer.length < 12) {
    throw new Error('Buffer WebP terlalu pendek atau tidak valid.');
  }
  if (
    webpBuffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    webpBuffer.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    throw new Error('Header berkas bukan RIFF WEBP yang valid.');
  }

  const chunks = [];
  let offset = 12;
  while (offset + 8 <= webpBuffer.length) {
    const tag = webpBuffer.subarray(offset, offset + 4).toString('ascii');
    const size = webpBuffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = Math.min(dataStart + size, webpBuffer.length);
    const payload = webpBuffer.subarray(dataStart, dataEnd);
    chunks.push({ tag, payload });
    // Chunk dengan panjang ganjil memiliki 1 byte padding nol di akhir
    offset = dataStart + size + (size % 2);
  }

  return chunks;
}

/**
 * Membaca dimensi dan flag alpha dari bitstream VP8 atau VP8L untuk konstruksi header VP8X.
 */
function inferDimensionsFromChunks(chunks, fallbackWidth = 512, fallbackHeight = 512, fallbackAlpha = false) {
  let width = fallbackWidth;
  let height = fallbackHeight;
  let hasAlpha = Boolean(fallbackAlpha) || chunks.some((c) => c.tag === 'ALPH');

  const vp8l = chunks.find((c) => c.tag === 'VP8L');
  if (vp8l && vp8l.payload.length >= 5 && vp8l.payload[0] === 0x2f) {
    const bits = vp8l.payload.readUInt32LE(1);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
    if ((bits >> 28) & 1) hasAlpha = true;
    return { width, height, hasAlpha };
  }

  const vp8 = chunks.find((c) => c.tag === 'VP8 ');
  if (
    vp8 &&
    vp8.payload.length >= 10 &&
    vp8.payload[3] === 0x9d &&
    vp8.payload[4] === 0x01 &&
    vp8.payload[5] === 0x2a
  ) {
    width = vp8.payload.readUInt16LE(6) & 0x3fff;
    height = vp8.payload.readUInt16LE(8) & 0x3fff;
    return { width, height, hasAlpha };
  }

  return { width, height, hasAlpha };
}

function encodeChunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write(tag, 0, 4, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  if (payload.length % 2 === 1) {
    return Buffer.concat([header, payload, Buffer.from([0x00])]);
  }
  return Buffer.concat([header, payload]);
}

function buildVp8xPayload(width, height, flags) {
  const w = Math.max(1, Math.min(0xffffff, Math.round(width))) - 1;
  const h = Math.max(1, Math.min(0xffffff, Math.round(height))) - 1;
  const buf = Buffer.alloc(10, 0);
  buf[0] = flags;
  buf[4] = w & 0xff;
  buf[5] = (w >> 8) & 0xff;
  buf[6] = (w >> 16) & 0xff;
  buf[7] = h & 0xff;
  buf[8] = (h >> 8) & 0xff;
  buf[9] = (h >> 16) & 0xff;
  return buf;
}

/**
 * Menyisipkan (atau mengganti) metadata EXIF paket stiker WhatsApp ke dalam buffer WebP.
 * Mendukung WebP VP8, VP8L, maupun VP8X (termasuk stiker ber-alpha atau animasi).
 */
function injectWebpExif(webpBuffer, options = {}) {
  const chunks = parseWebpChunks(webpBuffer).filter((c) => c.tag !== 'EXIF');
  const exifPayload = buildWhatsAppExifPayload(options);

  const hasVp8x = chunks.length > 0 && chunks[0].tag === 'VP8X';
  const outChunks = [];

  if (hasVp8x) {
    const vp8xPayload = Buffer.from(chunks[0].payload);
    if (vp8xPayload.length >= 10) {
      // Bit 0x08 menandakan keberadaan chunk EXIF
      vp8xPayload[0] |= 0x08;
    }
    outChunks.push({ tag: 'VP8X', payload: vp8xPayload });
    for (let i = 1; i < chunks.length; i++) {
      outChunks.push(chunks[i]);
    }
  } else {
    const { width, height, hasAlpha } = inferDimensionsFromChunks(
      chunks,
      options.width || 512,
      options.height || 512,
      options.hasAlpha
    );
    const flags = 0x08 | (hasAlpha ? 0x10 : 0x00);
    outChunks.push({ tag: 'VP8X', payload: buildVp8xPayload(width, height, flags) });
    for (const chunk of chunks) {
      outChunks.push(chunk);
    }
  }

  outChunks.push({ tag: 'EXIF', payload: exifPayload });

  const encodedBody = Buffer.concat(outChunks.map((c) => encodeChunk(c.tag, c.payload)));
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 4, 'ascii');
  riffHeader.writeUInt32LE(encodedBody.length + 4, 4);
  riffHeader.write('WEBP', 8, 4, 'ascii');

  return Buffer.concat([riffHeader, encodedBody]);
}

/**
 * Membaca objek JSON metadata stiker WhatsApp dari chunk EXIF WebP (jika ada).
 */
function readWebpExifMetadata(webpBuffer) {
  try {
    const chunks = parseWebpChunks(webpBuffer);
    const exif = chunks.find((c) => c.tag === 'EXIF');
    if (!exif || exif.payload.length <= EXIF_HEADER_TEMPLATE.length) return null;
    const jsonStart = exif.payload.indexOf(0x7b); // '{'
    if (jsonStart < 0) return null;
    const jsonStr = exif.payload.subarray(jsonStart).toString('utf-8').replace(/\0+$/, '');
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

module.exports = {
  buildWhatsAppExifPayload,
  injectWebpExif,
  readWebpExifMetadata,
  parseWebpChunks
};
