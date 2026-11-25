/**
 * WhatsApp Audio / Sound Sticker Codec (Baileys v7.0.0-rc14)
 *
 * WhatsApp memperkenalkan Stiker Suara (Sound Stickers) menggunakan struktur Protobuf:
 *   Message {
 *     optional FutureProofMessage audioStickerMessage = 134; // -> { 1: Message { 26: StickerMessage } }
 *     optional MessageContextInfo messageContextInfo = 35;
 *   }
 *   StickerMessage {
 *     ...field standar 1..22 (WebP 512x512, isAnimated: true)...
 *     optional int32 premium = 24;              // 0
 *     optional string emojis = 25;              // opsional
 *     optional AudioMessage audioMessage = 26;  // audio/ogg; codecs=opus (ptt tidak diaktifkan)
 *   }
 *
 * Karena WAProto bawaan Baileys 7.0.0-rc14 belum menyertakan field 134 & field 26 pada StickerMessage,
 * modul ini memasang wrapper idempoten pada `proto.Message.encode` & `proto.Message.decode` tanpa
 * mengubah berkas di `node_modules/`.
 */

const {
  proto,
  prepareWAMessageMedia,
  generateWAMessage,
  generateMessageIDV2
} = require('@whiskeysockets/baileys');

const AUDIO_STICKER_SYMBOL = Symbol.for('another-me.audioStickerPayload');
const RAW_WIRE_FIELDS_SYMBOL = Symbol.for('another-me.rawWireFields');
const PENDING_AUDIO_TTL_MS = 60 * 1000;
const MAX_PENDING_AUDIO_ENTRIES = 100;
const DECODED_AUDIO_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DECODED_AUDIO_ENTRIES = 300;

// Penyimpanan sementara berbasis fileEncSha256 (base64) agar metadata audio tetap ditemukan
// saat Baileys menggandakan pesan ke beberapa perangkat (DeviceSentMessage / grup / retry).
const pendingAudioByEncSha = new Map();

// Indeks metadata AudioMessage hasil decode berdasarkan fileSha256 / fileEncSha256 / directPath
// agar tetap bertahan walau Baileys melakukan toJSON()/fromObject() atau quotedMessage memangkas field 26.
const decodedAudioByStickerKey = new Map();

let isPatchInstalled = false;

function buildStickerLookupKeys(stickerMsg) {
  if (!stickerMsg || typeof stickerMsg !== 'object') return [];
  const keys = [];
  const sha = encodeKeyFromEncSha(stickerMsg.fileSha256);
  if (sha) keys.push(`sha:${sha}`);
  const encSha = encodeKeyFromEncSha(stickerMsg.fileEncSha256);
  if (encSha) keys.push(`enc:${encSha}`);
  if (typeof stickerMsg.directPath === 'string' && stickerMsg.directPath.trim()) {
    keys.push(`path:${stickerMsg.directPath.trim()}`);
  }
  return keys;
}

function rememberDecodedStickerAudio(stickerMsg, audioMessage) {
  if (!stickerMsg || !audioMessage) return;
  const keys = buildStickerLookupKeys(stickerMsg);
  if (keys.length === 0) return;
  const now = Date.now();
  const entry = { audioMessage, expiresAt: now + DECODED_AUDIO_TTL_MS };
  for (const k of keys) {
    decodedAudioByStickerKey.delete(k);
    decodedAudioByStickerKey.set(k, entry);
  }
  while (decodedAudioByStickerKey.size > MAX_DECODED_AUDIO_ENTRIES) {
    const oldest = decodedAudioByStickerKey.keys().next().value;
    if (oldest === undefined) break;
    decodedAudioByStickerKey.delete(oldest);
  }
}

function listRawProtobufFieldNumbers(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return [];
  const fields = [];
  let pos = 0;
  const end = bytes.length;
  while (pos < end) {
    const tagRes = readProtobufVarint(bytes, pos, end);
    if (!tagRes) break;
    const fieldNum = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x7;
    pos = tagRes.nextPos;
    if (fieldNum === 0) break;
    fields.push(fieldNum);
    if (wireType === 0) {
      const valRes = readProtobufVarint(bytes, pos, end);
      if (!valRes) break;
      pos = valRes.nextPos;
    } else if (wireType === 1) {
      pos += 8;
      if (pos > end) break;
    } else if (wireType === 2) {
      const lenRes = readProtobufVarint(bytes, pos, end);
      if (!lenRes) break;
      pos = lenRes.nextPos + lenRes.value;
      if (pos > end) break;
    } else if (wireType === 5) {
      pos += 4;
      if (pos > end) break;
    } else {
      break;
    }
  }
  return fields;
}

function encodeKeyFromEncSha(fileEncSha256) {
  if (!fileEncSha256) return '';
  if (typeof fileEncSha256 === 'string') return fileEncSha256;
  if (fileEncSha256 instanceof Uint8Array || Buffer.isBuffer(fileEncSha256)) {
    return Buffer.from(fileEncSha256).toString('base64');
  }
  return '';
}

function prunePendingAudioMap(now = Date.now()) {
  for (const [k, entry] of pendingAudioByEncSha.entries()) {
    if (!entry || entry.expiresAt <= now) {
      pendingAudioByEncSha.delete(k);
    }
  }
  while (pendingAudioByEncSha.size > MAX_PENDING_AUDIO_ENTRIES) {
    const oldest = pendingAudioByEncSha.keys().next().value;
    if (oldest === undefined) break;
    pendingAudioByEncSha.delete(oldest);
  }
}

function registerAudioForStickerMessage(stickerMsg, audioMessage) {
  if (!stickerMsg || !audioMessage) return;
  try {
    Object.defineProperty(stickerMsg, AUDIO_STICKER_SYMBOL, {
      value: audioMessage,
      enumerable: false,
      configurable: true,
      writable: true
    });
  } catch {}

  const shaKey = encodeKeyFromEncSha(stickerMsg.fileEncSha256);
  if (shaKey) {
    prunePendingAudioMap();
    pendingAudioByEncSha.set(shaKey, {
      audioMessage,
      expiresAt: Date.now() + PENDING_AUDIO_TTL_MS
    });
  }
}

function resolveAttachedAudioMessage(stickerMsg) {
  if (!stickerMsg || typeof stickerMsg !== 'object') return null;
  if (stickerMsg[AUDIO_STICKER_SYMBOL]) {
    return stickerMsg[AUDIO_STICKER_SYMBOL];
  }
  const shaKey = encodeKeyFromEncSha(stickerMsg.fileEncSha256);
  if (shaKey) {
    const entry = pendingAudioByEncSha.get(shaKey);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.audioMessage;
    }
    if (entry) pendingAudioByEncSha.delete(shaKey);
  }
  return null;
}

/**
 * Membaca varint Protobuf secara aman dengan pemeriksaan batas array.
 */
function readProtobufVarint(bytes, pos, end) {
  let value = 0;
  let shift = 0;
  let idx = pos;
  while (idx < end && shift <= 63) {
    const b = bytes[idx++];
    if (shift < 28) {
      value |= (b & 0x7f) << shift;
    } else if (shift < 53) {
      value += (b & 0x7f) * Math.pow(2, shift);
    }
    if ((b & 0x80) === 0) {
      return { value: value >>> 0, nextPos: idx };
    }
    shift += 7;
  }
  return null;
}

/**
 * Memindai raw Protobuf wire bytes dan mengembalikan subarray dari field bertipe
 * length-delimited (wireType 2) yang cocok dengan `targetFieldNum`.
 */
function findLengthDelimitedField(bytes, targetFieldNum) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
  let pos = 0;
  const end = bytes.length;

  while (pos < end) {
    const tagRes = readProtobufVarint(bytes, pos, end);
    if (!tagRes) return null;
    const tag = tagRes.value;
    pos = tagRes.nextPos;

    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNum === 0) return null;

    if (wireType === 0) {
      const valRes = readProtobufVarint(bytes, pos, end);
      if (!valRes) return null;
      pos = valRes.nextPos;
    } else if (wireType === 1) {
      pos += 8;
      if (pos > end) return null;
    } else if (wireType === 2) {
      const lenRes = readProtobufVarint(bytes, pos, end);
      if (!lenRes) return null;
      const len = lenRes.value;
      pos = lenRes.nextPos;
      if (pos + len > end) return null;
      if (fieldNum === targetFieldNum) {
        return bytes.subarray(pos, pos + len);
      }
      pos += len;
    } else if (wireType === 5) {
      pos += 4;
      if (pos > end) return null;
    } else {
      // Wire type grup/tidak dikenal -> hentikan pemindaian dengan aman
      return null;
    }
  }

  return null;
}

function getStickerAudioMessage(stickerMsg) {
  if (!stickerMsg || typeof stickerMsg !== 'object') return null;
  if (stickerMsg[AUDIO_STICKER_SYMBOL]) {
    return stickerMsg[AUDIO_STICKER_SYMBOL];
  }
  const now = Date.now();
  for (const key of buildStickerLookupKeys(stickerMsg)) {
    const entry = decodedAudioByStickerKey.get(key);
    if (!entry) continue;
    if (entry.expiresAt <= now) {
      decodedAudioByStickerKey.delete(key);
      continue;
    }
    return entry.audioMessage;
  }
  return null;
}

function getRawWireFieldNumbers(obj) {
  return obj && Array.isArray(obj[RAW_WIRE_FIELDS_SYMBOL]) ? obj[RAW_WIRE_FIELDS_SYMBOL] : null;
}

/**
 * Mengekstrak AudioMessage yang tertanam langsung di field 26 pada StickerMessage
 * (baik di dalam pembungkus field 134 maupun langsung di top-level field 26).
 */
function extractAudioFromStickerBytes(stickerBytes) {
  const audioBytes = findLengthDelimitedField(stickerBytes, 26);
  if (!audioBytes || audioBytes.length === 0) return null;
  try {
    return proto.Message.AudioMessage.decode(audioBytes);
  } catch {
    return null;
  }
}

/**
 * Mengekstrak StickerMessage + AudioMessage dari raw bytes `proto.Message` yang
 * membawa field 134 (`audioStickerMessage`).
 */
function extractAudioStickerFromRawMessageBytes(rawBytes) {
  const fp134 = findLengthDelimitedField(rawBytes, 134);
  if (!fp134 || fp134.length === 0) return null;

  const innerMsgBytes = findLengthDelimitedField(fp134, 1);
  if (!innerMsgBytes || innerMsgBytes.length === 0) return null;

  const stickerBytes = findLengthDelimitedField(innerMsgBytes, 26);
  if (!stickerBytes || stickerBytes.length === 0) return null;

  const stickerMessage = proto.Message.StickerMessage.decode(stickerBytes);
  try {
    Object.defineProperty(stickerMessage, RAW_WIRE_FIELDS_SYMBOL, {
      value: listRawProtobufFieldNumbers(stickerBytes),
      enumerable: false,
      configurable: true
    });
  } catch {}

  const audioMessage = extractAudioFromStickerBytes(stickerBytes);
  if (audioMessage) {
    try {
      Object.defineProperty(stickerMessage, AUDIO_STICKER_SYMBOL, {
        value: audioMessage,
        enumerable: false,
        configurable: true,
        writable: true
      });
    } catch {}
    rememberDecodedStickerAudio(stickerMessage, audioMessage);
  }

  return { stickerMessage, audioMessage };
}

/**
 * Mengekstrak AudioMessage bila StickerMessage berada langsung di top-level field 26
 * tanpa pembungkus field 134.
 */
function extractDirectStickerAudioFromRawMessageBytes(rawBytes) {
  const stickerBytes = findLengthDelimitedField(rawBytes, 26);
  if (!stickerBytes || stickerBytes.length === 0) return null;
  return extractAudioFromStickerBytes(stickerBytes);
}

/**
 * Memasang patch idempoten pada `proto.Message.encode` (untuk mengirim Stiker Suara)
 * dan `proto.Message.decode` (agar Stiker Suara masuk tidak terbuang sebagai pesan kosong).
 */
function installAudioStickerProtoPatch() {
  if (isPatchInstalled) return true;
  if (!proto?.Message?.encode || !proto?.Message?.decode) return false;

  const originalEncode = proto.Message.encode._anotherMeOrig || proto.Message.encode;
  const wrappedEncode = function encodeWithAudioSticker(m, w) {
    const attachedAudio = resolveAttachedAudioMessage(m?.stickerMessage);
    if (!attachedAudio) {
      return originalEncode.call(this, m, w);
    }

    // Salin field luar (termasuk messageContextInfo = field 35) tanpa stickerMessage top-level (field 26)
    const outer = {};
    for (const key of Object.keys(m)) {
      if (key !== 'stickerMessage') {
        outer[key] = m[key];
      }
    }

    const writer = originalEncode.call(this, outer, w);

    // Bungkus menjadi field 134 (audioStickerMessage: FutureProofMessage) -> 1 (message) -> 26 (stickerMessage)
    // Tag = (fieldNumber << 3) | wireType
    // 134 << 3 | 2 = 1074, 1 << 3 | 2 = 10, 26 << 3 | 2 = 210, 24 << 3 | 0 = 192
    writer.uint32(1074).fork();
    writer.uint32(10).fork();
    writer.uint32(210).fork();
    proto.Message.StickerMessage.encode(m.stickerMessage, writer);
    writer.uint32(192).int32(0); // StickerMessage.premium = 0
    proto.Message.AudioMessage.encode(attachedAudio, writer.uint32(210).fork()).ldelim();
    writer.ldelim();
    writer.ldelim();
    writer.ldelim();

    return writer;
  };
  wrappedEncode._anotherMeOrig = originalEncode;
  proto.Message.encode = wrappedEncode;

  const originalDecode = proto.Message.decode._anotherMeOrig || proto.Message.decode;
  const wrappedDecode = function decodeWithAudioSticker(r, l) {
    let rawSlice = null;
    try {
      if (r instanceof Uint8Array) {
        rawSlice = l === undefined ? r : r.subarray(0, Math.min(r.length, l));
      } else if (r && r.buf instanceof Uint8Array && typeof r.pos === 'number') {
        const startPos = r.pos;
        const endPos = l === undefined ? r.len : Math.min(r.len, startPos + l);
        rawSlice = r.buf.subarray(startPos, endPos);
      }
    } catch {}

    const decoded = originalDecode.call(this, r, l);

    if (decoded && rawSlice && rawSlice.length > 0) {
      try {
        Object.defineProperty(decoded, RAW_WIRE_FIELDS_SYMBOL, {
          value: listRawProtobufFieldNumbers(rawSlice),
          enumerable: false,
          configurable: true
        });
      } catch {}

      if (!decoded.stickerMessage) {
        try {
          const extracted = extractAudioStickerFromRawMessageBytes(rawSlice);
          if (extracted && extracted.stickerMessage) {
            decoded.stickerMessage = extracted.stickerMessage;
          }
        } catch {}
      } else {
        try {
          const rawStk = findLengthDelimitedField(rawSlice, 26);
          if (rawStk) {
            Object.defineProperty(decoded.stickerMessage, RAW_WIRE_FIELDS_SYMBOL, {
              value: listRawProtobufFieldNumbers(rawStk),
              enumerable: false,
              configurable: true
            });
          }
        } catch {}

        if (!decoded.stickerMessage[AUDIO_STICKER_SYMBOL]) {
          try {
            const directAudio = extractDirectStickerAudioFromRawMessageBytes(rawSlice);
            if (directAudio) {
              Object.defineProperty(decoded.stickerMessage, AUDIO_STICKER_SYMBOL, {
                value: directAudio,
                enumerable: false,
                configurable: true,
                writable: true
              });
              rememberDecodedStickerAudio(decoded.stickerMessage, directAudio);
            }
          } catch {}
        }
      }
    }

    return decoded;
  };
  wrappedDecode._anotherMeOrig = originalDecode;
  proto.Message.decode = wrappedDecode;

  isPatchInstalled = true;
  return true;
}

/**
 * Mendeteksi secara cepat apakah berkas WebP memiliki chunk `ANIM` (stiker bergerak).
 */
function isAnimatedWebpBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.includes(Buffer.from('ANIM'));
}

/**
 * Mengunggah audio OGG/Opus dan stiker WebP (diam maupun bergerak) lalu mengirimkannya
 * sebagai WhatsApp Sound Sticker (field 134 -> 1 -> 26 + AudioMessage pada field 26).
 */
async function sendAudioSticker({
  waSocket,
  jid,
  stickerBuffer,
  audioBuffer,
  audioSeconds = 5,
  isAnimated,
  quoted,
  ephemeralExpiration,
  logger
}) {
  if (!waSocket || typeof waSocket.relayMessage !== 'function' || typeof waSocket.waUploadToServer !== 'function') {
    throw new Error('Soket Baileys belum mendukung relayMessage/waUploadToServer untuk stiker suara.');
  }

  installAudioStickerProtoPatch();

  const safeSeconds = Math.max(1, Math.round(Number(audioSeconds) || 1));
  const resolvedAnimated =
    typeof isAnimated === 'boolean' ? isAnimated : isAnimatedWebpBuffer(stickerBuffer);

  // 1. Unggah trek audio OGG/Opus (mimetype WAJIB persis 'audio/ogg; codecs=opus', ptt tidak aktif)
  const uploadedAudio = await prepareWAMessageMedia(
    {
      audio: audioBuffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: false,
      seconds: safeSeconds
    },
    {
      upload: waSocket.waUploadToServer,
      logger
    }
  );

  const audioMessage = uploadedAudio?.audioMessage;
  if (!audioMessage) {
    throw new Error('Gagal mengunggah audio untuk stiker suara.');
  }
  // Hapus field ptt bila false agar struktur wire identik dengan stiker suara resmi WhatsApp
  if (audioMessage.ptt === false) {
    delete audioMessage.ptt;
  }

  // 2. Bangun pesan stiker standar via generateWAMessage agar metadata enkripsi & mediatype="sticker" valid
  const userJid = waSocket.user?.id || '';
  const fullMsg = await generateWAMessage(
    jid,
    {
      sticker: stickerBuffer,
      width: 512,
      height: 512,
      isAnimated: resolvedAnimated
    },
    {
      logger,
      userJid,
      upload: waSocket.waUploadToServer,
      messageId: generateMessageIDV2(userJid),
      ...(quoted ? { quoted } : {}),
      ...(ephemeralExpiration ? { ephemeralExpiration } : {})
    }
  );

  const targetStickerMsg =
    fullMsg?.message?.ephemeralMessage?.message?.stickerMessage ||
    fullMsg?.message?.stickerMessage;

  if (!targetStickerMsg) {
    throw new Error('Gagal membentuk pesan stiker dasar untuk stiker suara.');
  }

  if (!targetStickerMsg.width) targetStickerMsg.width = 512;
  if (!targetStickerMsg.height) targetStickerMsg.height = 512;
  if (!targetStickerMsg.stickerSentTs) targetStickerMsg.stickerSentTs = Date.now();

  // 3. Kaitkan AudioMessage pada StickerMessage sebelum relayMessage melakukan enkripsi Protobuf
  registerAudioForStickerMessage(targetStickerMsg, audioMessage);

  await waSocket.relayMessage(jid, fullMsg.message, {
    messageId: fullMsg.key.id,
    additionalAttributes: {},
    additionalNodes: []
  });

  return fullMsg;
}

module.exports = {
  AUDIO_STICKER_SYMBOL,
  RAW_WIRE_FIELDS_SYMBOL,
  findLengthDelimitedField,
  listRawProtobufFieldNumbers,
  getRawWireFieldNumbers,
  getStickerAudioMessage,
  isAnimatedWebpBuffer,
  extractAudioStickerFromRawMessageBytes,
  extractDirectStickerAudioFromRawMessageBytes,
  registerAudioForStickerMessage,
  resolveAttachedAudioMessage,
  installAudioStickerProtoPatch,
  sendAudioSticker
};
