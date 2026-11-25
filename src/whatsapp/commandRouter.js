/**
 * Command Router & Ask Queue Monitor
 * Menangani perintah instan WhatsApp (!ask / !tanya dan !acep)
 * serta pemantauan/pembersihan berkas antrean data/ask-queue/.
 *
 * Aturan perilaku:
 * - !ask bersifat khusus pemilik (fromMe: true) di semua ruang obrolan, mendukung lampiran media,
 *   dan tetap Muse-only (tanpa fallback ke Gemma)
 * - !acep khusus kontak terdaftar (& pemilik di ruang chat kontak terdaftar) dan hanya mengubah
 *   status AI kontak pengirim (tidak mengubah service global)
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync, readJsonSafeSync } = require('../utils/atomicFile');
const {
  resolveMaxAskMediaBytes,
  prepareAskMediaAttachment,
  formatAskQuestionWithContext,
  cleanupAskMediaFiles
} = require('./askMediaHelper');

const ASK_USAGE_REPLY = 'Pakai: !ask <pertanyaanmu>, contoh: !ask ibu kota Australia apa?';
const ASK_ACK_REPLY = 'Oke, aku teruskan pertanyaanmu ke Kiraya dulu ya, jawabannya menyusul sebentar lagi.';
const ASK_FAIL_REPLY = 'Maaf, pertanyaanmu gagal diteruskan. Coba kirim !ask lagi sebentar ya.';
const ASK_DEFAULT_MEDIA_QUESTION = 'Tolong lihat dan jelaskan media terlampir ini.';
const ASK_VIEW_ONCE_REPLY =
  'Maaf, media sekali lihat (View Once) tidak bisa diteruskan ke !ask demi menjaga privasi.';

const VALID_WHATSAPP_JID_RE = /^[^@\s]+@(s\.whatsapp\.net|lid|g\.us)$/;

function generateAskId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

/**
 * Mengurai perintah !ask atau !tanya (mendukung spasi maupun baris baru setelah perintah).
 * @param {string} messageText
 * @returns {{ matched: boolean, question: string }}
 */
function parseAskCommand(messageText) {
  const trimmed = String(messageText || '').trim();
  const matched = /^!(?:ask|tanya)(?:\s+|$)/i.test(trimmed);

  if (!matched) return { matched: false, question: '' };

  const question = trimmed.replace(/^!(?:ask|tanya)\s*/i, '').trim();
  return { matched: true, question };
}

/**
 * Mengurai perintah !acep beserta argumennya.
 * @param {string} messageText
 * @param {boolean} currentEnabled
 * @returns {{ matched: boolean, newState: boolean|null, reply: string }}
 */
function parseAcepCommand(messageText, currentEnabled) {
  const trimmed = String(messageText || '').trim();
  const lower = trimmed.toLowerCase();
  const matched = lower === '!acep' || lower.startsWith('!acep ');
  if (!matched) return { matched: false, newState: null, reply: '' };

  const cmdArg = lower.replace(/^!acep\s*/, '').trim();
  let newState = null;
  let reply = '';

  if (cmdArg === 'status') {
    reply = `acep lagi ${currentEnabled === false ? 'off' : 'on'}`;
  } else if (['on', 'nyala', 'aktif', 'enable', '1'].includes(cmdArg)) {
    newState = true;
    reply = 'acep on lagi ya';
  } else if (['off', 'mati', 'nonaktif', 'disable', '0'].includes(cmdArg)) {
    newState = false;
    reply = 'oke, acep off dulu ya';
  } else if (cmdArg === '') {
    newState = currentEnabled === false;
    reply = newState ? 'acep on lagi ya' : 'oke, acep off dulu ya';
  } else {
    reply = 'pakai: !acep on / !acep off / !acep (toggle) / !acep status';
  }

  return { matched: true, newState, reply };
}

/**
 * Menulis pertanyaan !ask ke data/ask-queue/<id>.json secara atomik.
 */
function enqueueAskQuestion(
  queueDir,
  {
    id,
    phone,
    name,
    category,
    question,
    rawQuestion,
    remoteJid,
    isGroup = false,
    fromMe = true,
    media = null,
    quotedText = ''
  }
) {
  const askId = id || generateAskId();
  const queueEntry = {
    id: askId,
    phone,
    name,
    category,
    question,
    askedAt: new Date().toISOString(),
    status: 'pending'
  };
  if (rawQuestion && rawQuestion !== question) {
    queueEntry.rawQuestion = rawQuestion;
  }
  if (remoteJid) {
    queueEntry.remoteJid = remoteJid;
  }
  queueEntry.isGroup = Boolean(isGroup);
  queueEntry.fromMe = Boolean(fromMe);
  if (media) {
    queueEntry.media = media;
  }
  if (quotedText) {
    queueEntry.quotedText = quotedText;
  }

  const targetFile = path.join(queueDir, `${askId}.json`);
  atomicWriteJsonSync(targetFile, queueEntry);
  return queueEntry;
}

/**
 * Memantau kesehatan antrean !ask (mendeteksi item pending macet > 5 menit)
 * dan membersihkan berkas berstatus 'answered' yang lebih tua dari 7 hari.
 */
class AskQueueMonitor {
  constructor(options = {}) {
    this.queueDir = options.queueDir || path.resolve(__dirname, '../../data/ask-queue');
    this.staleMs = options.staleMs ?? 5 * 60 * 1000; // 5 menit
    this.answeredRetentionMs = options.answeredRetentionMs ?? 7 * 24 * 60 * 60 * 1000; // 7 hari
    this.addLog = options.addLog || (() => {});
    this.warnedIds = new Set();
    this.timer = null;
  }

  inspectAndMaintain(nowMs = Date.now()) {
    const summary = {
      pendingCount: 0,
      stalePendingCount: 0,
      staleItems: [],
      answeredCleanedCount: 0
    };

    if (!fs.existsSync(this.queueDir)) {
      return summary;
    }

    let files = [];
    try {
      files = fs.readdirSync(this.queueDir).filter((f) => f.endsWith('.json'));
    } catch {
      return summary;
    }

    const seenPendingIds = new Set();

    for (const file of files) {
      const fullPath = path.join(this.queueDir, file);
      const res = readJsonSafeSync(fullPath);
      if (!res.ok || !res.data || typeof res.data !== 'object') continue;

      const entry = res.data;
      const askedAtMs = Date.parse(entry.askedAt || '') || res.mtimeMs || nowMs;
      const ageMs = Math.max(0, nowMs - askedAtMs);

      if (entry.status === 'pending') {
        const key = entry.id || file;
        seenPendingIds.add(key);
        summary.pendingCount++;
        if (ageMs >= this.staleMs) {
          summary.stalePendingCount++;
          const ageMinutes = Math.floor(ageMs / 60000);
          summary.staleItems.push({
            id: key,
            name: entry.name || entry.phone || '-',
            question: String(entry.question || '').slice(0, 80),
            ageMinutes
          });
          if (!this.warnedIds.has(key)) {
            this.warnedIds.add(key);
            this.addLog(
              'warn',
              `Antrean !ask [${key}] dari ${entry.name || entry.phone} masih pending selama ${ageMinutes} menit (cek hook Muse/kuota).`,
              { askId: key, ageMinutes }
            );
          }
        }
      } else if (entry.status === 'answered') {
        const refMs = Date.parse(entry.answeredAt || '') || res.mtimeMs || askedAtMs;
        if (nowMs - refMs >= this.answeredRetentionMs) {
          try {
            cleanupAskMediaFiles(this.queueDir, entry.media);
            fs.unlinkSync(fullPath);
            summary.answeredCleanedCount++;
          } catch {}
        }
        if (entry.id) this.warnedIds.delete(entry.id);
      }
    }

    // Bersihkan warnedIds dari berkas antrean yang sudah dihapus manual di disk (MEM-01)
    for (const oldKey of Array.from(this.warnedIds)) {
      if (!seenPendingIds.has(oldKey)) {
        this.warnedIds.delete(oldKey);
      }
    }

    return summary;
  }

  /**
   * Mencari target JID balasan dari antrean !ask berdasarkan askId, remoteJid, phone, atau name.
   * Memprioritaskan item berstatus 'pending' terbaru agar Muse dapat membalas !ask dari grup
   * maupun ruang obrolan yang tidak terdaftar di contacts.json melalui POST /api/send-to-contact.
   */
  findTargetByQuery(rawQuery) {
    const query = String(rawQuery || '').trim();
    if (!query || !fs.existsSync(this.queueDir)) return null;
    const queryLower = query.toLowerCase();

    let files = [];
    try {
      files = fs.readdirSync(this.queueDir).filter((f) => f.endsWith('.json'));
    } catch {
      return null;
    }

    let bestMatch = null;
    for (const file of files) {
      const fullPath = path.join(this.queueDir, file);
      const res = readJsonSafeSync(fullPath);
      if (!res.ok || !res.data || typeof res.data !== 'object') continue;
      const entry = res.data;
      const remoteJid = String(entry.remoteJid || '').trim();
      if (!VALID_WHATSAPP_JID_RE.test(remoteJid)) continue;

      const matched =
        entry.id === query ||
        remoteJid === query ||
        String(entry.phone || '').trim() === query ||
        String(entry.name || '').trim().toLowerCase() === queryLower;

      if (!matched) continue;

      const isPending = entry.status === 'pending' ? 1 : 0;
      const ts = Date.parse(entry.askedAt || '') || res.mtimeMs || 0;
      if (
        !bestMatch ||
        isPending > bestMatch.isPending ||
        (isPending === bestMatch.isPending && ts > bestMatch.ts)
      ) {
        bestMatch = {
          id: entry.id || file.replace(/\.json$/, ''),
          remoteJid,
          phone: String(entry.phone || remoteJid),
          name: String(entry.name || remoteJid),
          isGroup: Boolean(entry.isGroup || remoteJid.endsWith('@g.us')),
          status: entry.status || 'pending',
          isPending,
          ts
        };
      }
    }

    if (!bestMatch) return null;
    return {
      id: bestMatch.id,
      remoteJid: bestMatch.remoteJid,
      phone: bestMatch.phone,
      name: bestMatch.name,
      isGroup: bestMatch.isGroup,
      status: bestMatch.status
    };
  }

  start(intervalMs = 60 * 1000) {
    if (this.timer) return;
    this.inspectAndMaintain();
    this.timer = setInterval(() => {
      try {
        this.inspectAndMaintain();
      } catch {}
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Menjalankan routing command instan (!ask / !tanya / !acep) sebelum gate whitelist/enabled.
 * - !ask / !tanya: khusus pemilik (fromMe === true), di semua ruang obrolan, mendukung media.
 *   Bila dikirim oleh non-pemilik, diabaikan diam-diam tanpa membalas dan tanpa masuk antrean.
 * - !acep: khusus kontak terdaftar (dan pemilik di ruang chat kontak terdaftar).
 * Mengembalikan true jika pesan merupakan command yang sudah ditangani.
 */
async function handleInstantCommands({
  waSocket,
  sendTrackedMessage,
  downloadMediaBuffer,
  remoteJid,
  senderPhone,
  senderPushName,
  profile,
  fromMe = false,
  isGroup = false,
  messageText,
  msg,
  mediaCandidate = null,
  quotedText = '',
  contextManager,
  queueDir,
  addLog = () => {}
}) {
  const sendSafe = async (payload, options = {}) => {
    if (typeof sendTrackedMessage === 'function') {
      return await sendTrackedMessage(remoteJid, payload, options);
    }
    return await waSocket.sendMessage(remoteJid, payload, options);
  };

  const safeProfile = profile || {
    isKnown: false,
    name: senderPushName || senderPhone || remoteJid || 'Pemilik',
    phone: senderPhone || '',
    category: isGroup ? 'group' : 'default',
    enabled: false
  };
  const actorTag = fromMe ? `Pemilik -> ${safeProfile.name}` : safeProfile.name;

  // 1. Command !ask / !tanya (KHUSUS fromMe / pemilik, Muse-only tanpa fallback Gemma, mendukung media)
  const askParsed = parseAskCommand(messageText);
  if (askParsed.matched) {
    if (!fromMe) {
      addLog(
        'info',
        `Perintah !ask dari ${safeProfile.name} (${senderPhone || remoteJid}) diabaikan (khusus pemilik fromMe).`
      );
      return true;
    }

    const historyKey = isGroup
      ? `group:${String(remoteJid || '').replace(/@.*$/, '')}`
      : senderPhone || String(remoteJid || '').replace(/@.*$/, '');

    // Tolak media View Once demi menjaga privasi
    if (mediaCandidate && mediaCandidate.kind === 'view_once') {
      await sendSafe({ text: ASK_VIEW_ONCE_REPLY }, { quoted: msg });
      addLog('info', `!ask dari ${actorTag} ditolak karena media sekali lihat (View Once).`);
      return true;
    }

    if (!askParsed.question && !mediaCandidate) {
      contextManager.addMessage(historyKey, 'user', messageText, {
        senderName: safeProfile.name,
        pushName: senderPushName,
        phone: senderPhone,
        category: safeProfile.category,
        command: '!ask',
        initiatedByOwner: true,
        ...(isGroup ? { groupJid: remoteJid } : {})
      });
      await sendSafe({ text: ASK_USAGE_REPLY }, { quoted: msg });
      contextManager.addMessage(historyKey, 'assistant', ASK_USAGE_REPLY, { command: '!ask' });
      return true;
    }

    const rawQuestion = askParsed.question || ASK_DEFAULT_MEDIA_QUESTION;
    const askId = generateAskId();
    let mediaMeta = null;

    if (mediaCandidate) {
      const maxBytes = resolveMaxAskMediaBytes();
      const maxMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;

      if (mediaCandidate.fileLength > maxBytes) {
        await sendSafe(
          { text: `Maaf, ukuran media terlalu besar untuk !ask (maksimal ${maxMb} Megabyte).` },
          { quoted: msg }
        );
        return true;
      }

      if (typeof downloadMediaBuffer !== 'function' || !mediaCandidate.targetMsg) {
        await sendSafe(
          { text: 'Maaf, pengunduh media belum tersedia untuk memproses lampiran !ask ini.' },
          { quoted: msg }
        );
        return true;
      }

      let mediaBuffer;
      try {
        mediaBuffer = await downloadMediaBuffer(mediaCandidate.targetMsg);
      } catch (dlErr) {
        addLog('error', `Gagal mengunduh media !ask dari ${actorTag}: ${dlErr.message}`);
        await sendSafe(
          {
            text: 'Maaf, media gagal diunduh dari WhatsApp (kemungkinan terlalu lama atau kedaluwarsa). Coba kirim ulang medianya ya.'
          },
          { quoted: msg }
        );
        return true;
      }

      if (!Buffer.isBuffer(mediaBuffer) || mediaBuffer.length === 0) {
        await sendSafe(
          { text: 'Maaf, data media kosong sehingga tidak bisa diteruskan ke !ask.' },
          { quoted: msg }
        );
        return true;
      }

      try {
        mediaMeta = await prepareAskMediaAttachment({
          askId,
          queueDir,
          candidate: mediaCandidate,
          buffer: mediaBuffer
        });
      } catch (prepErr) {
        addLog('error', `Gagal menyiapkan media !ask dari ${actorTag}: ${prepErr.message}`);
        await sendSafe({ text: prepErr.userMessage || ASK_FAIL_REPLY }, { quoted: msg });
        return true;
      }
    }

    const effectiveQuotedText = mediaCandidate ? '' : String(quotedText || '').trim();
    const finalQuestion = formatAskQuestionWithContext(rawQuestion, mediaMeta, effectiveQuotedText);

    contextManager.addMessage(
      historyKey,
      'user',
      mediaMeta ? `!ask [${mediaMeta.kind}] ${rawQuestion}` : `!ask ${rawQuestion}`,
      {
        senderName: safeProfile.name,
        phone: senderPhone,
        category: safeProfile.category,
        command: '!ask',
        initiatedByOwner: true,
        ...(isGroup ? { groupJid: remoteJid } : {})
      }
    );

    let queueEntry;
    try {
      queueEntry = enqueueAskQuestion(queueDir, {
        id: askId,
        phone: senderPhone,
        name: safeProfile.name,
        category: safeProfile.category,
        question: finalQuestion,
        rawQuestion,
        remoteJid,
        isGroup: Boolean(isGroup),
        fromMe: true,
        media: mediaMeta,
        quotedText: effectiveQuotedText
      });
    } catch (qErr) {
      cleanupAskMediaFiles(queueDir, mediaMeta);
      addLog('error', `Gagal menyimpan antrean !ask dari ${actorTag}: ${qErr.message}`);
      await sendSafe({ text: ASK_FAIL_REPLY }, { quoted: msg });
      contextManager.addMessage(historyKey, 'assistant', ASK_FAIL_REPLY, { command: '!ask' });
      return true;
    }

    await sendSafe({ text: ASK_ACK_REPLY }, { quoted: msg });
    contextManager.addMessage(historyKey, 'assistant', ASK_ACK_REPLY, { command: '!ask' });
    const mediaTag = mediaMeta ? ` + media ${mediaMeta.kind}` : '';
    addLog('ask', `!ask dari ${actorTag}${mediaTag} masuk antrean (${queueEntry.id}): "${rawQuestion}"`, {
      sender: safeProfile.name,
      question: rawQuestion,
      askId: queueEntry.id,
      hasMedia: Boolean(mediaMeta),
      mediaKind: mediaMeta?.kind || null,
      isGroup: Boolean(isGroup),
      initiatedByOwner: true
    });
    return true;
  }

  // 2. Command !acep (khusus kontak terdaftar; hanya toggle AI per-kontak, tidak menyentuh service global)
  if (!safeProfile.isKnown) return false;

  const acepParsed = parseAcepCommand(messageText, safeProfile.enabled);
  if (acepParsed.matched) {
    if (acepParsed.newState !== null) {
      const updated = contextManager.setContactEnabled(senderPhone, acepParsed.newState);
      if (updated !== null) {
        addLog(
          'acep',
          `Status AI ${safeProfile.name} diubah lewat command !acep (${fromMe ? 'oleh pemilik' : 'oleh kontak'}) menjadi: ${updated ? 'ON' : 'OFF'} (service global tidak diubah).`
        );
      }
    }

    contextManager.addMessage(senderPhone, 'user', messageText, {
      senderName: safeProfile.name,
      pushName: senderPushName,
      phone: senderPhone,
      category: safeProfile.category,
      command: '!acep',
      initiatedByOwner: fromMe
    });
    await sendSafe({ text: acepParsed.reply });
    contextManager.addMessage(senderPhone, 'assistant', acepParsed.reply, { command: '!acep' });
    return true;
  }

  return false;
}

module.exports = {
  ASK_USAGE_REPLY,
  ASK_ACK_REPLY,
  ASK_FAIL_REPLY,
  ASK_DEFAULT_MEDIA_QUESTION,
  ASK_VIEW_ONCE_REPLY,
  generateAskId,
  parseAskCommand,
  parseAcepCommand,
  enqueueAskQuestion,
  AskQueueMonitor,
  handleInstantCommands
};
