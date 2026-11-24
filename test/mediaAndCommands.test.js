const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { isValidWebpBuffer } = require('../src/utils/atomicFile');
const { injectWebpExif, readWebpExifMetadata } = require('../src/utils/webpExif');
const {
  MAX_MEDIA_BYTES,
  MAX_ANIMATED_STICKER_BYTES,
  MediaValidationError,
  validateImageBuffer,
  convertImageToSticker,
  convertVideoOrGifToSticker,
  convertStickerToPng,
  rewriteStickerExif,
  renderTextBlurImage,
  renderCapMeme,
  layoutImpactBlock
} = require('../src/media/imageProcessor');
const { CommandAntiSpamGuard } = require('../src/whatsapp/commandAntiSpam');
const {
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
  const { data, info } = await sharp(imageBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
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
  assert.equal(parseUtilityCommand('!teks halo').command, 'text');
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
    blurSigma: 3.0,
    returnStages: true
  });

  const finalMeta = await sharp(stages.finalBuffer).metadata();
  assert.equal(finalMeta.format, 'jpeg');
  assert.equal(finalMeta.width, 640);
  assert.equal(finalMeta.height, 640);

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
  const shortLayout = layoutImpactBlock('FARIEZ TIDUR', 768, 1024);
  assert.equal(shortLayout.lines.length, 1);
  assert.equal(shortLayout.lines[0], 'FARIEZ TIDUR');

  const longLayout = layoutImpactBlock('BESOK NGEBOHONG LAGI', 768, 1024);
  assert.equal(longLayout.lines.length, 2);
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

  // 1. Video dengan caption .cap -> ditolak sopan tanpa memanggil download
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
      message: { videoMessage: { caption: '.cap Atas | Bawah', mimetype: 'video/mp4', fileLength: 1000 } }
    },
    addLog: () => {}
  });
  assert.equal(downloadCalled, false);
  assert.match(sent[0].content.text, /hanya menerima berkas gambar/i);

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

    // Pemilik mengetik !ask di chat kontak tak terdaftar -> ditolak sopan (tidak masuk antrean Muse)
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628999888777@s.whatsapp.net', fromMe: true, id: 'own-ask-unknown' },
          message: { conversation: '!ask tes orang asing' }
        }
      ]
    });
    assert.match(ownSent[2].content.text, /hanya berlaku di ruang chat kontak terdaftar/i);
    assert.equal(fs.readdirSync(askDir).filter((f) => f.endsWith('.json')).length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
