/**
 * Sound Sticker Audio Cache Store
 *
 * Klien WhatsApp memangkas bidang `134` (`audioStickerMessage`) dan bidang `26` (`AudioMessage`)
 * ketika pengguna membalas (reply) sebuah Stiker Suara, sehingga `quotedMessage` hanya menyisakan
 * `StickerMessage` standar (`stanzaId`, `fileSha256`, `fileEncSha256`, `directPath`, serta field `24`).
 *
 * Modul ini menyimpan klip audio OGG/Opus berukuran kecil (~20-60 Kilobyte) beserta indeks pemetaan
 * (`messageId`, `fileSha256`, `fileEncSha256`, `directPath`) di `data/sound-sticker-cache/` (di-gitignore)
 * tanpa menyimpan `mediaKey` maupun rahasia WhatsApp, sehingga `!cap`, `!caphd`, dan `!wm` pada
 * Stiker Suara tetap mempertahankan suara aslinya bahkan setelah bot di-restart.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync, readJsonSafeSync } = require('../utils/atomicFile');

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari
const MAX_CACHED_AUDIO_BYTES = 1024 * 1024; // 1 Megabyte

function normalizeShaBase64(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw.trim();
  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
    return Buffer.from(raw).toString('base64');
  }
  return '';
}

class SoundStickerStore {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir || path.resolve(__dirname, '../../data/sound-sticker-cache');
    this.indexFile = path.join(this.cacheDir, 'index.json');
    this.maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
    this.retentionMs = options.retentionMs || DEFAULT_RETENTION_MS;
    this.entries = [];
    this.load();
  }

  ensureDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  load() {
    if (!fs.existsSync(this.indexFile)) {
      this.entries = [];
      return;
    }
    const res = readJsonSafeSync(this.indexFile);
    if (res.ok && res.data && Array.isArray(res.data.entries)) {
      this.entries = res.data.entries.filter((e) => e && typeof e === 'object' && e.audioFile);
      this.prune(Date.now(), { persistIfChanged: true });
    } else {
      this.entries = [];
    }
  }

  persist() {
    this.ensureDir();
    atomicWriteJsonSync(this.indexFile, { entries: this.entries });
  }

  prune(nowMs = Date.now(), { persistIfChanged = false } = {}) {
    const beforeLen = this.entries.length;
    const cutoff = nowMs - this.retentionMs;

    this.entries = this.entries.filter((e) => {
      const ts = Date.parse(e.savedAt || '') || 0;
      if (ts > 0 && ts < cutoff) return false;
      const audioPath = path.join(this.cacheDir, path.basename(String(e.audioFile || '')));
      return fs.existsSync(audioPath);
    });

    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(0, this.maxEntries);
    }

    // Hapus berkas .ogg yatim yang tidak lagi dirujuk indeks
    const referencedFiles = new Set(this.entries.map((e) => path.basename(String(e.audioFile || ''))));
    try {
      if (fs.existsSync(this.cacheDir)) {
        for (const f of fs.readdirSync(this.cacheDir)) {
          if (f.endsWith('.ogg') && !referencedFiles.has(f)) {
            try {
              fs.unlinkSync(path.join(this.cacheDir, f));
            } catch {}
          }
        }
      }
    } catch {}

    if (persistIfChanged && this.entries.length !== beforeLen) {
      try {
        this.persist();
      } catch {}
    }
  }

  save({
    messageId = '',
    fileSha256 = null,
    fileEncSha256 = null,
    directPath = '',
    audioBuffer,
    audioSeconds = 5
  }) {
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0 || audioBuffer.length > MAX_CACHED_AUDIO_BYTES) {
      return null;
    }

    const msgId = String(messageId || '').trim();
    const sha = normalizeShaBase64(fileSha256);
    const encSha = normalizeShaBase64(fileEncSha256);
    const dPath = String(directPath || '').trim();
    if (!msgId && !sha && !encSha && !dPath) return null;

    this.ensureDir();

    const audioHash = crypto.createHash('sha256').update(audioBuffer).digest('hex').slice(0, 24);
    const audioFile = `${audioHash}.ogg`;
    const audioPath = path.join(this.cacheDir, audioFile);
    if (!fs.existsSync(audioPath)) {
      const tmpPath = `${audioPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, audioBuffer);
      fs.renameSync(tmpPath, audioPath);
    }

    const nowIso = new Date().toISOString();
    const safeSeconds = Math.max(1, Math.round(Number(audioSeconds) || 5));

    // Gabungkan ke entri lama bila cocok berdasarkan fileSha256 atau audioFile + msgId
    const existingIdx = this.entries.findIndex(
      (e) =>
        (sha && e.fileSha256 === sha) ||
        (msgId && Array.isArray(e.messageIds) && e.messageIds.includes(msgId))
    );

    let entry;
    if (existingIdx !== -1) {
      entry = this.entries.splice(existingIdx, 1)[0];
      if (msgId && !entry.messageIds.includes(msgId)) {
        entry.messageIds.unshift(msgId);
        if (entry.messageIds.length > 20) entry.messageIds.length = 20;
      }
      if (sha) entry.fileSha256 = sha;
      if (encSha) entry.fileEncSha256 = encSha;
      if (dPath) entry.directPath = dPath;
      entry.audioFile = audioFile;
      entry.audioSeconds = safeSeconds;
      entry.savedAt = nowIso;
    } else {
      entry = {
        messageIds: msgId ? [msgId] : [],
        fileSha256: sha,
        fileEncSha256: encSha,
        directPath: dPath,
        audioFile,
        audioSeconds: safeSeconds,
        savedAt: nowIso
      };
    }

    this.entries.unshift(entry);
    this.prune(Date.now(), { persistIfChanged: false });
    this.persist();
    return entry;
  }

  find({ messageId = '', fileSha256 = null, fileEncSha256 = null, directPath = '' } = {}) {
    const msgId = String(messageId || '').trim();
    const sha = normalizeShaBase64(fileSha256);
    const encSha = normalizeShaBase64(fileEncSha256);
    const dPath = String(directPath || '').trim();
    if (!msgId && !sha && !encSha && !dPath) return null;

    const nowMs = Date.now();
    const cutoff = nowMs - this.retentionMs;

    const match = this.entries.find((e) => {
      const ts = Date.parse(e.savedAt || '') || 0;
      if (ts > 0 && ts < cutoff) return false;
      if (msgId && Array.isArray(e.messageIds) && e.messageIds.includes(msgId)) return true;
      if (sha && e.fileSha256 && e.fileSha256 === sha) return true;
      if (encSha && e.fileEncSha256 && e.fileEncSha256 === encSha) return true;
      if (dPath && e.directPath && e.directPath === dPath) return true;
      return false;
    });

    if (!match || !match.audioFile) return null;

    const safeFile = path.basename(String(match.audioFile));
    const audioPath = path.resolve(this.cacheDir, safeFile);
    const rootResolved = path.resolve(this.cacheDir);
    if (!audioPath.startsWith(rootResolved + path.sep) || !fs.existsSync(audioPath)) {
      return null;
    }

    try {
      const audioBuffer = fs.readFileSync(audioPath);
      if (!audioBuffer || audioBuffer.length === 0) return null;
      return {
        audioBuffer,
        audioSeconds: Math.max(1, Math.round(Number(match.audioSeconds) || 5))
      };
    } catch {
      return null;
    }
  }
}

module.exports = {
  SoundStickerStore,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_RETENTION_MS,
  MAX_CACHED_AUDIO_BYTES
};
