/**
 * Command Router & Ask Queue Monitor
 * Menangani perintah instan WhatsApp (!ask / !tanya dan !acep)
 * serta pemantauan/pembersihan berkas antrean data/ask-queue/.
 *
 * Seluruh perilaku mengikuti aturan GEMINI.md bagian 7.3 & 7.4:
 * - !ask bersifat Muse-only (tanpa fallback ke Gemma)
 * - !acep hanya mengubah status AI kontak pengirim (tidak mengubah service global)
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync, readJsonSafeSync } = require('../utils/atomicFile');

const ASK_USAGE_REPLY = 'Pakai: !ask <pertanyaanmu>, contoh: !ask ibu kota Australia apa?';
const ASK_ACK_REPLY = 'Oke, aku teruskan pertanyaanmu ke Kiraya dulu ya, jawabannya menyusul sebentar lagi.';
const ASK_FAIL_REPLY = 'Maaf, pertanyaanmu gagal diteruskan. Coba kirim !ask lagi sebentar ya.';

/**
 * Mengurai perintah !ask atau !tanya.
 * @param {string} messageText
 * @returns {{ matched: boolean, question: string }}
 */
function parseAskCommand(messageText) {
  const trimmed = String(messageText || '').trim();
  const lower = trimmed.toLowerCase();
  const matched =
    lower === '!ask' ||
    lower.startsWith('!ask ') ||
    lower === '!tanya' ||
    lower.startsWith('!tanya ');

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
function enqueueAskQuestion(queueDir, { phone, name, category, question }) {
  const askId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const queueEntry = {
    id: askId,
    phone,
    name,
    category,
    question,
    askedAt: new Date().toISOString(),
    status: 'pending'
  };
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

    for (const file of files) {
      const fullPath = path.join(this.queueDir, file);
      const res = readJsonSafeSync(fullPath);
      if (!res.ok || !res.data || typeof res.data !== 'object') continue;

      const entry = res.data;
      const askedAtMs = Date.parse(entry.askedAt || '') || res.mtimeMs || nowMs;
      const ageMs = Math.max(0, nowMs - askedAtMs);

      if (entry.status === 'pending') {
        summary.pendingCount++;
        if (ageMs >= this.staleMs) {
          summary.stalePendingCount++;
          const ageMinutes = Math.floor(ageMs / 60000);
          summary.staleItems.push({
            id: entry.id || file,
            name: entry.name || entry.phone || '-',
            question: String(entry.question || '').slice(0, 80),
            ageMinutes
          });
          const key = entry.id || file;
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
            fs.unlinkSync(fullPath);
            summary.answeredCleanedCount++;
          } catch {}
        }
        if (entry.id) this.warnedIds.delete(entry.id);
      }
    }

    return summary;
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
 * Mengembalikan true jika pesan merupakan command yang sudah ditangani.
 */
async function handleInstantCommands({
  waSocket,
  remoteJid,
  senderPhone,
  senderPushName,
  profile,
  messageText,
  msg,
  contextManager,
  queueDir,
  addLog
}) {
  if (!profile.isKnown) return false;

  // 1. Command !ask / !tanya (Muse-only, tanpa fallback Gemma)
  const askParsed = parseAskCommand(messageText);
  if (askParsed.matched) {
    if (!askParsed.question) {
      contextManager.addMessage(senderPhone, 'user', messageText, {
        senderName: profile.name,
        pushName: senderPushName,
        phone: senderPhone,
        category: profile.category,
        command: '!ask'
      });
      await waSocket.sendMessage(remoteJid, { text: ASK_USAGE_REPLY });
      contextManager.addMessage(senderPhone, 'assistant', ASK_USAGE_REPLY, { command: '!ask' });
      return true;
    }

    await waSocket.readMessages([msg.key]);
    contextManager.addMessage(senderPhone, 'user', `!ask ${askParsed.question}`, {
      senderName: profile.name,
      phone: senderPhone,
      category: profile.category,
      command: '!ask'
    });

    let queueEntry;
    try {
      queueEntry = enqueueAskQuestion(queueDir, {
        phone: senderPhone,
        name: profile.name,
        category: profile.category,
        question: askParsed.question
      });
    } catch (qErr) {
      addLog('error', `Gagal menyimpan antrean !ask dari ${profile.name}: ${qErr.message}`);
      await waSocket.sendMessage(remoteJid, { text: ASK_FAIL_REPLY }, { quoted: msg });
      contextManager.addMessage(senderPhone, 'assistant', ASK_FAIL_REPLY, { command: '!ask' });
      return true;
    }

    await waSocket.sendMessage(remoteJid, { text: ASK_ACK_REPLY }, { quoted: msg });
    contextManager.addMessage(senderPhone, 'assistant', ASK_ACK_REPLY, { command: '!ask' });
    addLog('ask', `!ask dari ${profile.name} masuk antrean (${queueEntry.id}): "${askParsed.question}"`, {
      sender: profile.name,
      question: askParsed.question,
      askId: queueEntry.id
    });
    return true;
  }

  // 2. Command !acep (hanya toggle AI per-kontak, tidak menyentuh service global)
  const acepParsed = parseAcepCommand(messageText, profile.enabled);
  if (acepParsed.matched) {
    if (acepParsed.newState !== null) {
      const updated = contextManager.setContactEnabled(senderPhone, acepParsed.newState);
      if (updated !== null) {
        addLog(
          'acep',
          `Status AI ${profile.name} diubah lewat command !acep menjadi: ${updated ? 'ON' : 'OFF'} (service global tidak diubah).`
        );
      }
    }

    contextManager.addMessage(senderPhone, 'user', messageText, {
      senderName: profile.name,
      pushName: senderPushName,
      phone: senderPhone,
      category: profile.category,
      command: '!acep'
    });
    await waSocket.sendMessage(remoteJid, { text: acepParsed.reply });
    contextManager.addMessage(senderPhone, 'assistant', acepParsed.reply, { command: '!acep' });
    return true;
  }

  return false;
}

module.exports = {
  ASK_USAGE_REPLY,
  ASK_ACK_REPLY,
  ASK_FAIL_REPLY,
  parseAskCommand,
  parseAcepCommand,
  enqueueAskQuestion,
  AskQueueMonitor,
  handleInstantCommands
};
