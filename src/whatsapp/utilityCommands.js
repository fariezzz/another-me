/**
 * Utility Commands Router
 * Menangani seluruh perintah utilitas bot WhatsApp untuk pemilik (fromMe: true)
 * maupun lawan bicara di chat pribadi & grup (dilindungi CommandAntiSpamGuard).
 * Seluruh perintah mendukung awalan '!' maupun '.' beserta alias cadangan:
 * - Bantuan & sistem: !menu, !ping
 * - Media & stiker:   !sticker, !toimg, !wm, !crop
 * - Meme kustom:      !text, !stext, !cap
 * - Utilitas harian:  !cuaca, !jam, !pilih
 *
 * Perintah bawaan !acep dan !ask tetap ditangani terpisah oleh commandRouter.js.
 */

const { normalizeMessageContent } = require('@whiskeysockets/baileys');
const { getStickerAudioMessage, getRawWireFieldNumbers } = require('./audioStickerCodec');
const {
  MAX_MEDIA_BYTES,
  MAX_VIDEO_INPUT_SECONDS,
  MAX_CAP_VIDEO_SECONDS,
  MAX_CROP_VIDEO_SECONDS,
  DEFAULT_PACK_NAME,
  DEFAULT_PACK_AUTHOR,
  MediaValidationError,
  validateImageBuffer,
  convertImageToSticker,
  convertVideoOrGifToSticker,
  convertStickerToMedia,
  rewriteStickerExif,
  renderTextBlurImage,
  renderCapMeme,
  renderCapSticker,
  renderCapVideoOrGif,
  cropImageToSquare,
  cropVideoOrGifToSquare
} = require('../media/imageProcessor');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SUPPORTED_PREFIXES = ['!', '.'];

/**
 * Daftar alias cadangan tiap perintah (tanpa awalan).
 * Setiap entri otomatis dapat dipanggil dengan awalan '!' maupun '.',
 * misalnya !sticker, !stiker, !s, .sticker, .stiker, .s.
 */
const COMMAND_ALIAS_GROUPS = {
  menu: ['menu', 'help', 'bantuan', 'cmd', 'commands', 'list'],
  ping: ['ping', 'cek', 'status', 'uptime'],
  sticker: ['sticker', 'stiker', 's', 'stk'],
  toimg: ['toimg', 'toimage', 'togif', 'tovid', 'tovideo', 'img', 'gambar', 'foto'],
  wm: ['wm', 'steal', 'watermark', 'take'],
  crop: ['crop', 'potong', 'square', 'kotak'],
  text: ['text', 'teks', 'txt'],
  stext: ['stext', 'steks', 'stxt', 'brat', 'sbrat', 'st'],
  cap: ['cap', 'caption', 'burem', 'blurcap'],
  caphd: ['caphd', 'capclean', 'capclear', 'hdcap', 'meme', 'memecap'],
  cuaca: ['cuaca', 'weather', 'suhu'],
  jam: ['jam', 'waktu', 'time', 'tanggal', 'tgl'],
  pilih: ['pilih', 'pick', 'choose', 'acak', 'random']
};

const COMMAND_ALIASES = new Map();
for (const [canonical, aliases] of Object.entries(COMMAND_ALIAS_GROUPS)) {
  for (const alias of aliases) {
    COMMAND_ALIASES.set(alias, canonical);
  }
}

const MEDIA_COMMANDS = new Set(['sticker', 'toimg', 'wm', 'crop', 'text', 'stext', 'cap', 'caphd']);

/**
 * Membuka seluruh lapisan pembungkus pesan WhatsApp Baileys v7 secara rekursif,
 * termasuk deviceSentMessage (pesan yang dikirim dari ponsel pemilik sendiri),
 * ephemeralMessage, viewOnceMessage, documentWithCaptionMessage, dan editedMessage.
 */
function unwrapWhatsAppMessage(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'object') return {};
  let current = rawMessage;
  for (let i = 0; i < 8; i++) {
    if (!current || typeof current !== 'object') break;
    const normalized = normalizeMessageContent(current);
    if (normalized && normalized !== current) {
      current = normalized;
      continue;
    }
    if (current.deviceSentMessage?.message) {
      current = current.deviceSentMessage.message;
      continue;
    }
    if (current.lottieStickerMessage?.message) {
      current = current.lottieStickerMessage.message;
      continue;
    }
    if (current.editedMessage?.message?.protocolMessage?.editedMessage) {
      current = current.editedMessage.message.protocolMessage.editedMessage;
      continue;
    }
    if (current.protocolMessage?.editedMessage) {
      current = current.protocolMessage.editedMessage;
      continue;
    }
    break;
  }
  return current || {};
}

/**
 * Membersihkan karakter tak terlihat (zero-width / bidi) di awal teks perintah.
 */
function cleanCommandText(rawText) {
  return String(rawText || '')
    .replace(/^[\u200B-\u200F\u202A-\u202E\uFEFF]+/, '')
    .trim();
}

/**
 * Mengurai teks pesan apakah cocok persis dengan salah satu perintah utilitas yang dikenali
 * dengan awalan '!' maupun '.'.
 * Mengembalikan null bila bukan perintah utilitas (termasuk !acep, !ask, '...', '.pdf', atau '!?').
 */
function parseUtilityCommand(messageText) {
  const trimmed = cleanCommandText(messageText);
  if (!trimmed || !SUPPORTED_PREFIXES.includes(trimmed[0])) return null;

  const match = trimmed.match(/^([!.])([a-z0-9]+)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const prefix = match[1];
  const aliasName = match[2].toLowerCase();
  const command = COMMAND_ALIASES.get(aliasName);
  if (!command) return null;

  return {
    command,
    prefix,
    trigger: `${prefix}${aliasName}`,
    args: (match[3] || '').trim(),
    isMediaCommand: MEDIA_COMMANDS.has(command)
  };
}

/**
 * Mengurai argumen !cap <teks atas> | <teks bawah>.
 * Jika hanya satu teks tanpa tanda '|', diletakkan di bawah saja.
 */
function parseCapArgs(rawArgs) {
  const trimmed = String(rawArgs || '').trim();
  if (!trimmed) return { topText: '', bottomText: '' };

  const pipeIdx = trimmed.indexOf('|');
  if (pipeIdx === -1) {
    return { topText: '', bottomText: trimmed };
  }

  return {
    topText: trimmed.slice(0, pipeIdx).trim(),
    bottomText: trimmed.slice(pipeIdx + 1).trim()
  };
}

/**
 * Mengurai argumen !wm <Nama Paket> | <Pembuat>.
 */
function parseWatermarkArgs(rawArgs) {
  const trimmed = String(rawArgs || '').trim();
  if (!trimmed) {
    return { packName: DEFAULT_PACK_NAME, author: DEFAULT_PACK_AUTHOR };
  }
  const pipeIdx = trimmed.indexOf('|');
  if (pipeIdx === -1) {
    return { packName: trimmed.slice(0, 64), author: DEFAULT_PACK_AUTHOR };
  }
  const packName = trimmed.slice(0, pipeIdx).trim() || DEFAULT_PACK_NAME;
  const author = trimmed.slice(pipeIdx + 1).trim() || DEFAULT_PACK_AUTHOR;
  return { packName: packName.slice(0, 64), author: author.slice(0, 64) };
}

/**
 * Mengubah nilai fileLength Baileys (bisa number, bigint, atau Protobuf Long) menjadi number.
 */
function parseFileLength(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (raw && typeof raw.toNumber === 'function') return raw.toNumber();
  if (raw && typeof raw === 'object' && typeof raw.low === 'number') {
    return (raw.high || 0) * 0x100000000 + (raw.low >>> 0);
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Mendeteksi apakah pesan media mentah ditandai sebagai foto/video sekali lihat (View Once).
 * Bot menghormati kontrol privasi View Once dan tidak mengekstraknya menjadi stiker permanen.
 */
function isViewOnceRawMessage(rawContent) {
  if (!rawContent || typeof rawContent !== 'object') return false;
  if (
    rawContent.viewOnceMessage ||
    rawContent.viewOnceMessageV2 ||
    rawContent.viewOnceMessageV2Extension
  ) {
    return true;
  }
  const inner =
    rawContent.ephemeralMessage?.message ||
    rawContent.deviceSentMessage?.message ||
    rawContent;
  if (
    inner?.viewOnceMessage ||
    inner?.viewOnceMessageV2 ||
    inner?.viewOnceMessageV2Extension
  ) {
    return true;
  }
  return Boolean(inner?.imageMessage?.viewOnce || inner?.videoMessage?.viewOnce);
}

/**
 * Memeriksa jenis media di dalam objek isi pesan WhatsApp yang sudah dinormalisasi.
 */
function inspectMediaInContent(content) {
  if (!content || typeof content !== 'object') return null;

  if (content.imageMessage) {
    if (content.imageMessage.viewOnce) {
      return { kind: 'view_once', mimeType: content.imageMessage.mimetype || 'image/jpeg', fileLength: 0 };
    }
    return {
      kind: 'image',
      mimeType: content.imageMessage.mimetype || 'image/jpeg',
      fileLength: parseFileLength(content.imageMessage.fileLength),
      caption: String(content.imageMessage.caption || '').trim()
    };
  }
  if (content.stickerMessage) {
    const rawStkFields = getRawWireFieldNumbers(content.stickerMessage);
    return {
      kind: 'sticker',
      mimeType: content.stickerMessage.mimetype || 'image/webp',
      fileLength: parseFileLength(content.stickerMessage.fileLength),
      isAnimated: Boolean(content.stickerMessage.isAnimated),
      fileSha256: content.stickerMessage.fileSha256 || null,
      fileEncSha256: content.stickerMessage.fileEncSha256 || null,
      directPath: String(content.stickerMessage.directPath || ''),
      hasSoundMarkerField24: Boolean(Array.isArray(rawStkFields) && rawStkFields.includes(24)),
      audioMessage: getStickerAudioMessage(content.stickerMessage)
    };
  }
  if (content.videoMessage) {
    if (content.videoMessage.viewOnce) {
      return { kind: 'view_once', mimeType: content.videoMessage.mimetype || 'video/mp4', fileLength: 0 };
    }
    return {
      kind: 'video',
      mimeType: content.videoMessage.mimetype || 'video/mp4',
      fileLength: parseFileLength(content.videoMessage.fileLength),
      seconds: parseFileLength(content.videoMessage.seconds),
      gifPlayback: Boolean(content.videoMessage.gifPlayback),
      caption: String(content.videoMessage.caption || '').trim()
    };
  }
  if (content.audioMessage) {
    return {
      kind: 'audio',
      mimeType: content.audioMessage.mimetype || 'audio/ogg',
      fileLength: parseFileLength(content.audioMessage.fileLength),
      seconds: parseFileLength(content.audioMessage.seconds),
      ptt: Boolean(content.audioMessage.ptt)
    };
  }
  if (content.documentMessage) {
    const mime = String(content.documentMessage.mimetype || '').toLowerCase();
    const fileName = String(content.documentMessage.fileName || content.documentMessage.title || '').trim();
    const caption = String(content.documentMessage.caption || '').trim();
    if (/^image\/(jpeg|jpg|png|webp|gif|avif|heif|tiff)$/.test(mime)) {
      return {
        kind: 'image',
        mimeType: mime,
        fileLength: parseFileLength(content.documentMessage.fileLength),
        fileName,
        caption
      };
    }
    if (/^video\/(mp4|webm|quicktime|x-msvideo)$/.test(mime)) {
      return {
        kind: 'video',
        mimeType: mime,
        fileLength: parseFileLength(content.documentMessage.fileLength),
        seconds: 0,
        gifPlayback: false,
        fileName,
        caption
      };
    }
    return {
      kind: 'document',
      mimeType: mime || 'application/octet-stream',
      fileLength: parseFileLength(content.documentMessage.fileLength),
      fileName,
      caption
    };
  }
  return null;
}

/**
 * Mengekstrak sumber media dari pesan langsung (caption) atau pesan yang dibalas (quotedMessage).
 * Mengembalikan { kind, source, mimeType, fileLength, targetMsg } atau null jika tidak ada media.
 */
function extractMediaCandidate(msg, normalizedMessage, { isOwnUserJid, isOwnMessageId } = {}) {
  if (isViewOnceRawMessage(msg?.message)) {
    return { kind: 'view_once', source: 'direct', mimeType: '', fileLength: 0, targetMsg: null };
  }

  const directContent = normalizedMessage || unwrapWhatsAppMessage(msg?.message);
  if (!directContent) return null;

  // 1. Cek media langsung pada pesan (misal kirim foto/video/GIF dengan caption !s atau !cap)
  const directMedia = inspectMediaInContent(directContent);
  if (directMedia) {
    return {
      ...directMedia,
      source: 'direct',
      targetMsg: {
        key: msg.key,
        message: directContent
      }
    };
  }

  // 2. Cek media pada pesan yang dibalas (reply / quotedMessage)
  const ctxInfo =
    directContent.extendedTextMessage?.contextInfo ||
    directContent.imageMessage?.contextInfo ||
    directContent.videoMessage?.contextInfo ||
    directContent.documentMessage?.contextInfo ||
    null;

  if (ctxInfo && ctxInfo.quotedMessage) {
    if (isViewOnceRawMessage(ctxInfo.quotedMessage)) {
      return { kind: 'view_once', source: 'quoted', mimeType: '', fileLength: 0, targetMsg: null };
    }

    const quotedNormalized = unwrapWhatsAppMessage(ctxInfo.quotedMessage);
    const quotedMedia = inspectMediaInContent(quotedNormalized);
    if (quotedMedia) {
      const quotedFromMe = Boolean(
        (ctxInfo.participant && typeof isOwnUserJid === 'function' && isOwnUserJid(ctxInfo.participant)) ||
          (ctxInfo.stanzaId && typeof isOwnMessageId === 'function' && isOwnMessageId(ctxInfo.stanzaId))
      );
      return {
        ...quotedMedia,
        source: 'quoted',
        targetMsg: {
          key: {
            remoteJid: msg.key?.remoteJid,
            fromMe: quotedFromMe,
            id: ctxInfo.stanzaId || msg.key?.id,
            participant: ctxInfo.participant || undefined
          },
          message: quotedNormalized
        }
      };
    }
  }

  return null;
}

function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const parts = [];
  if (days > 0) parts.push(`${days} hari`);
  if (hours > 0) parts.push(`${hours} jam`);
  if (mins > 0) parts.push(`${mins} menit`);
  parts.push(`${secs} detik`);
  return parts.join(' ');
}

function buildMenuText({ showOwnerCommands = false, isOwner = false } = {}) {
  const header = isOwner ? '*Daftar Perintah Another Me*' : '*Daftar Perintah Utilitas*';
  const sections = [
    header,
    '_Semua perintah di bawah ini bisa memakai awalan `!` maupun `.` (contoh: `!s` atau `.s`)._',
    '',
    '*Media & Stiker:*',
    '- `!sticker` (`stiker`, `s`, `stk`) — ubah foto, GIF, atau video pendek (<= 15 detik) jadi stiker statis/bergerak; video bersuara otomatis mempertahankan audio aslinya (tambah `crop` untuk potong 1:1, `mute` untuk hilangkan suara)',
    '- `!toimg` (`toimage`, `togif`, `tovid`, `tovideo`, `img`, `gambar`, `foto`) — ubah stiker (balas stiker) jadi gambar, GIF (stiker bergerak), atau video bersuara (stiker suara)',
    '- `!wm <paket> | <pembuat>` (`steal`, `watermark`, `take`) — ganti nama paket & pembuat pada stiker yang dibalas',
    '- `!crop` (`potong`, `square`, `kotak`) — potong foto, video, atau GIF menjadi kotak 1:1 tepat di tengah',
    '',
    '*Meme & Teks:*',
    '- `!text <teks>` (`teks`, `txt`) — gambar latar putih teks hitam blur tipis',
    '- `!stext <teks>` (`steks`, `stxt`, `brat`, `sbrat`, `st`) — sama seperti `!text`, langsung jadi stiker',
    '- `!cap <atas> | <bawah>` (`caption`, `burem`, `blurcap`) — beri teks Impact kapital + emoji berwarna bergaya meme burik pada foto, video (<= 45 detik), GIF, atau stiker diam/bergerak (1 teks otomatis di bawah)',
    '- `!caphd <atas> | <bawah>` (`capclean`, `capclear`, `hdcap`, `meme`, `memecap`) — sama seperti `!cap`, tetapi jernih tanpa proses pemburikan pada foto, video (<= 45 detik), GIF, atau stiker diam/bergerak',
    '',
    '*Utilitas Harian:*',
    '- `!cuaca [kota]` (`weather`, `suhu`) — cek cuaca terkini (bawaan: Tasikmalaya)',
    '- `!jam [zona]` (`waktu`, `time`, `tanggal`, `tgl`) — cek hari, tanggal, dan jam',
    '- `!pilih <a | b | c>` (`pick`, `choose`, `acak`, `random`) — pilih satu opsi secara acak',
    '- `!ping` (`cek`, `status`, `uptime`) — cek waktu respons',
    '- `!menu` (`help`, `bantuan`, `cmd`, `list`) — tampilkan daftar perintah ini'
  ];

  if (showOwnerCommands) {
    sections.push(
      '',
      '*Kontrol Khusus (awalan `!` saja):*',
      '- `!acep [on|off|status]` — aktifkan atau matikan balasan otomatis kontak terdaftar'
    );
    if (isOwner) {
      sections.push(
        '- `!ask [pertanyaan]` (`!tanya`) — khusus pemilik; teruskan pertanyaan teks maupun media (foto, stiker, video, GIF, dokumen, audio — kirim langsung atau balas media) ke Kiraya di semua ruang obrolan'
      );
    }
  }

  sections.push('', '_Catatan: ukuran gambar maksimal 5 Megabyte._');
  return sections.join('\n');
}

/**
 * Mengunduh media memakai downloadMediaBuffer (yang membungkus downloadMediaMessage bawaan)
 * dengan pemeriksaan ukuran 5 Megabyte sebelum dan sesudah unduh.
 */
async function downloadValidatedMediaBuffer(candidate, downloadMediaBuffer) {
  const maxMb = Math.round((MAX_MEDIA_BYTES / (1024 * 1024)) * 10) / 10;

  // Lapis 1: Tolak sebelum mengunduh jika metadata fileLength sudah melebihi 5 Megabyte
  if (candidate.fileLength > MAX_MEDIA_BYTES) {
    throw new MediaValidationError(
      'TOO_LARGE',
      `Maaf, ukuran gambarnya terlalu besar (maksimal ${maxMb} Megabyte). Coba kirim gambar yang lebih kecil ya.`
    );
  }

  let buffer;
  try {
    buffer = await downloadMediaBuffer(candidate.targetMsg);
  } catch (err) {
    const dlErr = new Error(`Gagal mengunduh media WhatsApp: ${err.message}`);
    dlErr.userMessage =
      'Maaf, media gagal diunduh dari WhatsApp (kemungkinan terlalu lama atau sudah kedaluwarsa). Coba kirim ulang fotonya ya.';
    throw dlErr;
  }

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new MediaValidationError(
      'EMPTY_BUFFER',
      'Maaf, berkas media kosong atau gagal diunduh. Coba kirim ulang ya.'
    );
  }

  // Lapis 2: Validasi ulang ukuran aktual buffer setelah terunduh
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new MediaValidationError(
      'TOO_LARGE',
      `Maaf, ukuran gambarnya melebihi batas maksimal ${maxMb} Megabyte. Coba kirim gambar yang lebih kecil ya.`
    );
  }

  return buffer;
}

/**
 * Mencoba mengambil trek audio OGG/Opus dari Stiker Suara yang dibalas agar
 * perintah `!cap`, `!caphd`, dan `!wm` tidak menghilangkan suara asli stiker.
 */
async function resolvePreservedStickerAudio(candidate, { resolveStickerAudio, downloadMediaBuffer } = {}) {
  if (!candidate || candidate.kind !== 'sticker') return null;

  if (typeof resolveStickerAudio === 'function') {
    try {
      const resolved = await resolveStickerAudio(candidate);
      if (resolved && Buffer.isBuffer(resolved.audioBuffer) && resolved.audioBuffer.length > 0) {
        return {
          audioBuffer: resolved.audioBuffer,
          audioSeconds: Math.max(1, Math.round(Number(resolved.audioSeconds) || 5))
        };
      }
    } catch {}
  }

  if (candidate.audioMessage && typeof downloadMediaBuffer === 'function' && candidate.targetMsg?.key) {
    try {
      const audioBuffer = await downloadMediaBuffer({
        key: candidate.targetMsg.key,
        message: { audioMessage: candidate.audioMessage }
      });
      if (Buffer.isBuffer(audioBuffer) && audioBuffer.length > 0) {
        return {
          audioBuffer,
          audioSeconds: Math.max(1, Math.round(Number(candidate.audioMessage.seconds) || 5))
        };
      }
    } catch {}
  }

  return null;
}

/**
 * Menjalankan router perintah utilitas WhatsApp.
 * Mengembalikan true jika pesan cocok dengan salah satu perintah utilitas
 * (baik dieksekusi maupun ditahan anti-spam) agar tidak jatuh ke balasan Artificial Intelligence (AI).
 */
async function handleUtilityCommands({
  waSocket,
  sendTrackedMessage,
  downloadMediaBuffer,
  resolveStickerAudio,
  isOwnUserJid,
  isOwnMessageId,
  remoteJid,
  senderKey,
  fromMe = false,
  isGroup = false,
  profile,
  messageText,
  msg,
  normalizedMessage,
  toolRegistry,
  llm,
  antiSpamGuard,
  addLog
}) {
  const parsed = parseUtilityCommand(messageText);
  if (!parsed) return false;

  const mediaLookupOpts = { isOwnUserJid, isOwnMessageId };

  const replyFn = async (payload, options = { quoted: msg }) => {
    if (typeof sendTrackedMessage === 'function') {
      return await sendTrackedMessage(remoteJid, payload, options);
    }
    return await waSocket.sendMessage(remoteJid, payload, options);
  };

  const baseActor = fromMe ? 'Pemilik (fromMe)' : `${profile?.name || senderKey}`;
  const actorLabel = isGroup ? `${baseActor} [Grup]` : baseActor;

  // Evaluasi perlindungan anti-spam WhatsApp berlapis (pemilik bebas jeda & kuota)
  if (antiSpamGuard) {
    const access = antiSpamGuard.checkAccess({
      senderKey,
      fromMe,
      isKnown: Boolean(profile?.isKnown),
      isMediaCommand: parsed.isMediaCommand,
      isGroup,
      groupJid: isGroup ? remoteJid : null
    });

    if (!access.allowed) {
      if (access.shouldReply && access.replyText) {
        try {
          await replyFn({ text: access.replyText });
        } catch {}
      }
      return true;
    }

    // Jeda alami singkat untuk balasan ke lawan bicara agar tidak terlihat seperti bot spam
    if (!fromMe && access.jitterMs > 0) {
      try {
        if (waSocket && typeof waSocket.sendPresenceUpdate === 'function') {
          await waSocket.sendPresenceUpdate('composing', remoteJid);
        }
      } catch {}
      await sleep(access.jitterMs);
      try {
        if (waSocket && typeof waSocket.sendPresenceUpdate === 'function') {
          await waSocket.sendPresenceUpdate('paused', remoteJid);
        }
      } catch {}
    }
  }

  const runMediaJob = async (jobFn) => {
    if (antiSpamGuard && typeof antiSpamGuard.runWithMediaSlot === 'function') {
      return await antiSpamGuard.runWithMediaSlot(jobFn);
    }
    return await jobFn();
  };

  try {
    switch (parsed.command) {
      case 'menu': {
        const menuText = buildMenuText({
          showOwnerCommands: fromMe || Boolean(profile?.isKnown),
          isOwner: fromMe
        });
        await replyFn({ text: menuText });
        addLog('info', `Perintah ${parsed.trigger} dijalankan oleh ${actorLabel}.`);
        return true;
      }

      case 'ping': {
        const startedAt = Date.now();
        if (!fromMe) {
          // Sembunyikan identitas bot, uptime server, dan nama model dari non-pemilik (DATA-03)
          const elapsedMs = Date.now() - startedAt;
          await replyFn({ text: `Aktif (${elapsedMs} milidetik).` });
          addLog('info', `Perintah ${parsed.trigger} (mode ringkas) dijalankan oleh ${actorLabel}.`);
          return true;
        }
        let llmText = 'Tidak terhubung';
        if (llm && typeof llm.checkHealth === 'function') {
          try {
            const health = await llm.checkHealth({ force: false });
            llmText = health.connected ? `Aktif (${llm.model})` : 'Tidak terhubung';
          } catch {}
        }
        const elapsedMs = Date.now() - startedAt;
        const text = [
          'Pong! Bot aktif.',
          `- Waktu respon: ${elapsedMs} milidetik`,
          `- Waktu aktif proses: ${formatUptime(process.uptime())}`,
          `- Status Large Language Model (LLM): ${llmText}`
        ].join('\n');
        await replyFn({ text });
        addLog('info', `Perintah !ping dijalankan oleh ${actorLabel}.`);
        return true;
      }

      case 'sticker': {
        const candidate = extractMediaCandidate(msg, normalizedMessage, mediaLookupOpts);
        if (!candidate) {
          await replyFn({
            text: 'Kirim foto, GIF, atau video pendek dengan caption `!sticker` (atau `!s` / `.s`), atau balas media tersebut ya. Tambahkan `crop` kalau mau potong kotak penuh.'
          });
          return true;
        }
        if (candidate.kind === 'view_once') {
          await replyFn({
            text: 'Maaf, foto atau video sekali lihat (View Once) tidak bisa diubah menjadi stiker untuk menghormati privasi pengirimnya.'
          });
          return true;
        }
        if (candidate.kind === 'sticker') {
          await replyFn({
            text: 'Itu sudah berbentuk stiker ya. Kalau mau ubah jadi gambar pakai `!toimg`, atau ganti nama paketnya pakai `!wm Nama Paket | Pembuat`.'
          });
          return true;
        }
        if (candidate.kind !== 'image' && candidate.kind !== 'video') {
          await replyFn({
            text: 'Maaf, perintah `!sticker` hanya menerima foto, GIF, atau video pendek (bukan audio atau dokumen lain). Coba kirim foto, GIF, atau video ya.'
          });
          return true;
        }
        if (candidate.kind === 'video' && candidate.seconds > MAX_VIDEO_INPUT_SECONDS) {
          await replyFn({
            text: `Maaf, durasi videonya terlalu panjang (${candidate.seconds} detik, maksimal ${MAX_VIDEO_INPUT_SECONDS} detik) supaya bisa dijadikan stiker bergerak WhatsApp. Potong dulu videonya lebih singkat ya.`
          });
          return true;
        }

        const argsLower = parsed.args.toLowerCase();
        const useCrop = /\b(crop|full|potong)\b/.test(argsLower);
        const muteAudio = /\b(mute|bisu|nosound|tanpasuara)\b/.test(argsLower);
        const wmSource = parsed.args
          .replace(/\b(crop|full|potong|mute|bisu|nosound|tanpasuara)\b/gi, '')
          .trim();
        const { packName, author } = parseWatermarkArgs(wmSource);

        const isAnimatedCandidate =
          candidate.kind === 'video' || String(candidate.mimeType || '').toLowerCase() === 'image/gif';
        const wantVideoAudio =
          candidate.kind === 'video' && !candidate.gifPlayback && !muteAudio;

        const stickerResult = await runMediaJob(async () => {
          const mediaBuffer = await downloadValidatedMediaBuffer(candidate, downloadMediaBuffer);
          if (isAnimatedCandidate) {
            if (wantVideoAudio) {
              return await convertVideoOrGifToSticker(mediaBuffer, {
                crop: useCrop,
                packName,
                author,
                includeAudio: true
              });
            }
            const buf = await convertVideoOrGifToSticker(mediaBuffer, {
              crop: useCrop,
              packName,
              author,
              includeAudio: false
            });
            return { stickerBuffer: buf, audioBuffer: null, audioSeconds: 0, hasAudio: false };
          }
          const buf = await convertImageToSticker(mediaBuffer, { crop: useCrop, packName, author });
          return { stickerBuffer: buf, audioBuffer: null, audioSeconds: 0, hasAudio: false };
        });

        if (stickerResult.hasAudio && stickerResult.audioBuffer) {
          await replyFn({
            sticker: stickerResult.stickerBuffer,
            audioSticker: {
              audioBuffer: stickerResult.audioBuffer,
              audioSeconds: stickerResult.audioSeconds
            }
          });
          addLog(
            'info',
            `Perintah ${parsed.trigger} berhasil mengirim stiker suara (${stickerResult.audioSeconds} detik) untuk ${actorLabel}.`
          );
        } else {
          await replyFn({ sticker: stickerResult.stickerBuffer });
          addLog(
            'info',
            `Perintah ${parsed.trigger} berhasil mengirim stiker${isAnimatedCandidate ? ' bergerak' : ''} untuk ${actorLabel}.`
          );
        }
        return true;
      }

      case 'toimg': {
        const candidate = extractMediaCandidate(msg, normalizedMessage, mediaLookupOpts);
        if (!candidate || candidate.kind !== 'sticker') {
          await replyFn({
            text: 'Maaf, perintah `!toimg` hanya bisa dipakai untuk membalas stiker WhatsApp (bukan foto biasa, video, atau dokumen). Balas stikernya dengan `!toimg` ya.'
          });
          return true;
        }

        const result = await runMediaJob(async () => {
          const webpBuffer = await downloadValidatedMediaBuffer(candidate, downloadMediaBuffer);
          const preservedAudio = await resolvePreservedStickerAudio(candidate, {
            resolveStickerAudio,
            downloadMediaBuffer
          });
          return await convertStickerToMedia(
            webpBuffer,
            preservedAudio ? { audioBuffer: preservedAudio.audioBuffer } : {}
          );
        });

        let payload;
        let outputLabel;
        if (result.kind === 'video') {
          payload = {
            video: result.buffer,
            mimetype: 'video/mp4'
          };
          outputLabel = 'video bersuara';
        } else if (result.kind === 'gif') {
          payload = {
            video: result.buffer,
            gifPlayback: true,
            mimetype: 'video/mp4'
          };
          outputLabel = 'GIF';
        } else if (result.kind === 'gif_document') {
          payload = {
            document: result.buffer,
            mimetype: 'image/gif',
            fileName: 'sticker.gif'
          };
          outputLabel = 'berkas GIF';
        } else {
          payload = { image: result.buffer };
          outputLabel = 'gambar';
        }

        await replyFn(payload);
        if (result.kind !== 'video' && candidate.hasSoundMarkerField24) {
          addLog(
            'warn',
            `Catatan ${parsed.trigger} (${actorLabel}): stiker bertanda bidang 24 namun data suara tidak ditemukan dari cache maupun pemulihan PDO; dikirim sebagai ${outputLabel}.`
          );
        }
        addLog('info', `Perintah ${parsed.trigger} berhasil mengubah stiker ke ${outputLabel} untuk ${actorLabel}.`);
        return true;
      }

      case 'wm': {
        const candidate = extractMediaCandidate(msg, normalizedMessage, mediaLookupOpts);
        if (!candidate || candidate.kind !== 'sticker') {
          await replyFn({
            text: 'Balas sebuah stiker WhatsApp dengan `!wm <Nama Paket> | <Pembuat>`, contoh: `!wm Stikerku | Fariez`.'
          });
          return true;
        }

        const { packName, author } = parseWatermarkArgs(parsed.args);
        const wmOutcome = await runMediaJob(async () => {
          const webpBuffer = await downloadValidatedMediaBuffer(candidate, downloadMediaBuffer);
          const updatedSticker = await rewriteStickerExif(webpBuffer, { packName, author });
          const preservedAudio = await resolvePreservedStickerAudio(candidate, {
            resolveStickerAudio,
            downloadMediaBuffer
          });
          return { sticker: updatedSticker, audioSticker: preservedAudio };
        });

        await replyFn(
          wmOutcome.audioSticker
            ? { sticker: wmOutcome.sticker, audioSticker: wmOutcome.audioSticker }
            : { sticker: wmOutcome.sticker }
        );
        if (!wmOutcome.audioSticker && candidate.hasSoundMarkerField24) {
          addLog(
            'warn',
            `Catatan ${parsed.trigger} (${actorLabel}): stiker bertanda bidang 24 namun data suara tidak ditemukan dari cache maupun pemulihan PDO; dikirim tanpa trek audio.`
          );
        }
        addLog(
          'info',
          `Perintah ${parsed.trigger} memperbarui metadata stiker${wmOutcome.audioSticker ? ' suara' : ''} (${packName} | ${author}) untuk ${actorLabel}.`
        );
        return true;
      }

      case 'crop': {
        const candidate = extractMediaCandidate(msg, normalizedMessage, mediaLookupOpts);
        if (!candidate) {
          await replyFn({
            text: 'Kirim foto, video, atau GIF dengan caption `!crop` (atau `.crop`), atau balas media tersebut untuk memotongnya menjadi kotak 1:1 ya.'
          });
          return true;
        }
        if (candidate.kind === 'view_once') {
          await replyFn({
            text: 'Maaf, foto atau video sekali lihat (View Once) tidak bisa diolah dengan perintah ini untuk menghormati privasi pengirimnya.'
          });
          return true;
        }
        if (candidate.kind === 'sticker') {
          await replyFn({
            text: 'Stiker WhatsApp umumnya sudah berbentuk kotak 1:1 ya. Kalau mau ubah stiker jadi gambar atau GIF dulu pakai `!toimg`, lalu jalankan `!crop` pada foto, video, atau GIF.'
          });
          return true;
        }
        if (candidate.kind !== 'image' && candidate.kind !== 'video') {
          await replyFn({
            text: 'Maaf, perintah `!crop` hanya menerima gambar, video, atau GIF (bukan audio atau dokumen lain). Coba kirim foto, video, atau GIF ya.'
          });
          return true;
        }
        if (candidate.kind === 'video' && candidate.seconds > MAX_CROP_VIDEO_SECONDS) {
          await replyFn({
            text: `Maaf, durasi videonya terlalu panjang (${candidate.seconds} detik, maksimal ${MAX_CROP_VIDEO_SECONDS} detik) untuk dipotong 1:1. Potong dulu videonya lebih singkat ya.`
          });
          return true;
        }

        const result = await runMediaJob(async () => {
          const mediaBuffer = await downloadValidatedMediaBuffer(candidate, downloadMediaBuffer);
          if (candidate.kind === 'video') {
            return await cropVideoOrGifToSquare(mediaBuffer, {
              asGif: Boolean(candidate.gifPlayback)
            });
          }
          return await cropImageToSquare(mediaBuffer);
        });

        let payload;
        let outputLabel;
        if (result.kind === 'gif') {
          payload = {
            video: result.buffer,
            gifPlayback: true,
            mimetype: 'video/mp4'
          };
          outputLabel = 'GIF 1:1';
        } else if (result.kind === 'gif_document') {
          payload = {
            document: result.buffer,
            mimetype: 'image/gif',
            fileName: 'cropped.gif'
          };
          outputLabel = 'berkas GIF 1:1';
        } else if (result.kind === 'video') {
          payload = {
            video: result.buffer,
            mimetype: 'video/mp4'
          };
          outputLabel = 'video 1:1';
        } else {
          payload = { image: result.buffer };
          outputLabel = 'gambar 1:1';
        }

        await replyFn(payload);
        addLog('info', `Perintah ${parsed.trigger} berhasil memotong ${outputLabel} untuk ${actorLabel}.`);
        return true;
      }

      case 'text': {
        if (!parsed.args) {
          await replyFn({
            text: 'Pakai: `!text <teks>`, contoh: `!text pro banget kak, problem`'
          });
          return true;
        }

        const pngBuffer = await runMediaJob(async () => {
          return await renderTextBlurImage(parsed.args, { asSticker: false });
        });

        await replyFn({ image: pngBuffer });
        addLog('info', `Perintah !text selesai dibuat untuk ${actorLabel}.`);
        return true;
      }

      case 'stext': {
        if (!parsed.args) {
          await replyFn({
            text: 'Pakai: `!stext <teks>`, contoh: `!stext pro banget kak, problem`'
          });
          return true;
        }

        const webpBuffer = await runMediaJob(async () => {
          return await renderTextBlurImage(parsed.args, { asSticker: true });
        });

        await replyFn({ sticker: webpBuffer });
        addLog('info', `Perintah ${parsed.trigger} selesai dibuat menjadi stiker untuk ${actorLabel}.`);
        return true;
      }

      case 'cap':
      case 'caphd': {
        const isCleanCap = parsed.command === 'caphd';
        const cmdLabel = isCleanCap ? '!caphd' : '!cap';
        const { topText, bottomText } = parseCapArgs(parsed.args);
        if (!topText && !bottomText) {
          await replyFn({
            text: `Pakai: kirim foto, video, atau GIF dengan caption \`${cmdLabel} <teks atas> | <teks bawah>\` (atau \`.${cmdLabel.slice(1)}\`), atau balas foto, video, GIF, maupun stiker dengan perintah tersebut. Kalau cuma 1 teks, otomatis ditaruh di bawah ya.`
          });
          return true;
        }

        const candidate = extractMediaCandidate(msg, normalizedMessage, mediaLookupOpts);
        if (!candidate) {
          await replyFn({
            text: `Medianya belum ada. Kirim foto, video, atau GIF dengan caption \`${cmdLabel} <teks atas> | <teks bawah>\` atau balas sebuah foto, video, GIF, maupun stiker ya.`
          });
          return true;
        }
        if (candidate.kind === 'view_once') {
          await replyFn({
            text: 'Maaf, foto atau video sekali lihat (View Once) tidak bisa diolah dengan perintah ini untuk menghormati privasi pengirimnya.'
          });
          return true;
        }
        if (candidate.kind === 'sticker') {
          const stickerOutcome = await runMediaJob(async () => {
            const webpBuffer = await downloadValidatedMediaBuffer(candidate, downloadMediaBuffer);
            const stickerBuffer = await renderCapSticker(webpBuffer, {
              topText,
              bottomText,
              clean: isCleanCap
            });
            const preservedAudio = await resolvePreservedStickerAudio(candidate, {
              resolveStickerAudio,
              downloadMediaBuffer
            });
            return { sticker: stickerBuffer, audioSticker: preservedAudio };
          });

          await replyFn(
            stickerOutcome.audioSticker
              ? { sticker: stickerOutcome.sticker, audioSticker: stickerOutcome.audioSticker }
              : { sticker: stickerOutcome.sticker }
          );
          if (!stickerOutcome.audioSticker && candidate.hasSoundMarkerField24) {
            addLog(
              'warn',
              `Catatan ${parsed.trigger} (${actorLabel}): stiker bertanda bidang 24 namun data suara tidak ditemukan dari cache maupun pemulihan PDO; dikirim tanpa trek audio.`
            );
          }
          addLog(
            'info',
            `Perintah ${parsed.trigger} pada stiker${stickerOutcome.audioSticker ? ' suara' : ''} selesai dibuat untuk ${actorLabel}.`
          );
          return true;
        }
        if (candidate.kind === 'video') {
          if (candidate.seconds > MAX_CAP_VIDEO_SECONDS) {
            await replyFn({
              text: `Maaf, durasi videonya terlalu panjang (${candidate.seconds} detik, maksimal ${MAX_CAP_VIDEO_SECONDS} detik) untuk diberi caption ${cmdLabel}. Potong dulu videonya lebih singkat ya.`
            });
            return true;
          }

          const result = await runMediaJob(async () => {
            const mediaBuffer = await downloadValidatedMediaBuffer(candidate, downloadMediaBuffer);
            return await renderCapVideoOrGif(mediaBuffer, {
              topText,
              bottomText,
              asGif: Boolean(candidate.gifPlayback),
              clean: isCleanCap
            });
          });

          const payload =
            result.kind === 'gif'
              ? { video: result.buffer, gifPlayback: true, mimetype: 'video/mp4' }
              : { video: result.buffer, mimetype: 'video/mp4' };
          const outputLabel = result.kind === 'gif' ? 'GIF' : 'video';

          await replyFn(payload);
          addLog('info', `Perintah ${parsed.trigger} pada ${outputLabel} selesai dibuat untuk ${actorLabel}.`);
          return true;
        }
        if (candidate.kind !== 'image') {
          await replyFn({
            text: `Maaf, perintah \`${cmdLabel}\` hanya menerima foto, video, GIF, atau stiker (bukan audio atau dokumen non-media). Coba kirim atau balas foto, video, GIF, atau stiker ya.`
          });
          return true;
        }

        const isGifImage = String(candidate.mimeType || '').toLowerCase() === 'image/gif';
        const outcome = await runMediaJob(async () => {
          const mediaBuffer = await downloadValidatedMediaBuffer(candidate, downloadMediaBuffer);
          if (isGifImage) {
            const meta = await validateImageBuffer(mediaBuffer);
            if (meta.format === 'gif' && meta.pages && meta.pages > 1) {
              const gifRes = await renderCapVideoOrGif(mediaBuffer, {
                topText,
                bottomText,
                asGif: true,
                clean: isCleanCap
              });
              return { kind: 'gif', buffer: gifRes.buffer };
            }
          }
          const memeBuffer = await renderCapMeme(mediaBuffer, {
            topText,
            bottomText,
            clean: isCleanCap
          });
          return { kind: 'image', buffer: memeBuffer };
        });

        if (outcome.kind === 'gif') {
          await replyFn({ video: outcome.buffer, gifPlayback: true, mimetype: 'video/mp4' });
          addLog('info', `Perintah ${parsed.trigger} pada GIF selesai dibuat untuk ${actorLabel}.`);
        } else {
          await replyFn({ image: outcome.buffer });
          addLog('info', `Perintah ${parsed.trigger} selesai dibuat untuk ${actorLabel}.`);
        }
        return true;
      }

      case 'cuaca': {
        if (!toolRegistry || typeof toolRegistry.executeGetWeather !== 'function') {
          await replyFn({ text: 'Maaf, layanan pengecekan cuaca sedang tidak tersedia.' });
          return true;
        }
        const city = parsed.args || toolRegistry.defaultCity || 'Tasikmalaya';
        const res = await toolRegistry.executeGetWeather({ city });
        if (!res || !res.success) {
          await replyFn({
            text: res?.pesan || `Maaf, gagal mengambil data cuaca untuk "${city}". Coba sebentar lagi ya.`
          });
          return true;
        }
        const text = [
          `*Cuaca ${res.kota} Saat Ini*`,
          `- Kondisi: ${res.kondisi}`,
          `- Suhu: ${res.suhu} (terasa ${res.terasa_seperti})`,
          `- Kelembaban: ${res.kelembaban}`,
          `- Presipitasi: ${res.presipitasi}`
        ].join('\n');
        await replyFn({ text });
        addLog('info', `Perintah !cuaca (${res.kota}) dijalankan oleh ${actorLabel}.`);
        return true;
      }

      case 'jam': {
        if (!toolRegistry || typeof toolRegistry.executeGetCurrentTime !== 'function') {
          await replyFn({ text: 'Maaf, layanan waktu sedang tidak tersedia.' });
          return true;
        }
        const res = toolRegistry.executeGetCurrentTime({ timezone: parsed.args || undefined });
        const text = `Sekarang hari *${res.tanggal}*, pukul *${res.jam}* (${res.waktu_fase}, zona ${res.zona_waktu}).`;
        await replyFn({ text });
        addLog('info', `Perintah ${parsed.trigger} dijalankan oleh ${actorLabel}.`);
        return true;
      }

      case 'pilih': {
        const options = parsed.args
          .split('|')
          .map((item) => item.trim())
          .filter(Boolean);
        if (options.length < 2) {
          await replyFn({
            text: 'Pakai minimal 2 pilihan dipisahkan tanda `|`, contoh: `!pilih bakso | mie ayam | nasi goreng`'
          });
          return true;
        }
        const chosen = options[Math.floor(Math.random() * options.length)];
        await replyFn({ text: `Pilihan jatuh ke: *${chosen}*` });
        addLog('info', `Perintah !pilih (${options.length} opsi) dijalankan oleh ${actorLabel}.`);
        return true;
      }

      default:
        return false;
    }
  } catch (err) {
    // Catat galat ke stderr (otomatis masuk bot.log seperti error lain) dan ke dasbor web
    console.error(`[CommandError ${parsed.trigger}] (${actorLabel}):`, err.stack || err.message);
    addLog('error', `Gagal menjalankan perintah ${parsed.trigger} dari ${actorLabel}: ${err.message}`, {
      command: parsed.trigger,
      sender: actorLabel
    });

    const userMsg =
      err instanceof MediaValidationError || err.userMessage
        ? err.userMessage
        : `Maaf, perintah ${parsed.trigger} belum berhasil diproses. Coba lagi sebentar ya.`;

    try {
      await replyFn({ text: userMsg });
    } catch (replyErr) {
      console.error(`[CommandReplyError ${parsed.trigger}]:`, replyErr.message);
    }
    return true;
  }
}

module.exports = {
  SUPPORTED_PREFIXES,
  COMMAND_ALIAS_GROUPS,
  COMMAND_ALIASES,
  MEDIA_COMMANDS,
  unwrapWhatsAppMessage,
  cleanCommandText,
  parseUtilityCommand,
  parseCapArgs,
  parseWatermarkArgs,
  parseFileLength,
  extractMediaCandidate,
  buildMenuText,
  handleUtilityCommands
};
