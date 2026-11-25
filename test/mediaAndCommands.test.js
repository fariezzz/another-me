const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { isValidWebpBuffer } = require('../src/utils/atomicFile');
const { injectWebpExif, readWebpExifMetadata } = require('../src/utils/webpExif');
const {
  isEmojiGrapheme,
  emojiToTwemojiCandidates,
  splitLineIntoRuns,
  fetchEmojiSvgBuffer,
  clearEmojiMemoryCache
} = require('../src/utils/emojiRenderer');
const {
  MAX_MEDIA_BYTES,
  MAX_ANIMATED_STICKER_BYTES,
  MAX_STICKER_AUDIO_BYTES,
  MAX_CAP_VIDEO_SECONDS,
  MediaValidationError,
  resolveCapBlurMode,
  resolveCapTextBlurSigma,
  resolveCapMaxDim,
  resolveCapFontScale,
  computeCapDegradeParams,
  subsampleFrames,
  probeVideoAudioInfo,
  validateImageBuffer,
  convertImageToSticker,
  convertVideoOrGifToSticker,
  convertStickerToPng,
  rewriteStickerExif,
  renderTextBlurImage,
  renderCapMeme,
  renderCapSticker,
  renderCapVideoOrGif,
  cropImageToSquare,
  cropVideoOrGifToSquare,
  layoutImpactBlock
} = require('../src/media/imageProcessor');
const {
  AUDIO_STICKER_SYMBOL,
  findLengthDelimitedField,
  isAnimatedWebpBuffer,
  registerAudioForStickerMessage,
  installAudioStickerProtoPatch
} = require('../src/whatsapp/audioStickerCodec');
const { CommandAntiSpamGuard } = require('../src/whatsapp/commandAntiSpam');
const {
  COMMAND_ALIAS_GROUPS,
  COMMAND_ALIASES,
  parseUtilityCommand,
  parseCapArgs,
  parseWatermarkArgs,
  parseFileLength,
  extractMediaCandidate,
  handleUtilityCommands
} = require('../src/whatsapp/utilityCommands');
const BaileysService = require('../src/whatsapp/baileysService');

/**
 * Helper menghitung rata-rata gradien tepi horizontal pada sebuah baris gambar raw RGB
 * untuk membuktikan secara matematis bahwa tahap blur akhir melembutkan piksel foto & teks.
 */
async function measureMaxHorizontalEdgeStep(imageBuffer, yFraction) {
  const { data, info } = await sharp(imageBuffer)
    .flatten({ background: '#808080' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const y = Math.max(0, Math.min(info.height - 1, Math.floor(info.height * yFraction)));
  let maxDelta = 0;
  for (let x = 1; x < info.width; x++) {
    const idxA = (y * info.width + (x - 1)) * info.channels;
    const idxB = (y * info.width + x) * info.channels;
    const lumA = (data[idxA] + data[idxA + 1] + data[idxA + 2]) / 3;
    const lumB = (data[idxB] + data[idxB + 1] + data[idxB + 2]) / 3;
    const delta = Math.abs(lumB - lumA);
    if (delta > maxDelta) maxDelta = delta;
  }
  return maxDelta;
}

test('parseUtilityCommand and parseCapArgs handle ! and . prefixes, backup aliases, single text bottom-only, and ignore false positives', () => {
  // Awalan ! dan . untuk seluruh perintah dan alias cadangannya
  assert.equal(parseUtilityCommand('!menu').command, 'menu');
  assert.equal(parseUtilityCommand('.bantuan').command, 'menu');
  assert.equal(parseUtilityCommand('!HELP').command, 'menu');
  assert.equal(parseUtilityCommand('.cek').command, 'ping');
  assert.equal(parseUtilityCommand('!sticker').command, 'sticker');
  assert.equal(parseUtilityCommand('!stiker').command, 'sticker');
  assert.equal(parseUtilityCommand('!s crop').command, 'sticker');
  assert.equal(parseUtilityCommand('.sticker').command, 'sticker');
  assert.equal(parseUtilityCommand('.stiker').command, 'sticker');
  assert.equal(parseUtilityCommand('.s crop').command, 'sticker');
  assert.equal(parseUtilityCommand('.s crop').args, 'crop');
  assert.equal(parseUtilityCommand('.s crop').trigger, '.s');
  assert.equal(parseUtilityCommand('.gambar').command, 'toimg');
  assert.equal(parseUtilityCommand('.steal Paket | Fariez').command, 'wm');
  assert.equal(parseUtilityCommand('!crop').command, 'crop');
  assert.equal(parseUtilityCommand('.potong').command, 'crop');
  assert.equal(parseUtilityCommand('!square').command, 'crop');
  assert.equal(parseUtilityCommand('.kotak').command, 'crop');
  assert.equal(parseUtilityCommand('!teks halo').command, 'text');

  // Pastikan seluruh alias di COMMAND_ALIAS_GROUPS unik tanpa tabrakan antar perintah
  const totalDeclaredAliases = Object.values(COMMAND_ALIAS_GROUPS).reduce((sum, arr) => sum + arr.length, 0);
  assert.equal(COMMAND_ALIASES.size, totalDeclaredAliases, 'Tidak boleh ada alias yang bertabrakan antar perintah');
  assert.equal(parseUtilityCommand('.txt halo').command, 'text');
  assert.equal(parseUtilityCommand('!stext pro banget').command, 'stext');
  assert.equal(parseUtilityCommand('.brat halo').command, 'stext');
  assert.equal(parseUtilityCommand('.st halo').command, 'stext');
  assert.equal(parseUtilityCommand('!cap Satu | SIRKEL').command, 'cap');
  assert.equal(parseUtilityCommand('.cap Satu | SIRKEL').command, 'cap');
  assert.equal(parseUtilityCommand('!caption Satu | SIRKEL').command, 'cap');
  assert.equal(parseUtilityCommand('.burem SIRKEL').command, 'cap');
  assert.equal(parseUtilityCommand('.cuaca Bandung').command, 'cuaca');
  assert.equal(parseUtilityCommand('.waktu').command, 'jam');
  assert.equal(parseUtilityCommand('.acak a | b').command, 'pilih');

  // !cari beserta aliasnya sudah dihapus (digantikan !ask); perintah bawaan & teks acak tidak boleh tertangkap
  assert.equal(parseUtilityCommand('!cari presiden'), null);
  assert.equal(parseUtilityCommand('.wiki kucing'), null);
  assert.equal(parseUtilityCommand('.search berita'), null);
  assert.equal(parseUtilityCommand('.info tes'), null);
  assert.equal(parseUtilityCommand('!acep off'), null);
  assert.equal(parseUtilityCommand('!ask kenapa langit biru'), null);
  assert.equal(parseUtilityCommand('!tanya halo'), null);
  assert.equal(parseUtilityCommand('!jmk lama'), null);
  assert.equal(parseUtilityCommand('!?'), null);
  assert.equal(parseUtilityCommand('...'), null);
  assert.equal(parseUtilityCommand('..s'), null);
  assert.equal(parseUtilityCommand('.pdf'), null);
  assert.equal(parseUtilityCommand('.env'), null);
  assert.equal(parseUtilityCommand('!tidakterdaftar tes'), null);
  assert.equal(parseUtilityCommand('halo biasa'), null);

  assert.deepEqual(parseCapArgs('Satu | SIRKEL'), { topText: 'Satu', bottomText: 'SIRKEL' });
  assert.deepEqual(parseCapArgs('SIRKEL'), { topText: '', bottomText: 'SIRKEL' });
  assert.deepEqual(parseCapArgs('Atas saja |'), { topText: 'Atas saja', bottomText: '' });
  assert.deepEqual(parseCapArgs('| Bawah saja'), { topText: '', bottomText: 'Bawah saja' });
  assert.deepEqual(parseCapArgs(''), { topText: '', bottomText: '' });

  assert.deepEqual(parseWatermarkArgs('Paketku | Kiraya'), { packName: 'Paketku', author: 'Kiraya' });
  assert.equal(parseFileLength({ low: 1024, high: 0 }), 1024);
  assert.equal(parseFileLength({ toNumber: () => 2048 }), 2048);
});

test('validateImageBuffer enforces 5 Megabyte limit and politely rejects non-image payloads', async () => {
  const oversized = Buffer.alloc(MAX_MEDIA_BYTES + 10);
  await assert.rejects(
    () => validateImageBuffer(oversized),
    (err) => err instanceof MediaValidationError && err.code === 'TOO_LARGE'
  );

  const fakePdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF', 'utf-8');
  await assert.rejects(
    () => validateImageBuffer(fakePdf),
    (err) => err instanceof MediaValidationError && err.code === 'NOT_IMAGE'
  );
});

test('!text renders 720x720 white-background blurred black text PNG, and !stext renders 512x512 WebP sticker', async () => {
  const pngBuf = await renderTextBlurImage('pro banget kak, problem', { asSticker: false });
  const meta = await sharp(pngBuf).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 720);
  assert.equal(meta.height, 720);

  // Periksa sudut putih polos, piksel teks gelap, dan piksel abu-abu transisi hasil blur
  const { data, info } = await sharp(pngBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // Piksel pojok kiri atas (0,0) harus putih murni
  assert.ok(data[0] >= 250 && data[1] >= 250 && data[2] >= 250, 'Latar harus putih polos');

  let darkPixels = 0;
  let midGrayBlurPixels = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (lum < 80) darkPixels++;
    else if (lum >= 90 && lum <= 220) midGrayBlurPixels++;
  }
  assert.ok(darkPixels > 1000, 'Harus terdapat piksel teks hitam');
  assert.ok(midGrayBlurPixels > 500, 'Harus terdapat piksel transisi abu-abu akibat Gaussian blur tipis');

  // Varian !stext langsung menjadi stiker WebP 512x512 dengan metadata EXIF
  const stickerBuf = await renderTextBlurImage('pro banget kak, problem', {
    asSticker: true,
    packName: 'Another Me Test',
    author: 'Fariez'
  });
  assert.equal(isValidWebpBuffer(stickerBuf), true);
  const stkMeta = await sharp(stickerBuf).metadata();
  assert.equal(stkMeta.width, 512);
  assert.equal(stkMeta.height, 512);
  const exif = readWebpExifMetadata(stickerBuf);
  assert.equal(exif['sticker-pack-name'], 'Another Me Test');
  assert.equal(exif['sticker-pack-publisher'], 'Fariez');
});

test('!cap inserts Impact text FIRST then blurs the ENTIRE combined image (photo + text together)', async () => {
  // Buat foto sintetis tajam 640x640: setengah kiri hitam pekat, setengah kanan putih terang
  const width = 640;
  const height = 640;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const val = x < width / 2 ? 15 : 240;
      raw[idx] = val;
      raw[idx + 1] = val;
      raw[idx + 2] = val;
    }
  }
  const sharpTestPhoto = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();

  const stages = await renderCapMeme(sharpTestPhoto, {
    topText: 'Satu',
    bottomText: 'SIRKEL',
    blurMode: 'after',
    blurSigma: 3.0,
    maxDim: 512,
    returnStages: true
  });

  const finalMeta = await sharp(stages.finalBuffer).metadata();
  assert.equal(finalMeta.format, 'jpeg');
  assert.equal(finalMeta.width, 512);
  assert.equal(finalMeta.height, 512);

  // 1. Pada area tengah foto (y = 50%, bebas teks), tahap 1 masih sangat tajam, tahap 2 melembut signifikan
  const midEdgeStage1 = await measureMaxHorizontalEdgeStep(stages.composedBuffer, 0.5);
  const midEdgeStage2 = await measureMaxHorizontalEdgeStep(stages.finalBuffer, 0.5);
  assert.ok(midEdgeStage1 > 180, `Tahap 1 foto harus masih tajam (got ${midEdgeStage1})`);
  assert.ok(midEdgeStage2 < midEdgeStage1 * 0.55, `Tahap 2 foto harus ikut blur (${midEdgeStage2} vs ${midEdgeStage1})`);

  // 2. Pada area teks bawah (y = 90%), tahap 1 outline teks masih tajam, tahap 2 ikut blur bersamaan
  const bottomEdgeStage1 = await measureMaxHorizontalEdgeStep(stages.composedBuffer, 0.9);
  const bottomEdgeStage2 = await measureMaxHorizontalEdgeStep(stages.finalBuffer, 0.9);
  assert.ok(bottomEdgeStage1 > 180, `Tahap 1 teks harus masih tajam sebelum blur (got ${bottomEdgeStage1})`);
  assert.ok(bottomEdgeStage2 < bottomEdgeStage1 * 0.75, `Tahap 2 teks harus ikut blur bareng foto (${bottomEdgeStage2} vs ${bottomEdgeStage1})`);

  // 3. Teks pendek seperti "FARIEZ TIDUR" pada foto potret 768x1024 harus tetap 1 baris,
  //    sedangkan teks panjang seperti "BESOK NGEBOHONG LAGI" baru dipecah menjadi 2 baris seimbang.
  const shortLayout = layoutImpactBlock('FARIEZ TIDUR', 768, 1024, 1.0);
  assert.equal(shortLayout.lines.length, 1);
  assert.equal(shortLayout.lines[0], 'FARIEZ TIDUR');

  const longLayout = layoutImpactBlock('BESOK NGEBOHONG LAGI', 768, 1024, 1.0);
  assert.equal(longLayout.lines.length, 2);

  // 4. Ukuran font bawaan tetap proporsional (~12% tinggi pada 640x640) dan bisa diatur lewat CAP_FONT_SCALE
  const prevFontScale = process.env.CAP_FONT_SCALE;
  try {
    delete process.env.CAP_FONT_SCALE;
    assert.equal(resolveCapFontScale(), 1.0);
    assert.equal(resolveCapFontScale(0.2), 0.5);
    assert.equal(resolveCapFontScale(3.0), 1.6);

    const baseSquare = layoutImpactBlock('KIRAYA', 640, 640, 1.0);
    assert.ok(baseSquare.fontSize <= 84 && baseSquare.fontSize >= 64, `Font bawaan harus proporsional (got ${baseSquare.fontSize})`);

    process.env.CAP_FONT_SCALE = '0.8';
    assert.equal(resolveCapFontScale(), 0.8);
    const smallerSquare = layoutImpactBlock('KIRAYA', 640, 640);
    assert.ok(smallerSquare.fontSize < baseSquare.fontSize, `CAP_FONT_SCALE=0.8 harus memperkecil font (${smallerSquare.fontSize} vs ${baseSquare.fontSize})`);
  } finally {
    if (prevFontScale === undefined) delete process.env.CAP_FONT_SCALE;
    else process.env.CAP_FONT_SCALE = prevFontScale;
  }
});

test('!sticker, !wm, and !toimg round-trip cleanly with valid WebP EXIF metadata', async () => {
  const samplePhoto = await sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 20, g: 140, b: 95 } }
  })
    .png()
    .toBuffer();

  const stickerBuf = await convertImageToSticker(samplePhoto, {
    crop: false,
    packName: 'Another Me',
    author: 'Fariez'
  });
  assert.equal(isValidWebpBuffer(stickerBuf), true);
  const sMeta = await sharp(stickerBuf).metadata();
  assert.equal(sMeta.width, 512);
  assert.equal(sMeta.height, 512);
  assert.equal(readWebpExifMetadata(stickerBuf)['sticker-pack-name'], 'Another Me');

  // !wm mengganti nama paket & pembuat tanpa merusak stiker
  const rebranded = await rewriteStickerExif(stickerBuf, {
    packName: 'Koleksi Baru',
    author: 'Kiraya'
  });
  assert.equal(isValidWebpBuffer(rebranded), true);
  assert.equal(readWebpExifMetadata(rebranded)['sticker-pack-name'], 'Koleksi Baru');
  assert.equal(readWebpExifMetadata(rebranded)['sticker-pack-publisher'], 'Kiraya');

  // !toimg mengembalikan stiker ke PNG valid
  const pngRes = await convertStickerToPng(rebranded);
  const pngMeta = await sharp(pngRes.buffer).metadata();
  assert.equal(pngMeta.format, 'png');
  assert.equal(pngMeta.width, 512);
  assert.equal(pngRes.isAnimated, false);

  // Uji juga injectWebpExif pada buffer VP8 lossy murni
  const lossyWebp = await sharp(samplePhoto).webp({ lossless: false }).toBuffer();
  const lossyWithExif = injectWebpExif(lossyWebp, { packName: 'LossyPack', author: 'Tester' });
  assert.equal(readWebpExifMetadata(lossyWithExif)['sticker-pack-name'], 'LossyPack');
});

test('CommandAntiSpamGuard enforces owner bypass, 1-warning silent drop, flood mute, and global circuit breakers', () => {
  const logs = [];
  const guard = new CommandAntiSpamGuard({
    unknownTextCooldownMs: 6000,
    unknownMaxPer10Min: 3,
    unknownMaxPerHour: 10,
    floodStrikeThreshold: 3,
    muteDurationMs: 30 * 60 * 1000,
    globalMaxPerMinute: 10,
    maxNewUnknownSendersPerHour: 2,
    addLog: (t, m) => logs.push({ t, m })
  });

  const t0 = 1_700_000_000_000;

  // 1. Pemilik (fromMe) selalu lolos tanpa jeda
  assert.deepEqual(guard.checkAccess({ senderKey: 'owner', fromMe: true, isKnown: true, nowMs: t0 }), {
    allowed: true,
    jitterMs: 0
  });

  // 2. Nomor asing pertama: perintah ke-1 lolos dengan jitter alami
  const first = guard.checkAccess({ senderKey: 'stranger-1', fromMe: false, isKnown: false, nowMs: t0 });
  assert.equal(first.allowed, true);
  assert.ok(first.jitterMs >= 1200 && first.jitterMs <= 2500);

  // Spam 1 detik kemudian -> peringatan SEKALI saja
  const warn1 = guard.checkAccess({ senderKey: 'stranger-1', fromMe: false, isKnown: false, nowMs: t0 + 1000 });
  assert.equal(warn1.allowed, false);
  assert.equal(warn1.shouldReply, true);

  // Spam 2 detik kemudian -> SILENT DROP (tidak membalas spam)
  const silent2 = guard.checkAccess({ senderKey: 'stranger-1', fromMe: false, isKnown: false, nowMs: t0 + 2000 });
  assert.equal(silent2.allowed, false);
  assert.equal(silent2.shouldReply, false);

  // Spam ke-3 dalam 1 menit -> memicu flood mute 30 menit (silent drop)
  const muted3 = guard.checkAccess({ senderKey: 'stranger-1', fromMe: false, isKnown: false, nowMs: t0 + 3000 });
  assert.equal(muted3.allowed, false);
  assert.equal(muted3.shouldReply, false);
  assert.equal(muted3.reason, 'flood_muted');

  // 10 menit kemudian masih dalam masa bisu 30 menit
  const stillMuted = guard.checkAccess({
    senderKey: 'stranger-1',
    fromMe: false,
    isKnown: false,
    nowMs: t0 + 10 * 60 * 1000
  });
  assert.equal(stillMuted.allowed, false);
  assert.equal(stillMuted.shouldReply, false);

  // 3. Batas nomor asing baru per jam (maxNewUnknownSendersPerHour = 2)
  assert.equal(
    guard.checkAccess({ senderKey: 'stranger-2', fromMe: false, isKnown: false, nowMs: t0 + 1000 }).allowed,
    true
  );
  const thirdNewStranger = guard.checkAccess({
    senderKey: 'stranger-3',
    fromMe: false,
    isKnown: false,
    nowMs: t0 + 2000
  });
  assert.equal(thirdNewStranger.allowed, false);
  assert.equal(thirdNewStranger.shouldReply, false);
  assert.equal(thirdNewStranger.reason, 'new_unknown_senders_limit');
  assert.ok(logs.length >= 2);
});

test('utilityCommands politely rejects non-image media and oversized metadata before download', async () => {
  const sent = [];
  let downloadCalled = false;
  const mockSocket = {
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `sent-${sent.length}` } };
    }
  };

  // 1. Audio (non-visual) dengan balasan .cap -> ditolak sopan tanpa memanggil download
  await handleUtilityCommands({
    waSocket: mockSocket,
    downloadMediaBuffer: async () => {
      downloadCalled = true;
      return Buffer.alloc(0);
    },
    remoteJid: '628111@s.whatsapp.net',
    senderKey: 'owner',
    fromMe: true,
    profile: { isKnown: true, name: 'Pemilik' },
    messageText: '.cap Atas | Bawah',
    msg: {
      key: { remoteJid: '628111@s.whatsapp.net', id: 'm1', fromMe: true },
      message: {
        extendedTextMessage: {
          text: '.cap Atas | Bawah',
          contextInfo: {
            stanzaId: 'orig-audio-1',
            quotedMessage: {
              audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: 1000 }
            }
          }
        }
      }
    },
    addLog: () => {}
  });
  assert.equal(downloadCalled, false);
  assert.match(sent[0].content.text, /hanya menerima foto, video, GIF, atau stiker/i);

  // 2. Foto > 5 Megabyte di metadata -> ditolak SEBELUM downloadMediaBuffer dipanggil
  await handleUtilityCommands({
    waSocket: mockSocket,
    downloadMediaBuffer: async () => {
      downloadCalled = true;
      return Buffer.alloc(0);
    },
    remoteJid: '628111@s.whatsapp.net',
    senderKey: 'owner',
    fromMe: true,
    profile: { isKnown: true, name: 'Pemilik' },
    messageText: '.s',
    msg: {
      key: { remoteJid: '628111@s.whatsapp.net', id: 'm2', fromMe: true },
      message: {
        imageMessage: {
          caption: '.s',
          mimetype: 'image/jpeg',
          fileLength: MAX_MEDIA_BYTES + 50000
        }
      }
    },
    addLog: () => {}
  });
  assert.equal(downloadCalled, false);
  assert.match(sent[1].content.text, /maksimal 5 Megabyte/i);

  // 3. extractMediaCandidate mendukung quotedMessage
  const quotedCandidate = extractMediaCandidate({
    key: { remoteJid: '628111@s.whatsapp.net', id: 'm3', fromMe: false },
    message: {
      extendedTextMessage: {
        text: '!cap SIRKEL',
        contextInfo: {
          stanzaId: 'orig-img-1',
          quotedMessage: {
            imageMessage: { mimetype: 'image/jpeg', fileLength: 20480 }
          }
        }
      }
    }
  });
  assert.equal(quotedCandidate.kind, 'image');
  assert.equal(quotedCandidate.source, 'quoted');
  assert.equal(quotedCandidate.targetMsg.key.id, 'orig-img-1');
});

test('BaileysService supports fromMe commands in private & group chats, blocks loops, and allows stranger utility commands safely', async () => {
  const sentMessages = [];
  let burstQueuedCount = 0;

  const mockSettingsStore = {
    getAll: () => ({ serviceEnabled: true, whitelistOnly: true, replyGroups: false })
  };
  const mockContextManager = {
    recordContactJid: () => {},
    getContactProfile: (jid) => ({
      phone: jid.replace(/@.*/, ''),
      name: 'Orang Baru',
      category: 'default',
      enabled: false,
      isKnown: false
    }),
    shouldReply: () => false,
    addMessage: () => {}
  };

  const service = new BaileysService({
    llm: { checkHealth: async () => ({ connected: true }), model: 'gemma-test' },
    contextManager: mockContextManager,
    knowledgeManager: {},
    toolRegistry: null,
    settingsStore: mockSettingsStore,
    addLog: () => {},
    options: {
      commandAntiSpam: new CommandAntiSpamGuard({
        knownJitterRange: [0, 0],
        unknownJitterRange: [0, 0]
      })
    }
  });

  service.waSocket = {
    user: {
      id: '6281234567890:12@s.whatsapp.net',
      lid: '999888777666@lid'
    },
    sendMessage: async (jid, content) => {
      const id = `bot-msg-${sentMessages.length + 1}`;
      sentMessages.push({ id, jid, content });
      return { key: { id } };
    },
    sendPresenceUpdate: async () => {}
  };
  service.queueBurstMessage = () => {
    burstQueuedCount++;
  };

  // 1. Pemilik (fromMe: true) mengetik !ping di GRUP (meski replyGroups: false) -> tetap diproses!
  await service.handleMessagesUpsert({
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '120363999@g.us', fromMe: true, id: 'owner-grp-1' },
        message: { conversation: '!ping' }
      }
    ]
  });
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].content.text, /Pong!/);
  assert.equal(burstQueuedCount, 0);

  // 1b. Pemilik di GRUP LID saat Baileys keliru menandai fromMe: false tetapi participantAlt cocok dengan user.id -> tetap dikenali sebagai pemilik!
  await service.handleMessagesUpsert({
    type: 'notify',
    messages: [
      {
        key: {
          remoteJid: '120363999@g.us',
          fromMe: false,
          participant: '999888777666@lid',
          participantAlt: '6281234567890@s.whatsapp.net',
          id: 'owner-grp-lid-1'
        },
        message: { conversation: '!ping' }
      }
    ]
  });
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1].content.text, /Pong!/);

  // 2. Pesan gema (echo) dengan key.id yang sudah tercatat di sentMessageIds -> diabaikan total (anti-loop)
  const botEchoId = sentMessages[0].id;
  await service.handleMessagesUpsert({
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '120363999@g.us', fromMe: true, id: botEchoId },
        message: { conversation: '!ping' }
      }
    ]
  });
  assert.equal(sentMessages.length, 2);

  // 3. Pemilik mengirim chat biasa (bukan command) -> tidak pernah masuk antrean AI
  await service.handleMessagesUpsert({
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '628999@s.whatsapp.net', fromMe: true, id: 'owner-chat-1' },
        message: { conversation: 'Halo bro lagi apa?' }
      }
    ]
  });
  assert.equal(sentMessages.length, 2);
  assert.equal(burstQueuedCount, 0);

  // 4. Lawan chat belum terdaftar di chat pribadi mengetik !pilih -> BOLEH diakses!
  await service.handleMessagesUpsert({
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '6287771234@s.whatsapp.net', fromMe: false, id: 'stranger-cmd-1' },
        message: { conversation: '!pilih Bakso | Mie Ayam' }
      }
    ]
  });
  assert.equal(sentMessages.length, 3);
  assert.match(sentMessages[2].content.text, /Pilihan jatuh ke: \*(Bakso|Mie Ayam)\*/);

  // 5. Lawan chat di GRUP saat replyGroups == false mengetik perintah utilitas !ping -> BOLEH dengan anti-spam grup,
  //    tetapi obrolan biasa di grup tetap TIDAK masuk AI auto-reply!
  await service.handleMessagesUpsert({
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '120363999@g.us', fromMe: false, participant: '628555@s.whatsapp.net', id: 'grp-stranger-1' },
        message: { conversation: '!ping' }
      }
    ]
  });
  assert.equal(sentMessages.length, 4);
  assert.match(sentMessages[3].content.text, /^Aktif \(\d+ milidetik\)\.$/);
  assert.doesNotMatch(sentMessages[3].content.text, /Bot aktif|Large Language Model|gemma/i);

  // Anggota grup lain mengetik perintah 1 detik kemudian -> kena cooldown per-grup (1 peringatan),
  // lalu anggota ketiga 1 detik kemudian -> silent drop!
  await service.handleMessagesUpsert({
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '120363999@g.us', fromMe: false, participant: '628556@s.whatsapp.net', id: 'grp-stranger-2' },
        message: { conversation: '!ping' }
      }
    ]
  });
  assert.equal(sentMessages.length, 5);
  assert.match(sentMessages[4].content.text, /grup ini/i);

  await service.handleMessagesUpsert({
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '120363999@g.us', fromMe: false, participant: '628557@s.whatsapp.net', id: 'grp-stranger-3' },
        message: { conversation: '!ping' }
      }
    ]
  });
  assert.equal(sentMessages.length, 5, 'Spam grup lanjutan harus silent drop');

  // Obrolan grup biasa tetap diabaikan oleh AI karena replyGroups == false
  await service.handleMessagesUpsert({
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '120363999@g.us', fromMe: false, participant: '628558@s.whatsapp.net', id: 'grp-chat-normal' },
        message: { conversation: 'halo semua lagi ngapain nih' }
      }
    ]
  });
  assert.equal(sentMessages.length, 5);
  assert.equal(burstQueuedCount, 0);

  // 6. Pesan pemilik (fromMe: true) berbungkus ephemeral -> deviceSentMessage pada event 'append' baru (< 60 dtk) -> HARUS DIPROSES!
  const nowSec = Math.floor(Date.now() / 1000);
  await service.handleMessagesUpsert({
    type: 'append',
    messages: [
      {
        key: { remoteJid: '628999@s.whatsapp.net', fromMe: true, id: 'owner-device-sent-1' },
        messageTimestamp: nowSec,
        message: {
          ephemeralMessage: {
            message: {
              deviceSentMessage: {
                destinationJid: '628999@s.whatsapp.net',
                message: { conversation: '\u200e!ping' }
              }
            }
          }
        }
      }
    ]
  });
  assert.equal(sentMessages.length, 6);
  assert.match(sentMessages[5].content.text, /Pong!/);

  // 7. Pesan history sync lama pada event 'append' (> 60 detik) -> HARUS DIABAIKAN!
  await service.handleMessagesUpsert({
    type: 'append',
    messages: [
      {
        key: { remoteJid: '628999@s.whatsapp.net', fromMe: true, id: 'owner-old-history-1' },
        messageTimestamp: nowSec - 3600,
        message: { conversation: '!ping' }
      }
    ]
  });
  assert.equal(sentMessages.length, 6);

  // 8. Awalan titik '.' (.cek) di grup oleh pemilik -> HARUS DIPROSES, sedangkan '...' -> DIABAIKAN!
  await service.handleMessagesUpsert({
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '120363999@g.us', fromMe: true, id: 'owner-dot-1' },
        message: { conversation: '.cek' }
      },
      {
        key: { remoteJid: '120363999@g.us', fromMe: true, id: 'owner-dots-ignored' },
        message: { conversation: '...' }
      }
    ]
  });
  assert.equal(sentMessages.length, 7);
  assert.match(sentMessages[6].content.text, /Pong!/);
});

test('createFilteredBaileysLogger suppresses noisy group/status decrypt & rollback logs and formats real errors cleanly', () => {
  const output = [];
  const logger = BaileysService.createFilteredBaileysLogger({
    level: 'error',
    rawMode: false,
    writeLine: (line) => output.push(line),
    dedupWindowMs: 60000
  });

  // 1. Noise transaksi rollback internal auth-utils -> harus dibuang
  logger.error({ error: {} }, 'transaction failed, rolling back');

  // 2. Noise dekripsi Sender Key grup (@g.us / skmsg) -> harus dibuang
  logger.error(
    {
      key: { remoteJid: '120363303694931047@g.us', fromMe: false, id: 'AC01' },
      err: new Error('No session found to decrypt message'),
      messageType: 'skmsg',
      sender: '120363303694931047@g.us',
      isSessionRecordError: false
    },
    'failed to decrypt message'
  );

  // 3. Noise status@broadcast -> harus dibuang
  logger.error(
    {
      key: { remoteJid: 'status@broadcast', fromMe: false, id: 'AC02' },
      err: new Error('No session found to decrypt message'),
      messageType: 'skmsg',
      sender: 'status@broadcast'
    },
    'failed to decrypt message'
  );

  // 4. Stream error 515 normal pasca pairing -> harus dibuang
  logger.error(
    { fullErrorNode: { tag: 'stream:error', attrs: { code: '515' } } },
    'stream errored out'
  );

  assert.equal(output.length, 0);

  // 5. Galat nyata tetap muncul dalam 1 baris rapi (bukan JSON mentah) & tidak duplikat dalam 60 detik
  logger.error({ err: new Error('Connection terminated by server') }, 'websocket error');
  logger.error({ err: new Error('Connection terminated by server') }, 'websocket error');

  assert.equal(output.length, 1);
  assert.equal(output[0], '[Baileys ERROR] websocket error - Connection terminated by server');
  assert.ok(!output[0].startsWith('{'), 'Log tidak boleh berupa dump JSON mentah');

  // 6. Child logger Baileys tetap berfungsi normal
  const child = logger.child({ class: 'baileys' });
  child.error({ err: new Error('Socket timeout') }, 'connection failed');
  assert.equal(output.length, 2);
  assert.equal(output[1], '[Baileys ERROR] connection failed - Socket timeout');
});

test('!sticker converts MP4 videos and animated GIFs into 512x512 animated WebP stickers with EXIF, rejects long videos and View Once', async () => {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-anim-test-'));
  try {
    const mp4Path = path.join(tmpDir, 'clip.mp4');
    const gifPath = path.join(tmpDir, 'anim.gif');

    execFileSync(
      'ffmpeg',
      ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1.5:size=240x180:rate=12', '-pix_fmt', 'yuv420p', mp4Path],
      { stdio: 'pipe', windowsHide: true }
    );
    execFileSync(
      'ffmpeg',
      ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1.2:size=200x200:rate=10', gifPath],
      { stdio: 'pipe', windowsHide: true }
    );

    // 1. Video MP4 / WhatsApp GIF -> stiker bergerak 512x512 WebP + EXIF (<= 500 KB)
    const mp4Buf = fs.readFileSync(mp4Path);
    const animWebp = await convertVideoOrGifToSticker(mp4Buf, {
      crop: false,
      packName: 'GerakPack',
      author: 'Fariez'
    });
    assert.equal(isValidWebpBuffer(animWebp), true);
    assert.ok(animWebp.length <= MAX_ANIMATED_STICKER_BYTES, `Stiker bergerak harus <= 500KB (got ${animWebp.length})`);
    const animMeta = await sharp(animWebp, { animated: true }).metadata();
    assert.equal(animMeta.width, 512);
    assert.equal(animMeta.pageHeight || animMeta.height, 512);
    assert.ok(animMeta.pages > 1, `Stiker harus memiliki > 1 bingkai (got ${animMeta.pages})`);
    assert.equal(readWebpExifMetadata(animWebp)['sticker-pack-name'], 'GerakPack');

    // 2. Berkas GIF asli lewat convertImageToSticker -> otomatis tetap bergerak (> 1 bingkai)
    const gifBuf = fs.readFileSync(gifPath);
    const gifWebp = await convertImageToSticker(gifBuf, {
      crop: true,
      packName: 'GifPack',
      author: 'Fariez'
    });
    const gifMeta = await sharp(gifWebp, { animated: true }).metadata();
    assert.equal(gifMeta.width, 512);
    assert.ok(gifMeta.pages > 1, 'GIF animasi harus tetap menjadi stiker bergerak');
    assert.equal(readWebpExifMetadata(gifWebp)['sticker-pack-name'], 'GifPack');

    // 3. Video berdurasi > 15 detik ditolak SEBELUM diunduh, dan View Once ditolak sopan
    const sent = [];
    let downloaded = false;
    const mockSocket = {
      sendMessage: async (jid, content) => {
        sent.push({ jid, content });
        return { key: { id: `m-${sent.length}` } };
      }
    };

    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => {
        downloaded = true;
        return mp4Buf;
      },
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '.s',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'v-long', fromMe: true },
        message: { videoMessage: { caption: '.s', mimetype: 'video/mp4', fileLength: 100000, seconds: 25 } }
      },
      addLog: () => {}
    });
    assert.equal(downloaded, false);
    assert.match(sent[0].content.text, /durasi videonya terlalu panjang/i);

    // 4. !toimg pada stiker bergerak menghasilkan media GIF WhatsApp (video MP4 + gifPlayback: true)
    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => animWebp,
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '!toimg',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'toimg-anim-1', fromMe: true },
        message: {
          extendedTextMessage: {
            text: '!toimg',
            contextInfo: {
              stanzaId: 'orig-anim-stk',
              quotedMessage: {
                stickerMessage: { mimetype: 'image/webp', fileLength: animWebp.length, isAnimated: true }
              }
            }
          }
        }
      },
      addLog: () => {}
    });
    assert.ok(Buffer.isBuffer(sent[1].content.video), 'Stiker bergerak pada !toimg harus dikirim sebagai video GIF');
    assert.equal(sent[1].content.gifPlayback, true);
    assert.equal(sent[1].content.mimetype, 'video/mp4');
    assert.equal(sent[1].content.video.subarray(4, 8).toString('ascii'), 'ftyp');

    // 5. Foto sekali lihat (View Once) ditolak sopan tanpa bypass privasi
    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => {
        downloaded = true;
        return Buffer.alloc(0);
      },
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '!s',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'vo-1', fromMe: true },
        message: {
          extendedTextMessage: {
            text: '!s',
            contextInfo: {
              stanzaId: 'orig-vo',
              quotedMessage: {
                viewOnceMessageV2: {
                  message: { imageMessage: { mimetype: 'image/jpeg', viewOnce: true } }
                }
              }
            }
          }
        }
      },
      addLog: () => {}
    });
    assert.equal(downloaded, false);
    assert.match(sent[2].content.text, /View Once/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stealth !ping/!menu for non-owner, owner fromMe !acep/!ask, quoted fromMe detection, groupStates pruning, and clean web_search tool', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const ToolRegistry = require('../src/tools/toolRegistry');
  const ContextManager = require('../src/contextManager');

  // 1. Tool web_search (dipakai agent AI, bukan !cari) tetap bersih tanpa potongan kalimat / bocor instruksi di hasil
  assert.equal(ToolRegistry.cleanSearchQueryForEncyclopedia('Siapa presiden indonesia?'), 'presiden indonesia');
  assert.equal(ToolRegistry.extractFallbackEntityQuery('suami dari Carlotta Montelli'), 'Carlotta Montelli');
  assert.equal(
    ToolRegistry.trimToCleanSentences('Kalimat pertama selesai. Kalimat kedua juga selesai. Kalimat ketiga panjang sekali sampai melewati batas', 65),
    'Kalimat pertama selesai. Kalimat kedua juga selesai.'
  );

  const registry = new ToolRegistry();
  registry.searchDuckDuckGo = async () => [];
  registry.searchWikipedia = async () => [];
  registry.searchGoogleNewsRss = async () => [];
  const emptySearch = await registry.executeWebSearch({ query: 'topik fiktif tak ada' });
  assert.equal(emptySearch.total_ditemukan, 0);
  assert.equal(emptySearch.hasil, '');

  // 2. DATA-03: non-pemilik tidak melihat nama bot, uptime, maupun nama model di !ping / !menu
  const sent = [];
  const mockSocket = {
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `stealth-${sent.length}` } };
    }
  };
  const mockLlm = { model: 'gemma-4-26b-a4b-it', checkHealth: async () => ({ connected: true }) };

  await handleUtilityCommands({
    waSocket: mockSocket,
    llm: mockLlm,
    remoteJid: '628777@s.whatsapp.net',
    senderKey: '628777',
    fromMe: false,
    profile: { isKnown: false, name: 'Asing' },
    messageText: '!ping',
    msg: { key: { remoteJid: '628777@s.whatsapp.net', id: 'p-1', fromMe: false }, message: { conversation: '!ping' } },
    addLog: () => {}
  });
  await handleUtilityCommands({
    waSocket: mockSocket,
    llm: mockLlm,
    remoteJid: '628777@s.whatsapp.net',
    senderKey: '628777',
    fromMe: false,
    profile: { isKnown: false, name: 'Asing' },
    messageText: '!menu',
    msg: { key: { remoteJid: '628777@s.whatsapp.net', id: 'm-1', fromMe: false }, message: { conversation: '!menu' } },
    addLog: () => {}
  });
  await handleUtilityCommands({
    waSocket: mockSocket,
    llm: mockLlm,
    remoteJid: '628777@s.whatsapp.net',
    senderKey: 'owner',
    fromMe: true,
    profile: { isKnown: true, name: 'Pemilik' },
    messageText: '!ping',
    msg: { key: { remoteJid: '628777@s.whatsapp.net', id: 'p-own', fromMe: true }, message: { conversation: '!ping' } },
    addLog: () => {}
  });
  assert.match(sent[0].content.text, /^Aktif \(\d+ milidetik\)\.$/);
  assert.doesNotMatch(sent[0].content.text, /gemma|Bot aktif|Another Me/i);
  assert.match(sent[1].content.text, /\*Daftar Perintah Utilitas\*/);
  assert.doesNotMatch(sent[1].content.text, /Another Me|!cari/i);
  assert.match(sent[2].content.text, /gemma-4-26b-a4b-it/);

  // 3. BUG-05: extractMediaCandidate mendeteksi fromMe: true saat membalas media milik akun bot sendiri
  const quotedOwn = extractMediaCandidate(
    {
      key: { remoteJid: '120363999@g.us', id: 'q-1', fromMe: true },
      message: {
        extendedTextMessage: {
          text: '!s',
          contextInfo: {
            stanzaId: 'own-img-id',
            participant: '6281234567890@s.whatsapp.net',
            quotedMessage: { imageMessage: { mimetype: 'image/jpeg', fileLength: 1024 } }
          }
        }
      }
    },
    null,
    { isOwnUserJid: (jid) => jid === '6281234567890@s.whatsapp.net' }
  );
  assert.equal(quotedOwn.targetMsg.key.fromMe, true);

  // 4. MEM-01: CommandAntiSpamGuard membersihkan groupStates tidak aktif > 2 jam
  const guard = new CommandAntiSpamGuard({ knownJitterRange: [0, 0], unknownJitterRange: [0, 0] });
  guard.checkAccess({
    senderKey: '628555',
    fromMe: false,
    isKnown: false,
    isGroup: true,
    groupJid: '120363old@g.us',
    nowMs: 1000
  });
  assert.equal(guard.groupStates.has('120363old@g.us'), true);
  guard.pruneOldEntries(1000 + 3 * 60 * 60 * 1000);
  assert.equal(guard.groupStates.has('120363old@g.us'), false);

  // 5. BUG-04: Pemilik dari ponsel utama (fromMe: true) bisa menjalankan !acep & !ask di ruang chat kontak terdaftar
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-owner-instant-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'persona.json'),
      JSON.stringify({ general_persona: {}, categories: { pacar: { tone: 'Hangat', few_shots: [] } } })
    );
    const cm = new ContextManager({ dataPath: tmpDir });
    cm.upsertContact('174912345678901', { name: 'Angel', category: 'pacar', enabled: false });
    const askDir = path.join(tmpDir, 'ask-queue');
    const ownSent = [];

    const service = new BaileysService({
      llm: { model: 'gemma-4-26b-a4b-it', checkHealth: async () => ({ connected: true }) },
      contextManager: cm,
      knowledgeManager: { getInjectedKnowledge: () => '' },
      toolRegistry: registry,
      settingsStore: { getAll: () => ({ serviceEnabled: true, whitelistOnly: true, replyGroups: false }) },
      addLog: () => {},
      options: { askQueueDir: askDir }
    });
    service.waSocket = {
      user: { id: '6281234567890:1@s.whatsapp.net', lid: '999888777666:1@lid' },
      sendMessage: async (jid, content) => {
        const id = `tracked-${ownSent.length + 1}`;
        ownSent.push({ jid, content, id });
        return { key: { id } };
      },
      sendPresenceUpdate: async () => {}
    };

    // Pemilik menyalakan AI untuk Angel langsung dari chat Angel via !acep on
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '174912345678901@lid', fromMe: true, id: 'own-acep-1' },
          message: { conversation: '!acep on' }
        }
      ]
    });
    assert.equal(cm.contacts['174912345678901'].enabled, true);
    assert.equal(ownSent[0].content.text, 'acep on lagi ya');
    assert.equal(service.sentMessageIds.has(ownSent[0].id), true);

    // Pemilik mengirim !ask langsung dari ruang chat terdaftar -> masuk ask-queue & dilacak di sentMessageIds
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '174912345678901@lid', fromMe: true, id: 'own-ask-1' },
          message: { conversation: '!ask jadwal besok apa?' }
        }
      ]
    });
    assert.match(ownSent[1].content.text, /teruskan pertanyaanmu ke Kiraya/i);
    assert.equal(service.sentMessageIds.has(ownSent[1].id), true);
    const queuedFiles = fs.readdirSync(askDir).filter((f) => f.endsWith('.json'));
    assert.equal(queuedFiles.length, 1);

    // Pemilik mengetik !acep di chat kontak tak terdaftar -> tetap ditolak sopan
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628999888777@s.whatsapp.net', fromMe: true, id: 'own-acep-unknown' },
          message: { conversation: '!acep status' }
        }
      ]
    });
    assert.match(ownSent[2].content.text, /hanya berlaku di ruang chat kontak terdaftar/i);
    assert.equal(fs.readdirSync(askDir).filter((f) => f.endsWith('.json')).length, 1);

    // Pemilik mengetik !ask di chat kontak tak terdaftar -> tetap diterima karena !ask khusus fromMe berlaku di semua ruang obrolan
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628999888777@s.whatsapp.net', fromMe: true, id: 'own-ask-unknown' },
          message: { conversation: '!ask tes orang asing' }
        }
      ]
    });
    assert.match(ownSent[3].content.text, /teruskan pertanyaanmu ke Kiraya/i);
    assert.equal(fs.readdirSync(askDir).filter((f) => f.endsWith('.json')).length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('!cap supports CAP_BLUR_MODE (after vs before), separate CAP_TEXT_BLUR_SIGMA, CAP_MAX_DIM downscaling, and static & animated WebP stickers', async () => {
  const prevEnvMode = process.env.CAP_BLUR_MODE;
  const prevEnvTextBlur = process.env.CAP_TEXT_BLUR_SIGMA;
  const prevEnvMaxDim = process.env.CAP_MAX_DIM;
  try {
    // 1. Resolusi CAP_BLUR_MODE, CAP_TEXT_BLUR_SIGMA, & CAP_MAX_DIM dari variabel environment
    delete process.env.CAP_BLUR_MODE;
    delete process.env.CAP_TEXT_BLUR_SIGMA;
    delete process.env.CAP_MAX_DIM;
    assert.equal(resolveCapBlurMode(), 'after');
    assert.equal(resolveCapTextBlurSigma(), 1.0);
    assert.equal(resolveCapMaxDim(), 640);
    const defaultDeg = computeCapDegradeParams(2.8);
    const heavyDeg = computeCapDegradeParams(6.0);
    assert.ok(heavyDeg.scaleRatio < defaultDeg.scaleRatio, 'Intensitas burik lebih tinggi harus memperkecil scaleRatio');
    assert.ok(heavyDeg.crushQuality < defaultDeg.crushQuality, 'Intensitas burik lebih tinggi harus menurunkan kualitas JPEG');
    process.env.CAP_BLUR_MODE = 'before';
    assert.equal(resolveCapBlurMode(), 'before');
    process.env.CAP_BLUR_MODE = '  AFTER ';
    assert.equal(resolveCapBlurMode(), 'after');
    process.env.CAP_BLUR_MODE = 'mode-tidak-dikenal';
    assert.equal(resolveCapBlurMode(), 'after');

    process.env.CAP_TEXT_BLUR_SIGMA = '0';
    assert.equal(resolveCapTextBlurSigma(), 0);
    process.env.CAP_TEXT_BLUR_SIGMA = '0.2';
    assert.equal(resolveCapTextBlurSigma(), 0);
    process.env.CAP_TEXT_BLUR_SIGMA = '1.4';
    assert.equal(resolveCapTextBlurSigma(), 1.4);
    process.env.CAP_TEXT_BLUR_SIGMA = '9.5';
    assert.equal(resolveCapTextBlurSigma(), 4.0);
    delete process.env.CAP_TEXT_BLUR_SIGMA;

    process.env.CAP_MAX_DIM = '420';
    assert.equal(resolveCapMaxDim(), 420);
    process.env.CAP_MAX_DIM = '100';
    assert.equal(resolveCapMaxDim(), 240);
    process.env.CAP_MAX_DIM = '4000';
    assert.equal(resolveCapMaxDim(), 1080);
    delete process.env.CAP_MAX_DIM;

    // 1b. Foto jernih beresolusi tinggi 1200x900 otomatis dinormalkan ke 640x480 (atau 420x315 saat CAP_MAX_DIM=420)
    const hdPhoto = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: { r: 90, g: 120, b: 150 } }
    })
      .jpeg({ quality: 92 })
      .toBuffer();
    const hdDefaultOut = await renderCapMeme(hdPhoto, { bottomText: 'BUREM', blurMode: 'before', blurSigma: 2.8 });
    const hdDefaultMeta = await sharp(hdDefaultOut).metadata();
    assert.equal(hdDefaultMeta.width, 640);
    assert.equal(hdDefaultMeta.height, 480);

    process.env.CAP_MAX_DIM = '420';
    const hdLowerOut = await renderCapMeme(hdPhoto, { bottomText: 'BUREM', blurMode: 'before', blurSigma: 2.8 });
    const hdLowerMeta = await sharp(hdLowerOut).metadata();
    assert.equal(hdLowerMeta.width, 420);
    assert.equal(hdLowerMeta.height, 315);
    delete process.env.CAP_MAX_DIM;

    // Argumen !cap tidak punya flag mode baru: "before halo" tetap diperlakukan sebagai teks caption murni
    assert.deepEqual(parseCapArgs('before halo'), { topText: '', bottomText: 'before halo' });

    // 2. Uji foto: mode before teks tajam (0), mode before teks buram tipis (1.0 bawaan), vs mode after (3.0)
    const width = 640;
    const height = 640;
    const rawPhoto = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        const val = x < width / 2 ? 15 : 240;
        rawPhoto[idx] = val;
        rawPhoto[idx + 1] = val;
        rawPhoto[idx + 2] = val;
      }
    }
    const sharpPhoto = await sharp(rawPhoto, { raw: { width, height, channels: 3 } }).png().toBuffer();

    process.env.CAP_BLUR_MODE = 'before';
    process.env.CAP_TEXT_BLUR_SIGMA = '0';
    const beforePhotoSharp = await renderCapMeme(sharpPhoto, {
      topText: 'Satu',
      bottomText: 'SIRKEL',
      blurSigma: 3.0,
      returnStages: true
    });
    assert.equal(beforePhotoSharp.blurMode, 'before');
    assert.equal(beforePhotoSharp.textBlurSigma, 0);
    assert.ok(Buffer.isBuffer(beforePhotoSharp.blurredBaseBuffer));

    delete process.env.CAP_TEXT_BLUR_SIGMA; // kembali ke bawaan 1.0
    const beforePhotoSoft = await renderCapMeme(sharpPhoto, {
      topText: 'Satu',
      bottomText: 'SIRKEL',
      blurSigma: 3.0,
      returnStages: true
    });
    assert.equal(beforePhotoSoft.blurMode, 'before');
    assert.equal(beforePhotoSoft.textBlurSigma, 1.0);

    process.env.CAP_BLUR_MODE = 'after';
    process.env.CAP_TEXT_BLUR_SIGMA = '1.5'; // harus diabaikan saat mode after
    const afterPhoto = await renderCapMeme(sharpPhoto, {
      topText: 'Satu',
      bottomText: 'SIRKEL',
      blurSigma: 3.0,
      returnStages: true
    });
    assert.equal(afterPhoto.blurMode, 'after');
    assert.equal(afterPhoto.textBlurSigma, 0);
    delete process.env.CAP_TEXT_BLUR_SIGMA;

    // Verifikasi urutan matematis ketajaman teks: before(0) > before(1.0) > after(3.0)
    const beforePhotoMidEdge = await measureMaxHorizontalEdgeStep(beforePhotoSoft.finalBuffer, 0.5);
    const beforeSharpTextEdge = await measureMaxHorizontalEdgeStep(beforePhotoSharp.finalBuffer, 0.9);
    const beforeSoftTextEdge = await measureMaxHorizontalEdgeStep(beforePhotoSoft.finalBuffer, 0.9);
    const afterPhotoTextEdge = await measureMaxHorizontalEdgeStep(afterPhoto.finalBuffer, 0.9);
    assert.ok(beforePhotoMidEdge < 100, `Latar foto pada mode before harus blur (got ${beforePhotoMidEdge})`);
    assert.ok(beforeSharpTextEdge > 170, `Teks pada mode before dengan sigma teks 0 harus tajam (got ${beforeSharpTextEdge})`);
    assert.ok(
      beforeSoftTextEdge < beforeSharpTextEdge * 0.78,
      `Teks pada mode before dengan sigma 1.0 harus lebih lembut dibanding sigma 0 (${beforeSoftTextEdge} vs ${beforeSharpTextEdge})`
    );
    assert.ok(
      beforeSoftTextEdge > afterPhotoTextEdge * 1.4,
      `Teks pada mode before dengan sigma 1.0 harus tetap lebih tajam dibanding mode after (${beforeSoftTextEdge} vs ${afterPhotoTextEdge})`
    );

    // 3. Stiker diam WebP berlatar transparan -> tetap jadi stiker WebP 512x512 + EXIF + alpha terjaga
    const stkSize = 512;
    const staticRaw = Buffer.alloc(stkSize * stkSize * 4);
    for (let y = 60; y < 452; y++) {
      for (let x = 60; x < 452; x++) {
        const o = (y * stkSize + x) * 4;
        const val = x < stkSize / 2 ? 20 : 235;
        staticRaw[o] = val;
        staticRaw[o + 1] = val;
        staticRaw[o + 2] = val;
        staticRaw[o + 3] = 255;
      }
    }
    const staticStickerIn = await sharp(staticRaw, { raw: { width: stkSize, height: stkSize, channels: 4 } })
      .webp({ quality: 85 })
      .toBuffer();

    process.env.CAP_BLUR_MODE = 'before';
    process.env.CAP_TEXT_BLUR_SIGMA = '0';
    const staticCapBeforeSharp = await renderCapSticker(staticStickerIn, {
      topText: 'STIKER',
      bottomText: 'SIRKEL',
      blurSigma: 3.0,
      packName: 'CapPack',
      author: 'Fariez',
      returnStages: true
    });
    delete process.env.CAP_TEXT_BLUR_SIGMA;
    const staticCapBeforeSoft = await renderCapSticker(staticStickerIn, {
      topText: 'STIKER',
      bottomText: 'SIRKEL',
      blurSigma: 3.0,
      packName: 'CapPack',
      author: 'Fariez',
      returnStages: true
    });
    assert.equal(staticCapBeforeSoft.isAnimated, false);
    assert.equal(staticCapBeforeSoft.blurMode, 'before');
    assert.equal(staticCapBeforeSoft.textBlurSigma, 1.0);
    assert.equal(isValidWebpBuffer(staticCapBeforeSoft.finalBuffer), true);
    const staticBeforeMeta = await sharp(staticCapBeforeSoft.finalBuffer).metadata();
    assert.equal(staticBeforeMeta.width, 512);
    assert.equal(staticBeforeMeta.height, 512);
    assert.equal(staticBeforeMeta.hasAlpha, true);
    assert.equal(readWebpExifMetadata(staticCapBeforeSoft.finalBuffer)['sticker-pack-name'], 'CapPack');

    process.env.CAP_BLUR_MODE = 'after';
    const staticCapAfter = await renderCapSticker(staticStickerIn, {
      topText: 'STIKER',
      bottomText: 'SIRKEL',
      blurSigma: 3.0,
      packName: 'CapPack',
      author: 'Fariez',
      returnStages: true
    });
    assert.equal(staticCapAfter.blurMode, 'after');
    assert.equal(staticCapAfter.textBlurSigma, 0);

    const stkBeforeSharpEdge = await measureMaxHorizontalEdgeStep(staticCapBeforeSharp.finalBuffer, 0.9);
    const stkBeforeSoftEdge = await measureMaxHorizontalEdgeStep(staticCapBeforeSoft.finalBuffer, 0.9);
    const stkAfterTextEdge = await measureMaxHorizontalEdgeStep(staticCapAfter.finalBuffer, 0.9);
    assert.ok(stkBeforeSharpEdge > 170, `Teks stiker mode before sigma 0 harus tajam (got ${stkBeforeSharpEdge})`);
    assert.ok(
      stkBeforeSoftEdge < stkBeforeSharpEdge * 0.78,
      `Teks stiker mode before sigma 1.0 harus agak blur (${stkBeforeSoftEdge} vs ${stkBeforeSharpEdge})`
    );
    assert.ok(
      stkBeforeSoftEdge > stkAfterTextEdge * 1.4,
      `Teks stiker mode before sigma 1.0 harus lebih tajam dari mode after (${stkBeforeSoftEdge} vs ${stkAfterTextEdge})`
    );

    // 4. Stiker bergerak WebP -> tetap jadi stiker bergerak 512x512 <= 500 KB + EXIF + delay terjaga
    const frames = 6;
    const animRaw = Buffer.alloc(stkSize * stkSize * frames * 4);
    for (let f = 0; f < frames; f++) {
      const shiftX = f * 18;
      for (let y = 110; y < 370; y++) {
        for (let x = 90 + shiftX; x < 290 + shiftX; x++) {
          const o = (f * stkSize * stkSize + y * stkSize + x) * 4;
          const val = x < 190 + shiftX ? 25 : 235;
          animRaw[o] = val;
          animRaw[o + 1] = val;
          animRaw[o + 2] = 180;
          animRaw[o + 3] = 255;
        }
      }
    }
    const animDelays = [80, 80, 90, 90, 100, 100];
    const animStickerIn = await sharp(animRaw, {
      raw: { width: stkSize, height: stkSize * frames, channels: 4, pageHeight: stkSize }
    })
      .webp({ quality: 80, loop: 0, delay: animDelays })
      .toBuffer();

    process.env.CAP_BLUR_MODE = 'before';
    const animCapBefore = await renderCapSticker(animStickerIn, {
      bottomText: 'GERAK',
      blurSigma: 3.0,
      packName: 'AnimCap',
      author: 'Fariez'
    });
    assert.equal(isValidWebpBuffer(animCapBefore), true);
    assert.ok(animCapBefore.length <= MAX_ANIMATED_STICKER_BYTES, `Stiker !cap bergerak harus <= 500KB (got ${animCapBefore.length})`);
    const animBeforeMeta = await sharp(animCapBefore, { animated: true }).metadata();
    assert.equal(animBeforeMeta.width, 512);
    assert.equal(animBeforeMeta.pageHeight || animBeforeMeta.height, 512);
    assert.equal(animBeforeMeta.pages, frames);
    assert.deepEqual(animBeforeMeta.delay, animDelays);
    assert.equal(animBeforeMeta.hasAlpha, true);
    assert.equal(readWebpExifMetadata(animCapBefore)['sticker-pack-name'], 'AnimCap');

    process.env.CAP_BLUR_MODE = 'after';
    const animCapAfter = await renderCapSticker(animStickerIn, {
      bottomText: 'GERAK',
      blurSigma: 3.0,
      packName: 'AnimCap',
      author: 'Fariez'
    });
    assert.equal(isValidWebpBuffer(animCapAfter), true);
    assert.ok(animCapAfter.length <= MAX_ANIMATED_STICKER_BYTES);
    const animAfterMeta = await sharp(animCapAfter, { animated: true }).metadata();
    assert.equal(animAfterMeta.pages, frames);

    // Bandingkan ketajaman teks pada bingkai 0 antara mode before (blur teks tipis 1.0) dan after (3.0)
    const frame0BeforePng = await sharp(animCapBefore, { page: 0 }).png().toBuffer();
    const frame0AfterPng = await sharp(animCapAfter, { page: 0 }).png().toBuffer();
    const animBeforeTextEdge = await measureMaxHorizontalEdgeStep(frame0BeforePng, 0.9);
    const animAfterTextEdge = await measureMaxHorizontalEdgeStep(frame0AfterPng, 0.9);
    assert.ok(
      animBeforeTextEdge > animAfterTextEdge * 1.4,
      `Bingkai 0 stiker bergerak mode before (teks blur tipis) harus lebih tajam dari mode after (${animBeforeTextEdge} vs ${animAfterTextEdge})`
    );

    // Uji helper subsampleFrames mempertahankan total durasi & minimal 2 bingkai
    const sub = subsampleFrames(['f0', 'f1', 'f2', 'f3', 'f4'], [60, 60, 60, 60, 60], 2);
    assert.equal(sub.frames.length, 3);
    assert.deepEqual(sub.delays, [120, 120, 60]);
    const subSmall = subsampleFrames(['f0', 'f1', 'f2'], [100, 100, 100], 3);
    assert.equal(subSmall.frames.length, 2);
    assert.deepEqual(subSmall.delays, [200, 100]);

    // 5. Uji end-to-end handleUtilityCommands: balas stiker diam & stiker bergerak dengan !cap / .burem
    const sent = [];
    const mockSocket = {
      sendMessage: async (jid, content) => {
        sent.push({ jid, content });
        return { key: { id: `cap-stk-${sent.length}` } };
      }
    };

    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => staticStickerIn,
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '!cap Satu | SIRKEL',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'cap-static-cmd', fromMe: true },
        message: {
          extendedTextMessage: {
            text: '!cap Satu | SIRKEL',
            contextInfo: {
              stanzaId: 'orig-static-stk',
              quotedMessage: { stickerMessage: { mimetype: 'image/webp', fileLength: staticStickerIn.length } }
            }
          }
        }
      },
      addLog: () => {}
    });
    assert.ok(Buffer.isBuffer(sent[0].content.sticker), 'Balasan !cap pada stiker diam harus berupa stiker');
    assert.equal(isValidWebpBuffer(sent[0].content.sticker), true);

    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => animStickerIn,
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '.burem GAS',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'cap-anim-cmd', fromMe: true },
        message: {
          extendedTextMessage: {
            text: '.burem GAS',
            contextInfo: {
              stanzaId: 'orig-anim-stk',
              quotedMessage: {
                stickerMessage: { mimetype: 'image/webp', fileLength: animStickerIn.length, isAnimated: true }
              }
            }
          }
        }
      },
      addLog: () => {}
    });
    assert.ok(Buffer.isBuffer(sent[1].content.sticker), 'Balasan .burem pada stiker bergerak harus berupa stiker');
    const sentAnimMeta = await sharp(sent[1].content.sticker, { animated: true }).metadata();
    assert.ok(sentAnimMeta.pages > 1, 'Stiker bergerak hasil !cap harus tetap bergerak');
  } finally {
    if (prevEnvMode === undefined) {
      delete process.env.CAP_BLUR_MODE;
    } else {
      process.env.CAP_BLUR_MODE = prevEnvMode;
    }
    if (prevEnvTextBlur === undefined) {
      delete process.env.CAP_TEXT_BLUR_SIGMA;
    } else {
      process.env.CAP_TEXT_BLUR_SIGMA = prevEnvTextBlur;
    }
    if (prevEnvMaxDim === undefined) {
      delete process.env.CAP_MAX_DIM;
    } else {
      process.env.CAP_MAX_DIM = prevEnvMaxDim;
    }
  }
});

test('!crop crops images, videos (preserving audio), and GIFs to 1:1 square and guards invalid inputs', async () => {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-crop-test-'));
  try {
    // 1. Gambar lanskap 600x300 (kiri/kanan merah, tengah 300x300 hijau) -> kotak 300x300 hijau murni
    const imgW = 600;
    const imgH = 300;
    const rawImg = Buffer.alloc(imgW * imgH * 3);
    for (let y = 0; y < imgH; y++) {
      for (let x = 0; x < imgW; x++) {
        const idx = (y * imgW + x) * 3;
        const inCenter = x >= 150 && x < 450;
        rawImg[idx] = inCenter ? 20 : 230;
        rawImg[idx + 1] = inCenter ? 210 : 20;
        rawImg[idx + 2] = 30;
      }
    }
    const landscapeJpg = await sharp(rawImg, { raw: { width: imgW, height: imgH, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    const croppedImg = await cropImageToSquare(landscapeJpg);
    assert.equal(croppedImg.kind, 'image');
    assert.equal(croppedImg.mimeType, 'image/jpeg');
    const croppedImgMeta = await sharp(croppedImg.buffer).metadata();
    assert.equal(croppedImgMeta.width, 300);
    assert.equal(croppedImgMeta.height, 300);
    // Piksel di dekat tepi dalam (10,10) dan (289,289) hasil crop harus hijau murni (bukan merah sisi luar)
    const { data: croppedPx, info: croppedInfo } = await sharp(croppedImg.buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tlIdx = (10 * croppedInfo.width + 10) * croppedInfo.channels;
    const brIdx = (289 * croppedInfo.width + 289) * croppedInfo.channels;
    assert.ok(
      croppedPx[tlIdx + 1] > 180 && croppedPx[tlIdx] < 60,
      'Potongan 1:1 sisi kiri-atas harus tepat mengambil bagian tengah gambar'
    );
    assert.ok(
      croppedPx[brIdx + 1] > 180 && croppedPx[brIdx] < 60,
      'Potongan 1:1 sisi kanan-bawah harus tepat mengambil bagian tengah gambar'
    );

    // 2. Gambar PNG transparan potret 240x480 -> kotak 240x240 PNG dengan alpha terjaga
    const alphaPng = await sharp({
      create: { width: 240, height: 480, channels: 4, background: { r: 40, g: 120, b: 220, alpha: 0.5 } }
    })
      .png()
      .toBuffer();
    const croppedPng = await cropImageToSquare(alphaPng);
    assert.equal(croppedPng.mimeType, 'image/png');
    const croppedPngMeta = await sharp(croppedPng.buffer).metadata();
    assert.equal(croppedPngMeta.width, 240);
    assert.equal(croppedPngMeta.height, 240);
    assert.equal(croppedPngMeta.hasAlpha, true);

    // 3. Video MP4 320x180 DENGAN audio -> kotak 180x180 MP4 DENGAN trek audio tetap utuh
    const inMp4Path = path.join(tmpDir, 'sample.mp4');
    const inGifPath = path.join(tmpDir, 'sample.gif');
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1.2:size=320x180:rate=15',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1.2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        inMp4Path
      ],
      { stdio: 'pipe', windowsHide: true }
    );
    execFileSync(
      'ffmpeg',
      ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1.0:size=240x150:rate=10', inGifPath],
      { stdio: 'pipe', windowsHide: true }
    );

    const mp4Buf = fs.readFileSync(inMp4Path);
    const gifBuf = fs.readFileSync(inGifPath);

    const probeBuffer = (buf, name) => {
      const p = path.join(tmpDir, name);
      fs.writeFileSync(p, buf);
      const out = execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', p],
        { encoding: 'utf8', windowsHide: true }
      );
      return JSON.parse(out).streams;
    };

    const croppedVideo = await cropVideoOrGifToSquare(mp4Buf, { asGif: false });
    assert.equal(croppedVideo.kind, 'video');
    const videoStreams = probeBuffer(croppedVideo.buffer, 'out_video.mp4');
    const vStream = videoStreams.find((s) => s.codec_type === 'video');
    const aStream = videoStreams.find((s) => s.codec_type === 'audio');
    assert.equal(vStream.width, 180);
    assert.equal(vStream.height, 180);
    assert.ok(aStream, 'Audio video biasa harus tetap dipertahankan setelah !crop');

    // 4. GIF animasi 240x150 (lewat cropImageToSquare maupun cropVideoOrGifToSquare) -> MP4 GIF 150x150 tanpa audio
    const croppedGif = await cropImageToSquare(gifBuf);
    assert.equal(croppedGif.kind, 'gif');
    const gifStreams = probeBuffer(croppedGif.buffer, 'out_gif.mp4');
    assert.equal(gifStreams.length, 1);
    assert.equal(gifStreams[0].codec_type, 'video');
    assert.equal(gifStreams[0].width, 150);
    assert.equal(gifStreams[0].height, 150);

    // 5. Uji end-to-end handleUtilityCommands untuk !crop (foto, video, WhatsApp GIF, durasi panjang, View Once, stiker)
    const sent = [];
    let unexpectedDownload = false;
    const mockSocket = {
      sendMessage: async (jid, content) => {
        sent.push({ jid, content });
        return { key: { id: `crop-msg-${sent.length}` } };
      }
    };

    // 5a. Foto biasa -> { image }
    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => landscapeJpg,
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '!crop',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'c-img', fromMe: true },
        message: { imageMessage: { caption: '!crop', mimetype: 'image/jpeg', fileLength: landscapeJpg.length } }
      },
      addLog: () => {}
    });
    assert.ok(Buffer.isBuffer(sent[0].content.image));

    // 5b. Video biasa -> { video, mimetype: 'video/mp4' } tanpa gifPlayback
    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => mp4Buf,
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '.potong',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'c-vid', fromMe: true },
        message: { videoMessage: { caption: '.potong', mimetype: 'video/mp4', fileLength: mp4Buf.length, seconds: 2 } }
      },
      addLog: () => {}
    });
    assert.ok(Buffer.isBuffer(sent[1].content.video));
    assert.equal(sent[1].content.gifPlayback, undefined);

    // 5c. WhatsApp GIF (videoMessage dengan gifPlayback: true) -> { video, gifPlayback: true }
    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => mp4Buf,
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '!square',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'c-gif', fromMe: true },
        message: {
          videoMessage: {
            caption: '!square',
            mimetype: 'video/mp4',
            fileLength: mp4Buf.length,
            seconds: 2,
            gifPlayback: true
          }
        }
      },
      addLog: () => {}
    });
    assert.ok(Buffer.isBuffer(sent[2].content.video));
    assert.equal(sent[2].content.gifPlayback, true);

    // 5d. Video > 60 detik ditolak SEBELUM diunduh
    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => {
        unexpectedDownload = true;
        return Buffer.alloc(0);
      },
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '!crop',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'c-long', fromMe: true },
        message: { videoMessage: { caption: '!crop', mimetype: 'video/mp4', fileLength: 100000, seconds: 90 } }
      },
      addLog: () => {}
    });
    assert.equal(unexpectedDownload, false);
    assert.match(sent[3].content.text, /durasi videonya terlalu panjang/i);

    // 5e. Foto sekali lihat (View Once) ditolak sopan SEBELUM diunduh
    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => {
        unexpectedDownload = true;
        return Buffer.alloc(0);
      },
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '!crop',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'c-vo', fromMe: true },
        message: {
          viewOnceMessageV2: {
            message: { imageMessage: { caption: '!crop', mimetype: 'image/jpeg', viewOnce: true } }
          }
        }
      },
      addLog: () => {}
    });
    assert.equal(unexpectedDownload, false);
    assert.match(sent[4].content.text, /View Once/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('!cap renders full-color emojis cleanly alongside Impact text in before/after modes, caches SVGs, and degrades gracefully offline', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  // 1. Deteksi emoji akurat: angka ASCII 0-9 / '#' / '*' BUKAN emoji, sedangkan ZWJ/bendera/keycap terdeteksi
  assert.equal(isEmojiGrapheme('5'), false);
  assert.equal(isEmojiGrapheme('#'), false);
  assert.equal(isEmojiGrapheme('A'), false);
  assert.equal(isEmojiGrapheme('😹'), true);
  assert.equal(isEmojiGrapheme('❤️‍🔥'), true);
  assert.equal(isEmojiGrapheme('🇮🇩'), true);
  assert.equal(isEmojiGrapheme('1️⃣'), true);

  assert.deepEqual(emojiToTwemojiCandidates('😹'), ['1f639']);
  assert.deepEqual(emojiToTwemojiCandidates('❤️'), ['2764', '2764-fe0f']);
  assert.deepEqual(emojiToTwemojiCandidates('❤️‍🔥'), ['2764-fe0f-200d-1f525', '2764-200d-1f525']);
  assert.deepEqual(emojiToTwemojiCandidates('1️⃣'), ['31-20e3', '31-fe0f-20e3']);

  const runs = splitLineIntoRuns('HALO 123😹 🔥');
  assert.deepEqual(
    runs.map((r) => [r.type, r.value]),
    [
      ['text', 'HALO 123'],
      ['emoji', '😹'],
      ['text', ' '],
      ['emoji', '🔥']
    ]
  );

  // 2. Render penuh warna memakai mock SVG berwarna kuning/biru di atas foto abu-abu murni (100% offline deterministik)
  const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-emoji-test-'));
  const mockCatSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">' +
      '<circle cx="18" cy="18" r="16" fill="#FFCC4D"/>' +
      '<circle cx="10" cy="24" r="5" fill="#5DADEC"/>' +
      '<circle cx="26" cy="24" r="5" fill="#5DADEC"/>' +
      '<circle cx="18" cy="21" r="4" fill="#EA596E"/>' +
      '</svg>',
    'utf-8'
  );

  let fetchCalls = 0;
  const mockFetch = async () => {
    fetchCalls++;
    return {
      ok: true,
      arrayBuffer: async () => mockCatSvg
    };
  };

  try {
    clearEmojiMemoryCache();

    // Foto abu-abu polos (R=G=B=145): satu-satunya sumber piksel berwarna tinggi hanyalah emoji berwarna!
    const grayPhoto = await sharp({
      create: { width: 512, height: 512, channels: 3, background: { r: 145, g: 145, b: 145 } }
    })
      .png()
      .toBuffer();

    const countColoredPixels = async (buf) => {
      const { data, info } = await sharp(buf).flatten({ background: '#919191' }).raw().toBuffer({ resolveWithObject: true });
      let colored = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        const spread = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
        if (spread > 50) colored++;
      }
      return colored;
    };

    const beforeOut = await renderCapMeme(grayPhoto, {
      topText: 'KENAPA?',
      bottomText: 'HALO BRO😹',
      blurMode: 'before',
      blurSigma: 2.8,
      textBlurSigma: 1.0,
      emojiOptions: { cacheDir: tmpCache, fetchImpl: mockFetch, useMemoryCache: false }
    });
    assert.equal(fetchCalls, 1, 'Fetch jaringan hanya sekali karena hasil disimpan ke cache disk');
    assert.equal(fs.existsSync(path.join(tmpCache, '1f639.svg')), true, 'Berkas SVG emoji harus tersimpan di cache disk');
    assert.ok((await countColoredPixels(beforeOut)) > 1500, 'Emoji pada !cap mode before harus tampil berwarna penuh');

    // Panggilan kedua pada stiker dengan mode after harus membaca langsung dari cache disk (0 fetch tambahan)
    const graySticker = await sharp({
      create: { width: 512, height: 512, channels: 4, background: { r: 145, g: 145, b: 145, alpha: 255 } }
    })
      .webp({ quality: 85 })
      .toBuffer();

    const stickerOut = await renderCapSticker(graySticker, {
      bottomText: 'MANTAP😹',
      blurMode: 'after',
      blurSigma: 2.8,
      emojiOptions: { cacheDir: tmpCache, fetchImpl: mockFetch, useMemoryCache: false }
    });
    assert.equal(fetchCalls, 1, 'Panggilan kedua harus memakai cache disk tanpa unduh ulang');
    assert.equal(isValidWebpBuffer(stickerOut), true);
    assert.ok((await countColoredPixels(stickerOut)) > 1500, 'Emoji pada !cap stiker mode after harus tetap berwarna penuh');

    // 3. Fallback aman saat offline total dan emoji belum ada di cache (tidak boleh error)
    const offlineCache = path.join(tmpCache, 'empty-offline');
    const offlineFetch = async () => {
      throw new Error('network down');
    };
    const missingBuf = await fetchEmojiSvgBuffer(['1f525'], {
      cacheDir: offlineCache,
      fetchImpl: offlineFetch,
      useMemoryCache: false
    });
    assert.equal(missingBuf, null);

    const offlineOut = await renderCapMeme(grayPhoto, {
      bottomText: 'OFFLINE 🔥',
      blurMode: 'before',
      maxDim: 512,
      emojiOptions: { cacheDir: offlineCache, fetchImpl: offlineFetch, useMemoryCache: false }
    });
    const offlineMeta = await sharp(offlineOut).metadata();
    assert.equal(offlineMeta.format, 'jpeg');
    assert.equal(offlineMeta.width, 512);
  } finally {
    clearEmojiMemoryCache();
    fs.rmSync(tmpCache, { recursive: true, force: true });
  }
});

test('!cap supports videos (preserving audio) and GIFs with after/before modes, duration guard, and View Once block', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');

  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
  } catch {
    t.skip('FFmpeg tidak terpasang di lingkungan pengujian ini');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-capvid-test-'));
  try {
    // Buat video MP4 640x480 berdurasi 1 detik dengan tepi tajam kiri-gelap/kanan-terang + trek audio
    const sampleMp4Path = path.join(tmpDir, 'sample.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=#183050:s=640x480:d=1:r=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-vf',
        'drawbox=x=320:y=0:w=320:h=480:color=#dce8f5:t=fill',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        sampleMp4Path
      ],
      { stdio: 'ignore', windowsHide: true }
    );
    const mp4Buf = fs.readFileSync(sampleMp4Path);

    // Buat berkas GIF animasi 320x240 berdurasi 1 detik
    const sampleGifPath = path.join(tmpDir, 'sample.gif');
    execFileSync(
      'ffmpeg',
      ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=8', sampleGifPath],
      { stdio: 'ignore', windowsHide: true }
    );
    const gifBuf = fs.readFileSync(sampleGifPath);

    const probeStreams = (buf, name) => {
      const p = path.join(tmpDir, name);
      fs.writeFileSync(p, buf);
      const out = execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', p],
        { encoding: 'utf8', windowsHide: true }
      );
      return JSON.parse(out).streams;
    };

    const extractFramePng = (buf, name) => {
      const mp4p = path.join(tmpDir, `${name}.mp4`);
      const pngp = path.join(tmpDir, `${name}.png`);
      fs.writeFileSync(mp4p, buf);
      execFileSync('ffmpeg', ['-y', '-i', mp4p, '-frames:v', '1', pngp], {
        stdio: 'ignore',
        windowsHide: true
      });
      return fs.readFileSync(pngp);
    };

    // 1. Mode 'after' pada video biasa: mempertahankan audio, dimensi 640x480, teks terpasang dan ikut burik
    const afterRes = await renderCapVideoOrGif(mp4Buf, {
      topText: 'ATAS',
      bottomText: 'BAWAH',
      asGif: false,
      blurMode: 'after',
      blurSigma: 3.5,
      maxDim: 640,
      fontScale: 1.0
    });
    assert.equal(afterRes.kind, 'video');
    assert.equal(afterRes.width, 640);
    assert.equal(afterRes.height, 480);
    const afterStreams = probeStreams(afterRes.buffer, 'cap_after.mp4');
    assert.equal(afterStreams.find((s) => s.codec_type === 'video')?.width, 640);
    assert.equal(afterStreams.find((s) => s.codec_type === 'video')?.height, 480);
    assert.ok(afterStreams.find((s) => s.codec_type === 'audio'), 'Audio video harus tetap dipertahankan pada !cap video');

    // 2. Mode 'before' (textBlurSigma: 0): latar burik, tepi teks jauh lebih tajam daripada mode 'after'
    const beforeRes = await renderCapVideoOrGif(mp4Buf, {
      topText: 'ATAS',
      bottomText: 'BAWAH',
      asGif: false,
      blurMode: 'before',
      blurSigma: 3.5,
      textBlurSigma: 0,
      maxDim: 640,
      fontScale: 1.0
    });
    const afterFrame = extractFramePng(afterRes.buffer, 'after_f0');
    const beforeFrame = extractFramePng(beforeRes.buffer, 'before_f0');
    const afterTextEdge = await measureMaxHorizontalEdgeStep(afterFrame, 0.9);
    const beforeTextEdge = await measureMaxHorizontalEdgeStep(beforeFrame, 0.9);
    assert.ok(afterTextEdge > 60, `Teks harus terlihat pada bingkai video mode after (got ${afterTextEdge})`);
    assert.ok(
      beforeTextEdge > afterTextEdge,
      `Tepi teks video mode before (textBlurSigma=0) harus lebih tajam dari mode after (${beforeTextEdge} vs ${afterTextEdge})`
    );

    // 3. GIF animasi -> keluaran MP4 GIF tanpa audio
    const gifRes = await renderCapVideoOrGif(gifBuf, {
      bottomText: 'MANTAP',
      asGif: true,
      blurMode: 'after',
      blurSigma: 2.5,
      maxDim: 512,
      fontScale: 1.0
    });
    assert.equal(gifRes.kind, 'gif');
    const gifStreams = probeStreams(gifRes.buffer, 'cap_gif.mp4');
    assert.equal(gifStreams.length, 1);
    assert.equal(gifStreams[0].codec_type, 'video');

    // 4. End-to-end handleUtilityCommands: video, WhatsApp GIF, durasi > MAX_CAP_VIDEO_SECONDS, dan View Once
    const sent = [];
    let unexpectedDownload = false;
    const mockSocket = {
      sendMessage: async (jid, content) => {
        sent.push({ jid, content });
        return { key: { id: `capvid-${sent.length}` } };
      }
    };

    // 4a. Video biasa dengan caption !cap -> { video, mimetype: 'video/mp4' } tanpa gifPlayback
    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => mp4Buf,
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '!cap TES VIDEO',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'cv-1', fromMe: true },
        message: {
          videoMessage: { caption: '!cap TES VIDEO', mimetype: 'video/mp4', fileLength: mp4Buf.length, seconds: 1 }
        }
      },
      addLog: () => {}
    });
    assert.ok(Buffer.isBuffer(sent[0].content.video));
    assert.equal(sent[0].content.gifPlayback, undefined);

    // 4b. WhatsApp GIF (gifPlayback: true) -> { video, gifPlayback: true }
    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => mp4Buf,
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '.cap TES GIF',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'cv-2', fromMe: true },
        message: {
          videoMessage: {
            caption: '.cap TES GIF',
            mimetype: 'video/mp4',
            fileLength: mp4Buf.length,
            seconds: 1,
            gifPlayback: true
          }
        }
      },
      addLog: () => {}
    });
    assert.ok(Buffer.isBuffer(sent[1].content.video));
    assert.equal(sent[1].content.gifPlayback, true);

    // 4c. Video > MAX_CAP_VIDEO_SECONDS ditolak SEBELUM diunduh
    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => {
        unexpectedDownload = true;
        return Buffer.alloc(0);
      },
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '!cap KEPANJANGAN',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'cv-long', fromMe: true },
        message: {
          videoMessage: {
            caption: '!cap KEPANJANGAN',
            mimetype: 'video/mp4',
            fileLength: 100000,
            seconds: MAX_CAP_VIDEO_SECONDS + 15
          }
        }
      },
      addLog: () => {}
    });
    assert.equal(unexpectedDownload, false);
    assert.match(sent[2].content.text, /durasi videonya terlalu panjang/i);

    // 4d. Video sekali lihat (View Once) ditolak SEBELUM diunduh
    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => {
        unexpectedDownload = true;
        return Buffer.alloc(0);
      },
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '!cap RAHASIA',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'cv-vo', fromMe: true },
        message: {
          viewOnceMessageV2: {
            message: {
              videoMessage: { caption: '!cap RAHASIA', mimetype: 'video/mp4', fileLength: 10000, viewOnce: true }
            }
          }
        }
      },
      addLog: () => {}
    });
    assert.equal(unexpectedDownload, false);
    assert.match(sent[3].content.text, /sekali lihat/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('!caphd (!meme / !capclean) renders crisp photo, transparent PNG, sticker, and video without burik degradation', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  // 1. Parsing semua alias !caphd / .caphd / !meme / .capclean tanpa tabrakan
  for (const trigger of ['!caphd', '.caphd', '!capclean', '.capclear', '!hdcap', '.meme', '!memecap']) {
    const p = parseUtilityCommand(`${trigger} ATAS | BAWAH`);
    assert.ok(p, `Harus mengenali ${trigger}`);
    assert.equal(p.command, 'caphd');
    assert.equal(p.isMediaCommand, true);
  }

  // 2. Foto kontras tinggi 900x900: !caphd menjaga resolusi 900x900 & ketajaman tepi (>180), tanpa burik
  const stripeSvg = `<svg width="900" height="900" xmlns="http://www.w3.org/2000/svg">
    <rect width="450" height="900" fill="#ffffff"/>
    <rect x="450" width="450" height="900" fill="#000000"/>
  </svg>`;
  const crispPhoto = await sharp(Buffer.from(stripeSvg)).png().toBuffer();

  const cleanOut = await renderCapMeme(crispPhoto, {
    topText: 'TEKS ATAS',
    bottomText: 'JERNIH HD',
    clean: true,
    returnStages: true
  });
  const burikOut = await renderCapMeme(crispPhoto, {
    topText: 'TEKS ATAS',
    bottomText: 'JERNIH HD',
    clean: false,
    returnStages: true
  });

  const cleanMeta = await sharp(cleanOut.finalBuffer).metadata();
  const burikMeta = await sharp(burikOut.finalBuffer).metadata();
  assert.equal(cleanMeta.width, 900, '!caphd tidak boleh mengecilkan foto 900px menjadi 640px');
  assert.equal(cleanMeta.height, 900);
  assert.equal(burikMeta.width, 640, '!cap burik tetap memakai kanvas 640px');

  const cleanMidEdge = await measureMaxHorizontalEdgeStep(cleanOut.finalBuffer, 0.5);
  const burikMidEdge = await measureMaxHorizontalEdgeStep(burikOut.finalBuffer, 0.5);
  assert.ok(cleanMidEdge > 200, `!caphd harus menjaga tepi foto tetap tajam (got ${cleanMidEdge})`);
  assert.ok(
    cleanMidEdge > burikMidEdge + 40,
    `!caphd harus jauh lebih tajam dari !cap burik (${cleanMidEdge} vs ${burikMidEdge})`
  );

  // 3. Foto PNG transparan tetap menjaga transparansi PNG pada mode clean
  const alphaPng = await sharp({
    create: { width: 512, height: 512, channels: 4, background: { r: 20, g: 160, b: 90, alpha: 0.5 } }
  })
    .png()
    .toBuffer();
  const cleanAlphaOut = await renderCapMeme(alphaPng, { bottomText: 'TRANSPARAN', clean: true });
  const alphaMeta = await sharp(cleanAlphaOut).metadata();
  assert.equal(alphaMeta.format, 'png');
  assert.equal(alphaMeta.hasAlpha, true);

  // 4. Stiker statis pada mode clean menghasilkan WebP 512x512 tajam + EXIF valid
  const baseSticker = await convertImageToSticker(crispPhoto);
  const cleanSticker = await renderCapSticker(baseSticker, { bottomText: 'STIKER HD', clean: true });
  assert.equal(isValidWebpBuffer(cleanSticker), true);
  assert.equal(readWebpExifMetadata(cleanSticker)['sticker-pack-name'], 'Another Me');

  // 5. Video MP4 via handleUtilityCommands (.meme / !caphd) menghasilkan video jernih & menjaga audio
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-caphd-vid-'));
  const inMp4 = path.join(tmpDir, 'in.mp4');
  const outMp4 = path.join(tmpDir, 'out.mp4');
  try {
    await execFileAsync(
      process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=15:duration=1.5',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest',
        inMp4
      ],
      { timeout: 20000, windowsHide: true }
    );
    const mp4Buf = fs.readFileSync(inMp4);

    const sent = [];
    const mockSocket = {
      sendMessage: async (jid, content) => {
        sent.push({ jid, content });
        return { key: { id: `caphd-${sent.length}` } };
      }
    };
    const handled = await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => mp4Buf,
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '.caphd VIDEO HD | TANPA BURIK',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'caphd-v1', fromMe: true },
        message: {
          videoMessage: {
            caption: '.caphd VIDEO HD | TANPA BURIK',
            mimetype: 'video/mp4',
            fileLength: mp4Buf.length,
            seconds: 2
          }
        }
      },
      addLog: () => {}
    });
    assert.equal(handled, true);
    assert.ok(Buffer.isBuffer(sent[0].content.video));
    assert.equal(sent[0].content.gifPlayback, undefined);
    fs.writeFileSync(outMp4, sent[0].content.video);
    const info = await probeVideoAudioInfo(outMp4);
    assert.equal(info.hasAudio, true, 'Video !caphd harus tetap mempertahankan trek audio aslinya');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('.s on video preserves original audio as WhatsApp Sound Sticker (Opus OGG + Protobuf field 134) and supports mute flag', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const { proto } = require('@whiskeysockets/baileys');
  const execFileAsync = promisify(execFile);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-soundstk-'));
  const vidWithAudioPath = path.join(tmpDir, 'with_audio.mp4');
  const vidSilentPath = path.join(tmpDir, 'silent.mp4');

  try {
    // 1. Buat video MP4 2 detik DENGAN audio 440Hz dan video MP4 1.5 detik TANPA audio
    await execFileAsync(
      process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=0x2266aa:s=320x320:d=2:r=12',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest',
        vidWithAudioPath
      ],
      { timeout: 20000, windowsHide: true }
    );
    await execFileAsync(
      process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=0xaa4422:s=320x320:d=1.5:r=12',
        '-an',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        vidSilentPath
      ],
      { timeout: 20000, windowsHide: true }
    );

    const withAudioBuf = fs.readFileSync(vidWithAudioPath);
    const silentBuf = fs.readFileSync(vidSilentPath);

    // 2. convertVideoOrGifToSticker dengan includeAudio: true mengekstrak WebP <= 500 KB + OGG/Opus <= 900 KB
    const soundRes = await convertVideoOrGifToSticker(withAudioBuf, { includeAudio: true });
    assert.equal(soundRes.hasAudio, true);
    assert.equal(isValidWebpBuffer(soundRes.stickerBuffer), true);
    assert.ok(soundRes.stickerBuffer.length <= MAX_ANIMATED_STICKER_BYTES);
    assert.ok(Buffer.isBuffer(soundRes.audioBuffer) && soundRes.audioBuffer.length > 0);
    assert.ok(soundRes.audioBuffer.length <= MAX_STICKER_AUDIO_BYTES);
    assert.equal(soundRes.audioBuffer.subarray(0, 4).toString('ascii'), 'OggS', 'Audio harus berwadah OGG');
    assert.ok(soundRes.audioBuffer.includes(Buffer.from('OpusHead')), 'Audio harus berkodek Opus');
    assert.ok(soundRes.audioSeconds >= 1);

    // Video bisu -> hasAudio false, audioBuffer null
    const silentRes = await convertVideoOrGifToSticker(silentBuf, { includeAudio: true });
    assert.equal(silentRes.hasAudio, false);
    assert.equal(silentRes.audioBuffer, null);
    assert.equal(isValidWebpBuffer(silentRes.stickerBuffer), true);

    // 3. handleUtilityCommands `.s` pada video bersuara mengirim payload `{ sticker, audioSticker }`,
    //    sedangkan `.s mute` hanya mengirim `{ sticker }` biasa tanpa audio
    const sentPayloads = [];
    const mockSocket = {
      sendMessage: async (jid, content) => {
        sentPayloads.push({ jid, content });
        return { key: { id: `snd-${sentPayloads.length}` } };
      }
    };

    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => withAudioBuf,
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '.s',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 's-vid-audio', fromMe: true },
        message: {
          videoMessage: {
            caption: '.s',
            mimetype: 'video/mp4',
            fileLength: withAudioBuf.length,
            seconds: 2
          }
        }
      },
      addLog: () => {}
    });
    assert.ok(Buffer.isBuffer(sentPayloads[0].content.sticker));
    assert.ok(sentPayloads[0].content.audioSticker, '.s pada video bersuara harus menyertakan audioSticker');
    assert.ok(Buffer.isBuffer(sentPayloads[0].content.audioSticker.audioBuffer));

    await handleUtilityCommands({
      waSocket: mockSocket,
      downloadMediaBuffer: async () => withAudioBuf,
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: '.s mute',
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 's-vid-mute', fromMe: true },
        message: {
          videoMessage: {
            caption: '.s mute',
            mimetype: 'video/mp4',
            fileLength: withAudioBuf.length,
            seconds: 2
          }
        }
      },
      addLog: () => {}
    });
    assert.ok(Buffer.isBuffer(sentPayloads[1].content.sticker));
    assert.equal(sentPayloads[1].content.audioSticker, undefined, '.s mute tidak boleh menyertakan audioSticker');

    // 4. Verifikasi wire Protobuf Stiker Suara (encode field 134 -> 1 -> 26 + field 24=0 + field 26 AudioMessage & decode balik)
    installAudioStickerProtoPatch();
    const encSha = Buffer.alloc(32, 0xab);
    const stickerMsg = proto.Message.StickerMessage.create({
      url: 'https://mmg.whatsapp.net/v/t62.15575-24/sample-sticker',
      mimetype: 'image/webp',
      fileEncSha256: encSha,
      fileSha256: Buffer.alloc(32, 0x11),
      mediaKey: Buffer.alloc(32, 0x22),
      directPath: '/v/t62.15575-24/sample-sticker',
      width: 512,
      height: 512,
      isAnimated: true
    });
    const audioMsg = proto.Message.AudioMessage.create({
      url: 'https://mmg.whatsapp.net/v/t62.7114-24/sample-audio',
      mimetype: 'audio/ogg; codecs=opus',
      fileEncSha256: Buffer.alloc(32, 0xcd),
      fileSha256: Buffer.alloc(32, 0x33),
      mediaKey: Buffer.alloc(32, 0x44),
      directPath: '/v/t62.7114-24/sample-audio',
      seconds: 2
    });
    registerAudioForStickerMessage(stickerMsg, audioMsg);

    const wireMsg = proto.Message.create({
      stickerMessage: stickerMsg,
      messageContextInfo: { messageSecret: Buffer.alloc(32, 0x55) }
    });
    const encoded = proto.Message.encode(wireMsg).finish();

    // Pastikan field 134 ada, top-level field 26 dibuang, dan field 35 (messageContextInfo) tetap utuh
    const f134 = findLengthDelimitedField(encoded, 134);
    assert.ok(f134 && f134.length > 0, 'Field 134 (audioStickerMessage) wajib ada pada wire bytes');
    assert.equal(findLengthDelimitedField(encoded, 26), null, 'Top-level field 26 tidak boleh rangkap dengan field 134');
    assert.ok(findLengthDelimitedField(encoded, 35), 'messageContextInfo (field 35) wajib tetap utuh di luar field 134');

    // Decode balik harus memulihkan stickerMessage + audioMessage secara transparan
    const decoded = proto.Message.decode(encoded);
    assert.ok(decoded.stickerMessage, 'Decode field 134 harus memulihkan stickerMessage');
    assert.equal(decoded.stickerMessage.mimetype, 'image/webp');
    assert.equal(decoded.stickerMessage.isAnimated, true);
    assert.ok(decoded.stickerMessage[AUDIO_STICKER_SYMBOL], 'Decode field 134 harus memulihkan AudioMessage tersemat');
    assert.equal(decoded.stickerMessage[AUDIO_STICKER_SYMBOL].mimetype, 'audio/ogg; codecs=opus');
    assert.equal(decoded.stickerMessage[AUDIO_STICKER_SYMBOL].seconds, 2);

    // Uji juga melalui DeviceSentMessage (untuk perangkat lain milik pengirim)
    const dsmEncoded = proto.Message.encode({
      deviceSentMessage: { destinationJid: '628111@s.whatsapp.net', message: wireMsg }
    }).finish();
    const dsmDecoded = proto.Message.decode(dsmEncoded);
    assert.ok(dsmDecoded.deviceSentMessage?.message?.stickerMessage);
    assert.equal(
      dsmDecoded.deviceSentMessage.message.stickerMessage[AUDIO_STICKER_SYMBOL]?.mimetype,
      'audio/ogg; codecs=opus'
    );

    // Stiker biasa TANPA audio tetap memakai top-level field 26 (tidak masuk field 134)
    const plainEncoded = proto.Message.encode({
      stickerMessage: { url: 'https://mmg.whatsapp.net/plain', mimetype: 'image/webp' }
    }).finish();
    assert.equal(findLengthDelimitedField(plainEncoded, 134), null);
    assert.ok(findLengthDelimitedField(plainEncoded, 26));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('!cap, !caphd, and !wm preserve audio when replying to a WhatsApp Sound Sticker (both direct quoted field 134 and cache fallback)', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { proto } = require('@whiskeysockets/baileys');
  const ContextManager = require('../src/contextManager');
  const KnowledgeManager = require('../src/knowledgeManager');
  const SettingsStore = require('../src/settingsStore');
  const LLMClient = require('../src/llmClient');

  installAudioStickerProtoPatch();

  const samplePng = await sharp({
    create: { width: 300, height: 300, channels: 4, background: { r: 60, g: 120, b: 220, alpha: 1 } }
  })
    .png()
    .toBuffer();
  const staticStickerBuf = await convertImageToSticker(samplePng);
  assert.equal(isAnimatedWebpBuffer(staticStickerBuf), false);
  const fakeOpusAudio = Buffer.concat([Buffer.from('OggS'), Buffer.from('OpusHead'), Buffer.alloc(64, 0x2a)]);

  // 1. Lapis 1: quotedMessage langsung membawa Stiker Suara wire bytes (field 134 -> 1 -> 26 + field 26 AudioMessage)
  const quotedSha = Buffer.alloc(32, 0x77);
  const quotedStickerProto = proto.Message.StickerMessage.create({
    url: 'https://mmg.whatsapp.net/v/t62.15575-24/quoted-sound-stk',
    mimetype: 'image/webp',
    fileSha256: quotedSha,
    fileEncSha256: Buffer.alloc(32, 0x88),
    mediaKey: Buffer.alloc(32, 0x99),
    directPath: '/v/t62.15575-24/quoted-sound-stk',
    width: 512,
    height: 512,
    isAnimated: false,
    fileLength: staticStickerBuf.length
  });
  const quotedAudioProto = proto.Message.AudioMessage.create({
    url: 'https://mmg.whatsapp.net/v/t62.7114-24/quoted-sound-audio',
    mimetype: 'audio/ogg; codecs=opus',
    fileSha256: Buffer.alloc(32, 0x44),
    fileEncSha256: Buffer.alloc(32, 0x55),
    mediaKey: Buffer.alloc(32, 0x66),
    directPath: '/v/t62.7114-24/quoted-sound-audio',
    seconds: 4
  });
  registerAudioForStickerMessage(quotedStickerProto, quotedAudioProto);

  // Simulasikan full round-trip decode WhatsApp untuk pesan reply (extendedTextMessage.contextInfo.quotedMessage)
  const replyWireBytes = proto.Message.encode({
    extendedTextMessage: {
      text: '!cap TETAP ADA SUARA',
      contextInfo: {
        stanzaId: 'orig-sound-stk-1',
        quotedMessage: { stickerMessage: quotedStickerProto }
      }
    }
  }).finish();
  const decodedReplyMsg = proto.Message.decode(replyWireBytes);
  assert.ok(decodedReplyMsg.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage);
  assert.equal(
    decodedReplyMsg.extendedTextMessage.contextInfo.quotedMessage.stickerMessage[AUDIO_STICKER_SYMBOL]?.seconds,
    4
  );

  const sentDirect = [];
  const mockDownload = async (target) => {
    if (target?.message?.audioMessage) return fakeOpusAudio;
    if (target?.message?.stickerMessage) return staticStickerBuf;
    throw new Error('Unexpected download target');
  };
  const mockSock = {
    sendMessage: async (jid, content) => {
      sentDirect.push({ jid, content });
      return { key: { id: `direct-${sentDirect.length}` } };
    }
  };

  for (const cmdText of ['!cap TETAP ADA SUARA', '.caphd JERNIH BERSUARA', '!wm Paket Suara | Fariez']) {
    await handleUtilityCommands({
      waSocket: mockSock,
      downloadMediaBuffer: mockDownload,
      remoteJid: '628111@s.whatsapp.net',
      senderKey: 'owner',
      fromMe: true,
      profile: { isKnown: true, name: 'Pemilik' },
      messageText: cmdText,
      msg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: `req-${cmdText}`, fromMe: true },
        message: decodedReplyMsg
      },
      addLog: () => {}
    });
  }

  assert.equal(sentDirect.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(isValidWebpBuffer(sentDirect[i].content.sticker), true);
    assert.ok(sentDirect[i].content.audioSticker, `Kasus #${i + 1} wajib mempertahankan audioSticker`);
    assert.deepEqual(sentDirect[i].content.audioSticker.audioBuffer, fakeOpusAudio);
    assert.equal(sentDirect[i].content.audioSticker.audioSeconds, 4);
  }
  assert.equal(readWebpExifMetadata(sentDirect[2].content.sticker)['sticker-pack-name'], 'Paket Suara');

  // 2. Lapis 2 & 3: Jika klien WhatsApp memangkas audio dari quotedMessage, BaileysService memulihkannya
  //    baik dari cache RAM maupun dari cache disk persisten SETELAH bot di-restart!
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-cap-sound-cache-'));
  const soundCacheDir = path.join(tmpDir, 'sound-sticker-cache');
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'persona.json'),
      JSON.stringify({ general_persona: { identity: 'Test' }, categories: { default: { tone: 'Netral', few_shots: [] } } })
    );
    const service = new BaileysService({
      llm: new LLMClient({ baseUrl: 'http://127.0.0.1:4000/v1beta/openai', model: 'gemma-4-26b-a4b-it' }),
      contextManager: new ContextManager({ dataPath: tmpDir }),
      knowledgeManager: new KnowledgeManager({ dataPath: tmpDir }),
      settingsStore: new SettingsStore({ dataPath: tmpDir }),
      addLog: () => {},
      options: { soundStickerCacheDir: soundCacheDir }
    });
    service.downloadMediaBuffer = mockDownload;

    // Simulasikan stiker suara sempat diterima/terkirim sebelumnya (terekam di RAM + disk)
    service.rememberSoundSticker({
      messageId: 'cached-sound-id-99',
      fileSha256: quotedSha,
      fileEncSha256: Buffer.alloc(32, 0x88),
      directPath: '/v/t62.15575-24/quoted-sound-stk',
      audioMessage: quotedAudioProto,
      audioBuffer: fakeOpusAudio,
      audioSeconds: 6,
      messageKey: { remoteJid: '628111@s.whatsapp.net', id: 'cached-sound-id-99', fromMe: true }
    });

    // Pemilik membalas stiker dengan quotedMessage TANPA audioMessage (simulasi pemangkasan klien)
    const strippedCandidate = {
      kind: 'sticker',
      source: 'quoted',
      mimeType: 'image/webp',
      fileLength: staticStickerBuf.length,
      fileSha256: quotedSha,
      fileEncSha256: Buffer.alloc(32, 0x88),
      directPath: '/v/t62.15575-24/quoted-sound-stk',
      audioMessage: null,
      targetMsg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'cached-sound-id-99', fromMe: true },
        message: { stickerMessage: { mimetype: 'image/webp', fileSha256: quotedSha } }
      }
    };
    const recovered = await service.resolveSoundStickerAudio(strippedCandidate);
    assert.ok(recovered, 'Cache lapis 2 wajib memulihkan audio saat quotedMessage tidak membawa audioMessage');
    assert.deepEqual(recovered.audioBuffer, fakeOpusAudio);
    assert.equal(recovered.audioSeconds, 6);

    // 2b. Simulasi RESTART BOT: instans BaileysService BARU (cache RAM kosong) tetap memulihkan audio dari cache disk!
    const restartedService = new BaileysService({
      llm: new LLMClient({ baseUrl: 'http://127.0.0.1:4000/v1beta/openai', model: 'gemma-4-26b-a4b-it' }),
      contextManager: new ContextManager({ dataPath: tmpDir }),
      knowledgeManager: new KnowledgeManager({ dataPath: tmpDir }),
      settingsStore: new SettingsStore({ dataPath: tmpDir }),
      addLog: () => {},
      options: { soundStickerCacheDir: soundCacheDir }
    });
    assert.equal(restartedService.soundStickerCache.size, 0, 'Cache RAM harus kosong pasca restart');
    const recoveredAfterRestart = await restartedService.resolveSoundStickerAudio(strippedCandidate);
    assert.ok(recoveredAfterRestart, 'Cache disk lapis 3 wajib memulihkan audio lintas restart bot');
    assert.deepEqual(recoveredAfterRestart.audioBuffer, fakeOpusAudio);
    assert.equal(recoveredAfterRestart.audioSeconds, 6);

    // Pemulihan juga berhasil lewat fileSha256 saja walau stanzaId baru (stiker difavoritkan & dikirim ulang)
    const recoveredByShaOnly = await restartedService.resolveSoundStickerAudio({
      ...strippedCandidate,
      fileEncSha256: null,
      directPath: '',
      targetMsg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'brand-new-stanza-id', fromMe: true },
        message: { stickerMessage: { mimetype: 'image/webp', fileSha256: quotedSha } }
      }
    });
    assert.ok(recoveredByShaOnly, 'Cache disk wajib mengenali stiker yang sama lewat fileSha256');
    assert.deepEqual(recoveredByShaOnly.audioBuffer, fakeOpusAudio);

    // 3. Stiker diam biasa (tanpa audio di quotedMessage maupun cache) tetap mengembalikan null
    const silentCandidate = {
      kind: 'sticker',
      source: 'quoted',
      mimeType: 'image/webp',
      fileLength: staticStickerBuf.length,
      fileSha256: Buffer.alloc(32, 0x01),
      audioMessage: null,
      targetMsg: {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'silent-stk-1', fromMe: false },
        message: { stickerMessage: { mimetype: 'image/webp' } }
      }
    };
    assert.equal(await restartedService.resolveSoundStickerAudio(silentCandidate), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
