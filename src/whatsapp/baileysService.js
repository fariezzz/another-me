/**
 * Baileys WhatsApp Service
 * Mengelola siklus hidup soket WhatsApp, reconnect dengan exponential backoff,
 * antrean burst anti-spam, pemrosesan pesan/stiker, serta pengiriman manual.
 */

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');

function buildProxyAgent() {
  if (!process.env.HTTPS_PROXY) return undefined;
  const { HttpsProxyAgent } = require('https-proxy-agent');
  return new HttpsProxyAgent(process.env.HTTPS_PROXY);
}

const { renderQrToSvg } = require('../utils/atomicFile');
const { handleInstantCommands, parseAskCommand, parseAcepCommand } = require('./commandRouter');
const { CommandAntiSpamGuard } = require('./commandAntiSpam');
const {
  unwrapWhatsAppMessage,
  cleanCommandText,
  parseUtilityCommand,
  parseFileLength,
  handleUtilityCommands
} = require('./utilityCommands');

const MAX_AUTO_VISION_STICKER_BYTES = 2 * 1024 * 1024; // 2 Megabyte batas aman stiker Vision otomatis (SEC-05)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getMessageTimestampSeconds(msg) {
  const raw = msg?.messageTimestamp;
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
 * Menyaring noise internal Baileys v7 yang tidak berbahaya (dekripsi Sender Key grup/status,
 * rollback transaksi internal auth-utils, dan stream error 515 pasca-pairing) agar terminal
 * dan bot.log tetap bersih. Pesan fromMe milik pemilik tidak pernah disaring bila gagal dekripsi.
 */
function shouldSuppressBaileysLog(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const msg = String(entry.msg || '');
  const errMsg = String(entry.err?.message || entry.error?.message || '');
  const remoteJid = String(entry.key?.remoteJid || entry.sender || '');
  const isFromMe = Boolean(entry.key?.fromMe);
  const isGroupOrBroadcast =
    remoteJid === 'status@broadcast' ||
    remoteJid.endsWith('@broadcast') ||
    remoteJid.endsWith('@g.us');

  if (msg === 'transaction failed, rolling back') {
    return true;
  }

  if (msg === 'failed to decrypt message' && !isFromMe) {
    if (
      isGroupOrBroadcast ||
      entry.messageType === 'skmsg' ||
      /no session found to decrypt message/i.test(errMsg)
    ) {
      return true;
    }
  }

  if (msg === 'stream errored out' && String(entry.fullErrorNode?.attrs?.code || '') === '515') {
    return true;
  }

  return false;
}

/**
 * Memformat log galat Baileys yang benar-benar penting menjadi 1 baris ringkas yang mudah dibaca,
 * menggantikan dump JSON mentah Pino yang panjang.
 */
function formatCleanBaileysLog(entry) {
  const levelNum = Number(entry.level || 50);
  const levelTag =
    levelNum >= 60 ? 'FATAL' : levelNum >= 50 ? 'ERROR' : levelNum >= 40 ? 'WARN' : 'INFO';
  const msg = String(entry.msg || 'Baileys event').trim();
  const errMsg = String(entry.err?.message || entry.error?.message || '').trim();
  const remoteJid = String(entry.key?.remoteJid || entry.sender || '').trim();
  const code = entry.fullErrorNode?.attrs?.code ? ` [kode ${entry.fullErrorNode.attrs.code}]` : '';
  const details = [];
  if (errMsg && errMsg !== msg) details.push(errMsg);
  if (remoteJid) details.push(`dari ${remoteJid}`);
  const suffix = details.length > 0 ? ` - ${details.join(' | ')}` : '';
  return `[Baileys ${levelTag}] ${msg}${code}${suffix}`;
}

/**
 * Membuat logger Pino kompatibel Baileys (mendukung .child) yang menyaring noise
 * dan merapikan format log menjadi satu baris bersih dengan deduplikasi 60 detik.
 */
function createFilteredBaileysLogger({
  level = process.env.BAILEYS_LOG_LEVEL || 'error',
  rawMode = process.env.BAILEYS_RAW_LOGS === 'true',
  writeLine = (line) => console.error(line),
  dedupWindowMs = 60 * 1000
} = {}) {
  if (rawMode) {
    return pino({ level });
  }

  const recentLines = new Map();

  const destination = {
    write(chunk) {
      const text = String(chunk || '').trim();
      if (!text) return;

      let entry;
      try {
        entry = JSON.parse(text);
      } catch {
        writeLine(`[Baileys] ${text}`);
        return;
      }

      if (shouldSuppressBaileysLog(entry)) {
        return;
      }

      const formatted = formatCleanBaileysLog(entry);
      const now = Date.now();
      const lastSeen = recentLines.get(formatted) || 0;
      if (now - lastSeen < dedupWindowMs) {
        return;
      }
      recentLines.set(formatted, now);
      if (recentLines.size > 100) {
        for (const [k, ts] of recentLines.entries()) {
          if (now - ts >= dedupWindowMs) recentLines.delete(k);
        }
      }

      writeLine(formatted);
    }
  };

  return pino({ level }, destination);
}

class BaileysService {
  constructor({ llm, contextManager, knowledgeManager, toolRegistry = null, settingsStore, addLog, options = {} }) {
    this.llm = llm;
    this.contextManager = contextManager;
    this.knowledgeManager = knowledgeManager;
    this.toolRegistry = toolRegistry;
    this.settingsStore = settingsStore;
    this.addLog = addLog || (() => {});

    this.authPath = options.authPath || path.resolve(__dirname, '../../auth_info_baileys');
    this.askQueueDir = options.askQueueDir || path.resolve(__dirname, '../../data/ask-queue');
    this.typingDelayMin = parseInt(process.env.TYPING_DELAY_MIN, 10) || 2000;
    this.typingDelayMax = parseInt(process.env.TYPING_DELAY_MAX, 10) || 4500;
    this.burstWindowMs = parseInt(process.env.BURST_WINDOW_MS, 10) || 4000;
    this.burstProcessTimeoutMs = options.burstProcessTimeoutMs ?? 90000;

    // Logger Pino tersaring: buang noise grup/status/rollback dan format sisa galat jadi 1 baris rapi
    this.logger = options.logger || createFilteredBaileysLogger();

    this.waSocket = null;
    this.connectionStatus = 'connecting';
    this.currentQR = null;
    this.currentQrSvg = null;
    this.currentPairingCode = null;
    this.lastDisconnectReason = null;

    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.isShuttingDown = false;
    this.isStarting = false;

    // Antrean burst berada di level instans layanan agar konsisten lintas reconnect
    this.pendingBursts = new Map();

    // Pengaman anti-loop untuk pesan keluar bot sendiri (penting saat fromMe: true diproses)
    this.sentMessageIds = new Set();

    // Pelindung anti-spam berlapis untuk perintah utilitas WhatsApp
    this.commandAntiSpam =
      options.commandAntiSpam ||
      new CommandAntiSpamGuard({
        addLog: this.addLog
      });
  }

  rememberSentMessageId(msgId) {
    if (!msgId) return;
    this.sentMessageIds.add(msgId);
    if (this.sentMessageIds.size > 500) {
      const oldest = this.sentMessageIds.values().next().value;
      if (oldest !== undefined) this.sentMessageIds.delete(oldest);
    }
  }

  async sendTrackedMessage(remoteJid, content, options = {}) {
    const sent = await this.waSocket.sendMessage(remoteJid, content, options);
    this.rememberSentMessageId(sent?.key?.id);
    return sent;
  }

  /**
   * Mengunduh media WhatsApp dengan memakai ulang fungsi downloadMediaMessage bawaan Baileys.
   */
  async downloadMediaBuffer(targetMsg) {
    return await downloadMediaMessage(
      targetMsg,
      'buffer',
      {},
      {
        logger: this.logger,
        reuploadRequest: this.waSocket?.updateMediaMessage
      }
    );
  }

  getStatus() {
    return {
      status: this.connectionStatus,
      qrAvailable: Boolean(this.currentQR),
      qr: this.currentQR,
      qrSvg: this.currentQrSvg,
      pairingCode: this.currentPairingCode,
      lastDisconnectReason: this.lastDisconnectReason
    };
  }

  isConnected() {
    return Boolean(this.waSocket && this.connectionStatus === 'connected');
  }

  /**
   * Memeriksa apakah suatu JID (nomor telepon @s.whatsapp.net maupun @lid) adalah milik akun bot sendiri.
   * Dibutuhkan pada grup WhatsApp Baileys v7 yang memakai addressingMode 'lid',
   * di mana msg.key.fromMe kadang bernilai false meskipun participantAlt cocok dengan user.id kita.
   */
  isOwnUserJid(jid) {
    if (!jid || !this.waSocket?.user) return false;
    const targetUser = String(jid).split('@')[0].split(':')[0];
    if (!targetUser) return false;
    const myIdUser = String(this.waSocket.user.id || '').split('@')[0].split(':')[0];
    const myLidUser = String(this.waSocket.user.lid || '').split('@')[0].split(':')[0];
    return Boolean((myIdUser && targetUser === myIdUser) || (myLidUser && targetUser === myLidUser));
  }

  /**
   * Membersihkan soket Baileys lama agar tidak terjadi kebocoran listener atau sesi ganda.
   */
  cleanupPreviousSocket() {
    if (!this.waSocket) return;
    try {
      if (this.waSocket.ev && typeof this.waSocket.ev.removeAllListeners === 'function') {
        this.waSocket.ev.removeAllListeners();
      }
      if (this.waSocket.ws && typeof this.waSocket.ws.close === 'function') {
        this.waSocket.ws.close();
      }
    } catch {}
    this.waSocket = null;
  }

  scheduleReconnect() {
    if (this.isShuttingDown || this.reconnectTimer) return;
    const backoffStepsMs = [3000, 6000, 15000, 30000, 60000];
    const baseDelay = backoffStepsMs[Math.min(this.reconnectAttempt, backoffStepsMs.length - 1)];
    const jitter = Math.floor(Math.random() * 1000);
    const delayMs = baseDelay + jitter;
    this.reconnectAttempt++;

    this.addLog('info', `Menjadwalkan reconnect WhatsApp #${this.reconnectAttempt} dalam ${Math.round(delayMs / 1000)} detik...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, delayMs);
  }

  async start() {
    if (this.isShuttingDown || this.isStarting) return;
    this.isStarting = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.cleanupPreviousSocket();
    this.connectionStatus = 'connecting';
    this.currentQR = null;
    this.currentQrSvg = null;
    this.addLog('info', 'Memulai inisialisasi koneksi WhatsApp...');

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        logger: this.logger,
        printQRInTerminal: false,
        auth: state,
        browser: ['Another Me AI', 'Desktop', '1.0.0'],
        syncFullHistory: false,
        agent: buildProxyAgent()
      });

      this.waSocket = sock;

      sock.ev.on('connection.update', (update) => {
        // Abaikan event dari soket generasi lama jika sudah diganti
        if (this.waSocket !== sock) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.currentQR = qr;
          this.currentQrSvg = renderQrToSvg(qr);
          this.connectionStatus = 'qr_ready';
          qrcode.generate(qr, { small: true });
          this.addLog('warn', 'QR Code siap di-scan di terminal atau Dashboard Web.');
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !this.isShuttingDown;
          this.connectionStatus = 'disconnected';
          this.lastDisconnectReason = statusCode ?? null;
          this.addLog('error', `Koneksi terputus (Status: ${statusCode}). Reconnect: ${shouldReconnect}`);

          if (shouldReconnect) {
            this.scheduleReconnect();
          }
        } else if (connection === 'open') {
          this.connectionStatus = 'connected';
          this.currentQR = null;
          this.currentQrSvg = null;
          this.currentPairingCode = null;
          this.lastDisconnectReason = null;
          this.reconnectAttempt = 0;
          this.addLog('info', '✅ WhatsApp Berhasil Terhubung! Bot Another Me aktif.');
        }
      });

      sock.ev.on('creds.update', saveCreds);

      // Rekam pemetaan LID <-> nomor telepon yang dikirim Baileys v7 (BUG-03)
      sock.ev.on('lid-mapping.update', (mappings) => {
        if (this.waSocket !== sock || !mappings) return;
        const normalizeMappedJid = (raw, suffix) => {
          const val = String(raw || '').trim();
          if (!val) return '';
          if (val.includes('@')) return val;
          const digits = val.replace(/\D/g, '');
          return digits ? `${digits}${suffix}` : '';
        };
        try {
          if (!Array.isArray(mappings) && typeof mappings === 'object' && mappings.lid && mappings.pn) {
            this.contextManager.recordContactJid(
              normalizeMappedJid(mappings.lid, '@lid'),
              normalizeMappedJid(mappings.pn, '@s.whatsapp.net')
            );
            return;
          }
          const entries = Array.isArray(mappings) ? mappings : Object.entries(mappings);
          for (const item of entries) {
            if (Array.isArray(item) && item.length >= 2) {
              const first = normalizeMappedJid(item[0], '@lid');
              const second = normalizeMappedJid(item[1], '@s.whatsapp.net');
              if (first && second) this.contextManager.recordContactJid(first, second);
            } else if (item && item.lid && item.pn) {
              const lidJid = normalizeMappedJid(item.lid, '@lid');
              const pnJid = normalizeMappedJid(item.pn, '@s.whatsapp.net');
              if (lidJid && pnJid) this.contextManager.recordContactJid(lidJid, pnJid);
            }
          }
        } catch {}
      });

      // Pairing code opsional via .env PAIRING_PHONE (hanya jika belum terdaftar)
      if (process.env.PAIRING_PHONE && !state.creds.registered) {
        try {
          const cleanPhone = String(process.env.PAIRING_PHONE).replace(/\D/g, '');
          this.currentPairingCode = await sock.requestPairingCode(cleanPhone);
          this.addLog('warn', 'Kode pairing 8 digit siap digunakan di Dashboard Web.');
        } catch (err) {
          this.addLog('error', `Gagal meminta kode pairing: ${err.message}`);
        }
      }

      sock.ev.on('messages.upsert', async (m) => {
        if (this.waSocket !== sock) return;
        await this.handleMessagesUpsert(m);
      });
    } catch (err) {
      this.connectionStatus = 'disconnected';
      this.addLog('error', `Inisialisasi Baileys gagal: ${err.message}`);
      this.scheduleReconnect();
    } finally {
      this.isStarting = false;
    }
  }

  async requestPairingCode(rawPhone) {
    if (!this.waSocket) {
      throw new Error('WhatsApp belum jalan');
    }
    const phone = String(rawPhone || '').replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(phone)) {
      const err = new Error('Nomor tidak valid, pakai digit kode negara, misal 62812...');
      err.statusCode = 400;
      throw err;
    }
    this.currentPairingCode = await this.waSocket.requestPairingCode(phone);
    this.addLog('warn', 'Kode pairing 8 digit baru telah diminta dan siap di Dashboard Web.');
    return this.currentPairingCode;
  }

  async resolveTargetJidForManualSend(phone) {
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    const stored = this.contextManager.getStoredJid(cleanPhone);
    if (stored) return stored;

    // Jika kontak terdaftar di contacts.json tetapi JID belum terekam, jangan menebak @s.whatsapp.net
    // untuk kontak yang kemungkinan ber-ID LID (GEMINI.md 5.3 & 7.7)
    if (this.contextManager.contacts[cleanPhone]) {
      const err = new Error('JID kontak terdaftar belum tersimpan: tunggu kontak mengirim pesan dulu agar JID @lid terekam.');
      err.statusCode = 409;
      throw err;
    }

    const fallbackJid = `${cleanPhone}@s.whatsapp.net`;
    try {
      if (this.waSocket && typeof this.waSocket.onWhatsApp === 'function') {
        const checked = await this.waSocket.onWhatsApp(fallbackJid);
        if (checked?.[0]?.exists && checked[0].jid) return checked[0].jid;
        const checkedLid = await this.waSocket.onWhatsApp(`${cleanPhone}@lid`);
        if (checkedLid?.[0]?.exists && checkedLid[0].jid) return checkedLid[0].jid;
      }
    } catch {}
    return fallbackJid;
  }

  async sendManualMessage(targetJid, phone, message) {
    if (!this.isConnected()) {
      const err = new Error('WhatsApp belum connected');
      err.statusCode = 503;
      throw err;
    }
    // Manual send pemilik tidak dibatasi 2 balon (GEMINI.md 7.2)
    const bubbles = this.llm.splitIntoMessages(message);
    const sentIds = [];
    for (let i = 0; i < bubbles.length; i++) {
      if (i > 0) await sleep(getRandomDelay(1500, 2800));
      const sent = await this.sendTrackedMessage(targetJid, { text: bubbles[i] });
      if (sent?.key?.id) sentIds.push(sent.key.id);
      this.contextManager.addMessage(phone, 'assistant', bubbles[i], { manualSend: true });
    }
    return { bubbles: bubbles.length, sentIds };
  }

  queueBurstMessage(entry) {
    let burst = this.pendingBursts.get(entry.remoteJid);
    if (!burst) {
      burst = { items: [], timer: null, processing: false };
      this.pendingBursts.set(entry.remoteJid, burst);
    }
    burst.items.push(entry);
    if (!burst.processing) {
      if (burst.timer) clearTimeout(burst.timer);
      burst.timer = setTimeout(() => this.flushBurst(entry.remoteJid), this.burstWindowMs);
    }
  }

  async flushBurst(remoteJid) {
    const burst = this.pendingBursts.get(remoteJid);
    if (!burst || burst.processing || burst.items.length === 0) return;
    burst.timer = null;
    const batch = burst.items.splice(0, burst.items.length);
    burst.processing = true;

    const signal = { aborted: false };
    let guardTimer = null;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        guardTimer = setTimeout(() => {
          signal.aborted = true;
          reject(new Error(`Batas waktu pemrosesan burst (${this.burstProcessTimeoutMs}ms) terlampaui`));
        }, this.burstProcessTimeoutMs);
      });
      await Promise.race([this.processBurstReply(batch, signal), timeoutPromise]);
    } catch (err) {
      signal.aborted = true;
      this.addLog('error', `Gagal memproses burst dari ${remoteJid}: ${err.message}`);
      try {
        if (this.waSocket) await this.waSocket.sendPresenceUpdate('paused', remoteJid);
      } catch {}
    } finally {
      if (guardTimer) clearTimeout(guardTimer);
      burst.processing = false;
      if (burst.items.length > 0 && !this.isShuttingDown) {
        if (!burst.timer) {
          burst.timer = setTimeout(() => this.flushBurst(remoteJid), this.burstWindowMs);
        }
      } else {
        this.pendingBursts.delete(remoteJid);
      }
    }
  }

  async processBurstReply(batch, signal = { aborted: false }) {
    const latest = batch[batch.length - 1];
    const {
      remoteJid,
      senderJid,
      altJid,
      isGroup,
      historyKey,
      senderPhone,
      senderPushName,
      profile,
      messageText,
      msg
    } = latest;
    const settings = this.settingsStore.getAll();
    const replyAuthJid = isGroup ? senderJid || remoteJid : remoteJid;

    if (!settings.serviceEnabled || !this.contextManager.shouldReply(replyAuthJid, settings.whitelistOnly, altJid)) {
      this.addLog('info', `Burst dari ${profile.name} (${batch.length} pesan) dilewati saat flush (AI nonaktif / bukan whitelist).`);
      return;
    }

    if (!this.isConnected() || signal.aborted) {
      this.addLog('warn', `Burst dari ${profile.name} dilewati karena WhatsApp tidak terhubung atau waktu habis.`);
      return;
    }

    if (batch.length > 1) {
      this.addLog('info', `Burst dari ${profile.name}: ${batch.length} pesan digabung, fokus menjawab pesan terakhir.`);
    }

    await this.waSocket.sendPresenceUpdate('composing', remoteJid);
    const delay = getRandomDelay(this.typingDelayMin, this.typingDelayMax);
    await sleep(delay);
    if (signal.aborted) return;

    // Rekam seluruh pesan dalam batch ke memori TEPAT sebelum merakit prompt
    // agar pesan susulan yang masuk di tengah typing delay tidak mencemari urutan prompt (BUG-01).
    const memoryTargetKey = historyKey || (isGroup ? `group:${remoteJid.replace(/@.*$/, '')}` : senderPhone);
    for (const item of batch) {
      this.contextManager.addMessage(memoryTargetKey, 'user', item.messageText, {
        senderName: item.profile.name,
        pushName: item.senderPushName,
        phone: item.senderPhone,
        category: item.profile.category,
        ...(item.isGroup ? { groupJid: item.remoteJid } : {})
      });
    }

    // Ambil knowledge relevan dengan pagar privasi ketat (DATA-02):
    // - Grup publik: jangan pernah menyuntikkan dokumen pribadi!
    // - Nomor tak terdaftar (saat whitelist nonaktif): jangan bocorkan dokumen universal ('all')!
    const allowUniversalKnowledge = !isGroup && Boolean(profile.isKnown);
    const relevantKnowledge = isGroup
      ? ''
      : this.knowledgeManager.getInjectedKnowledge(profile.category, messageText, {
          allowUniversal: allowUniversalKnowledge
        });

    const focalText = batch.length > 1
      ? `${messageText}\n[Catatan: lawan bicara baru saja mengirim ${batch.length} chat berurutan; chat-chat sebelumnya sudah ada di riwayat di atas dan hanya konteks. Jawab chat terakhir ini saja, jangan membalas chat-chat sebelumnya satu per satu.]`
      : messageText;

    // Gunakan JID pengirim asli untuk resolusi profil & historyKey terpisah untuk grup (BUG-02)
    const promptMessages = this.contextManager.buildPromptMessages(
      replyAuthJid,
      focalText,
      relevantKnowledge,
      senderPushName,
      {
        rawIncomingText: messageText,
        altJid,
        historyKey: memoryTargetKey,
        isGroup: Boolean(isGroup)
      }
    );

    let agentResult = { replyText: '', actions: [], toolCallsLog: [] };
    try {
      agentResult = await this.llm.runAgentLoop(promptMessages, {
        category: profile.category,
        senderPhone,
        senderName: profile.name,
        senderPushName,
        isGroup: Boolean(isGroup),
        allowUniversalKnowledge
      });
    } catch (aiErr) {
      this.addLog('error', `Gagal menjalankan Agent Loop LLM: ${aiErr.message}`);
      try { await this.waSocket.sendPresenceUpdate('paused', remoteJid); } catch {}
      return;
    }

    if (signal.aborted) return;

    const replyText = agentResult.replyText;

    if (agentResult.toolCallsLog && agentResult.toolCallsLog.length > 0) {
      for (const tlog of agentResult.toolCallsLog) {
        // Hindari menyimpan muatan hasil tool penuh (bisa berisi teks dokumen pribadi) di activityLogs (DATA-04)
        this.addLog('info', `🔧 Tool Call [${tlog.name}] -> Args: ${JSON.stringify(tlog.args).slice(0, 120)}`, {
          tool: tlog.name,
          success: tlog.result?.success !== false
        });
      }
    }

    // Maks 2 balon per balasan; tiap balon diawali huruf kapital untuk semua kontak
    const replyBubbles = this.llm
      .splitIntoMessages(replyText, 2)
      .map((b) => this.llm.capitalizeFirstLetter(b));

    const hasStickers = Array.isArray(agentResult.actions) && agentResult.actions.some((a) => a.type === 'send_sticker' && a.filePath);

    if (replyBubbles.length === 0 && !hasStickers) {
      this.addLog('error', `Balasan AI kosong untuk ${profile.name} setelah dibersihkan (pesan: "${messageText.slice(0, 80)}") - tidak ada balasan dikirim.`);
      try { await this.waSocket.sendPresenceUpdate('paused', remoteJid); } catch {}
      return;
    }

    // Tandai terbaca (centang biru) HANYA setelah balasan siap dikirim (PERF-03)
    try {
      const keysToRead = batch.map((item) => item.msg?.key).filter(Boolean);
      if (keysToRead.length > 0) {
        await this.waSocket.readMessages(keysToRead);
      }
    } catch {}

    if (replyBubbles.length > 0) {
      for (let i = 0; i < replyBubbles.length; i++) {
        if (signal.aborted) return;
        const bubbleText = replyBubbles[i];
        if (!bubbleText || bubbleText.trim().length === 0) continue;

        if (i > 0) {
          await this.waSocket.sendPresenceUpdate('composing', remoteJid);
          const interDelay = getRandomDelay(1500, 2800);
          await sleep(interDelay);
          if (signal.aborted) return;
        }

        await this.waSocket.sendPresenceUpdate('paused', remoteJid);
        const sendOptions = i === 0 ? { quoted: msg } : {};
        await this.sendTrackedMessage(remoteJid, { text: bubbleText }, sendOptions);

        this.contextManager.addMessage(memoryTargetKey, 'assistant', bubbleText);

        this.addLog('reply', `Balasan AI [${i + 1}/${replyBubbles.length}] terkirim ke ${profile.name}: "${bubbleText.slice(0, 140)}"`, {
          recipient: profile.name,
          preview: bubbleText.slice(0, 140)
        });
      }
    } else {
      try { await this.waSocket.sendPresenceUpdate('paused', remoteJid); } catch {}
    }

    if (agentResult.actions && agentResult.actions.length > 0) {
      for (const act of agentResult.actions) {
        if (signal.aborted) return;
        if (act.type === 'send_sticker' && act.filePath) {
          try {
            const stickerBuffer = fs.readFileSync(act.filePath);
            await this.sendTrackedMessage(remoteJid, { sticker: stickerBuffer });
            this.addLog('reply', `Stiker [${act.tag}] terkirim ke ${profile.name}`);
            this.contextManager.addMessage(memoryTargetKey, 'assistant', `[Mengirim Stiker: ${act.tag}]`, { systemNote: true });
          } catch (stkErr) {
            this.addLog('error', `Gagal mengirim stiker [${act.tag}]: ${stkErr.message}`);
          }
        }
      }
    }
  }

  async handleMessagesUpsert(m) {
    try {
      const settings = this.settingsStore.getAll();
      if (!settings.serviceEnabled) return;
      const isNotify = m.type === 'notify';
      const isAppend = m.type === 'append';
      if (!isNotify && !isAppend) return;

      const nowSeconds = Math.floor(Date.now() / 1000);

      for (const msg of m.messages) {
        if (!msg.key) continue;

        // 1. Abaikan pesan yang baru saja dikirim bot ini sendiri agar tidak terjadi infinite loop
        if (msg.key.id && this.sentMessageIds.has(msg.key.id)) continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;
        if (remoteJid === 'status@broadcast' || remoteJid.includes('@broadcast')) continue;

        // Untuk event 'append' (sinkronisasi perangkat/offline), hanya terima pesan baru (< 60 detik)
        // dan khusus untuk perintah '!' agar riwayat chat lama tidak pernah diproses ulang.
        if (isAppend) {
          const msgTs = getMessageTimestampSeconds(msg);
          if (!msgTs || Math.abs(nowSeconds - msgTs) > 60) continue;
        }

        const isGroup = remoteJid.endsWith('@g.us');
        const isFromMe =
          Boolean(msg.key.fromMe) ||
          (isGroup &&
            (this.isOwnUserJid(msg.key.participant) || this.isOwnUserJid(msg.key.participantAlt)));
        const normalizedMessage = unwrapWhatsAppMessage(msg.message);

        const isSticker = Boolean(normalizedMessage?.stickerMessage);
        let messageText =
          normalizedMessage?.conversation ||
          normalizedMessage?.extendedTextMessage?.text ||
          normalizedMessage?.imageMessage?.caption ||
          normalizedMessage?.videoMessage?.caption ||
          normalizedMessage?.documentMessage?.caption ||
          '';
        const cleanedText = cleanCommandText(messageText);

        // 2. Jalur khusus pemilik (fromMe: true atau participant cocok dengan akun bot di grup LID):
        //    Boleh menjalankan perintah utilitas (awalan ! maupun .) di chat pribadi, chat ke diri sendiri, maupun grup,
        //    tetapi TIDAK PERNAH masuk ke !acep, !ask, atau balasan otomatis Artificial Intelligence.
        const isRecognizedUtilityCmd = Boolean(parseUtilityCommand(cleanedText));

        if (isFromMe) {
          if (msg.messageStubType && !cleanedText) {
            const stubInfo = Array.isArray(msg.messageStubParameters)
              ? msg.messageStubParameters.join(', ')
              : '';
            const warnText = `[Command] Pesan pemilik (fromMe) di ${remoteJid} belum terbaca/gagal dekripsi (stub ${msg.messageStubType}${stubInfo ? `: ${stubInfo}` : ''}).`;
            console.warn(warnText);
            this.addLog('warn', warnText);
            continue;
          }

          // Pemilik dari ponsel utama boleh menjalankan !acep dan !ask di ruang chat kontak terdaftar (BUG-04)
          if (!isGroup && cleanedText.length > 0 && (parseAskCommand(cleanedText).matched || parseAcepCommand(cleanedText, true).matched)) {
            const ownAltJid = msg.key.remoteJidAlt || msg.key.senderPn || '';
            this.contextManager.recordContactJid(remoteJid, ownAltJid);
            const targetProfile = this.contextManager.getContactProfile(remoteJid, '', ownAltJid);
            if (targetProfile.isKnown) {
              const handledOwnerInstant = await handleInstantCommands({
                waSocket: this.waSocket,
                sendTrackedMessage: (jid, content, opts) => this.sendTrackedMessage(jid, content, opts),
                remoteJid,
                senderPhone: targetProfile.phone,
                senderPushName: 'Pemilik',
                profile: targetProfile,
                fromMe: true,
                messageText: cleanedText,
                msg,
                contextManager: this.contextManager,
                queueDir: this.askQueueDir,
                addLog: this.addLog
              });
              if (handledOwnerInstant) continue;
            } else {
              await this.sendTrackedMessage(
                remoteJid,
                { text: 'Perintah `!acep` dan `!ask` hanya berlaku di ruang chat kontak terdaftar ya.' },
                { quoted: msg }
              );
              continue;
            }
          }

          if (isRecognizedUtilityCmd) {
            await handleUtilityCommands({
              waSocket: this.waSocket,
              sendTrackedMessage: (jid, content, opts) => this.sendTrackedMessage(jid, content, opts),
              downloadMediaBuffer: (target) => this.downloadMediaBuffer(target),
              isOwnUserJid: (jid) => this.isOwnUserJid(jid),
              isOwnMessageId: (id) => Boolean(id && this.sentMessageIds.has(id)),
              remoteJid,
              senderKey: 'owner',
              fromMe: true,
              isGroup,
              profile: { isKnown: true, name: 'Pemilik' },
              messageText: cleanedText,
              msg,
              normalizedMessage,
              toolRegistry: this.toolRegistry,
              llm: this.llm,
              antiSpamGuard: this.commandAntiSpam,
              addLog: this.addLog
            });
          }
          continue;
        }

        // 3. Jalur perintah utilitas di GRUP untuk anggota lain (tetap mematikan AI auto-reply grup
        //    jika settings.replyGroups == false, dan dilindungi anti-spam per-grup + per-pengirim).
        if (isGroup) {
          const allowGroupCommands = process.env.ALLOW_GROUP_COMMANDS !== 'false';
          if (allowGroupCommands && isRecognizedUtilityCmd) {
            const groupSenderJid = msg.key.participant || remoteJid;
            const groupSenderAlt = msg.key.participantAlt || '';
            const groupSenderProfile = this.contextManager.getContactProfile(
              groupSenderJid,
              msg.pushName || '',
              groupSenderAlt
            );
            const groupSenderKey =
              groupSenderProfile.phone || groupSenderJid || remoteJid;

            const handledGroupUtility = await handleUtilityCommands({
              waSocket: this.waSocket,
              sendTrackedMessage: (jid, content, opts) => this.sendTrackedMessage(jid, content, opts),
              downloadMediaBuffer: (target) => this.downloadMediaBuffer(target),
              isOwnUserJid: (jid) => this.isOwnUserJid(jid),
              isOwnMessageId: (id) => Boolean(id && this.sentMessageIds.has(id)),
              remoteJid,
              senderKey: groupSenderKey,
              fromMe: false,
              isGroup: true,
              profile: groupSenderProfile,
              messageText: cleanedText,
              msg,
              normalizedMessage,
              toolRegistry: this.toolRegistry,
              llm: this.llm,
              antiSpamGuard: this.commandAntiSpam,
              addLog: this.addLog
            });
            if (handledGroupUtility) continue;
          }

          // Balasan otomatis AI dan !acep/!ask tetap menghormati pengaturan replyGroups
          if (!settings.replyGroups) continue;
        }

        if (!isSticker && (!cleanedText || cleanedText.length === 0)) continue;

        // Event 'append' lawan bicara hanya boleh memicu perintah (! / .), bukan balasan AI biasa
        if (isAppend && !cleanedText.startsWith('!') && !isRecognizedUtilityCmd) continue;

        const senderJid = isGroup ? msg.key.participant || remoteJid : remoteJid;
        const altJid = isGroup ? msg.key.participantAlt || '' : msg.key.remoteJidAlt || msg.key.senderPn || '';
        const senderPushName = msg.pushName || '';
        if (!isGroup) {
          this.contextManager.recordContactJid(remoteJid, altJid);
        }
        const profile = this.contextManager.getContactProfile(senderJid, senderPushName, altJid);
        const senderPhone = profile.phone;
        const historyKey = isGroup ? `group:${remoteJid.replace(/@.*$/, '')}` : senderPhone;

        // 3a. Evaluasi perintah instan bawaan (!ask dan !acep) SEBELUM gate whitelist & vision stiker
        if (cleanedText.length > 0) {
          const handled = await handleInstantCommands({
            waSocket: this.waSocket,
            sendTrackedMessage: (jid, content, opts) => this.sendTrackedMessage(jid, content, opts),
            remoteJid,
            senderPhone,
            senderPushName,
            profile,
            fromMe: false,
            messageText: cleanedText,
            msg,
            contextManager: this.contextManager,
            queueDir: this.askQueueDir,
            addLog: this.addLog
          });
          if (handled) continue;

          // 3b. Evaluasi perintah utilitas umum di chat pribadi
          //     (terbuka untuk semua lawan bicara dengan perlindungan anti-spam WhatsApp berlapis)
          if (!isGroup) {
            const handledUtility = await handleUtilityCommands({
              waSocket: this.waSocket,
              sendTrackedMessage: (jid, content, opts) => this.sendTrackedMessage(jid, content, opts),
              downloadMediaBuffer: (target) => this.downloadMediaBuffer(target),
              isOwnUserJid: (jid) => this.isOwnUserJid(jid),
              isOwnMessageId: (id) => Boolean(id && this.sentMessageIds.has(id)),
              remoteJid,
              senderKey: senderPhone || remoteJid,
              fromMe: false,
              isGroup: false,
              profile,
              messageText: cleanedText,
              msg,
              normalizedMessage,
              toolRegistry: this.toolRegistry,
              llm: this.llm,
              antiSpamGuard: this.commandAntiSpam,
              addLog: this.addLog
            });
            if (handledUtility) continue;
          }
        }

        // Jangan teruskan event 'append' ke balasan otomatis Artificial Intelligence
        if (isAppend) continue;

        const allowed = this.contextManager.shouldReply(senderJid, settings.whitelistOnly, altJid);
        if (!allowed) {
          const skipText = isSticker ? '[Lawan bicara mengirim stiker WhatsApp]' : messageText;
          // Hindari menyimpan isi lengkap pesan kontak saat AI OFF di activityLogs (DATA-04)
          this.addLog('info', `Pesan dari ${profile.name} (${senderPhone}) dilewati (AI nonaktif / bukan whitelist).`, {
            sender: profile.name,
            phone: senderPhone
          });
          if (!isGroup && (profile.category === 'pacar' || profile.category === 'teman_dekat')) {
            this.contextManager.addMessage(senderPhone, 'user', skipText, {
              senderName: profile.name,
              pushName: senderPushName,
              phone: senderPhone,
              category: profile.category,
              skippedWhileAiOff: true
            });
          }
          continue;
        }

        // Unduh & analisis visual stiker hanya untuk kontak yang diizinkan dan ukuran <= 2 Megabyte (SEC-05)
        if (isSticker) {
          let stickerDescription = '';
          const declaredStickerBytes = parseFileLength(normalizedMessage?.stickerMessage?.fileLength);
          if (declaredStickerBytes > MAX_AUTO_VISION_STICKER_BYTES) {
            this.addLog('warn', `Stiker dari ${profile.name} melewati batas 2 Megabyte (${declaredStickerBytes} byte); dilewati dari analisis Vision.`);
          } else {
            try {
              const stickerBuffer = await this.downloadMediaBuffer(msg);
              if (stickerBuffer && stickerBuffer.length > 0 && stickerBuffer.length <= MAX_AUTO_VISION_STICKER_BYTES) {
                stickerDescription = await this.llm.describeImage(stickerBuffer, 'image/webp');
              }
            } catch (dlErr) {
              console.warn('[Sticker Download Warning]:', dlErr.message);
            }
          }

          if (stickerDescription) {
            messageText = `[Lawan bicara mengirim stiker WhatsApp: "${stickerDescription}"]`;
            this.addLog('info', `🖼️ Stiker Terdeteksi Visual: "${stickerDescription.slice(0, 120)}"`);
          } else {
            messageText = '[Lawan bicara mengirim stiker WhatsApp]';
          }
        }

        if (!messageText || messageText.trim().length === 0) continue;

        this.addLog('incoming', `Pesan Masuk dari ${profile.name} [${senderPushName || senderPhone}]: "${messageText.slice(0, 140)}"`, {
          sender: profile.name,
          pushName: senderPushName,
          phone: senderPhone,
          category: profile.category
        });

        // Pencatatan ke chat_memory dilakukan saat batch diproses di processBurstReply (BUG-01)
        this.queueBurstMessage({
          remoteJid,
          senderJid,
          altJid,
          isGroup,
          historyKey,
          senderPhone,
          senderPushName,
          profile,
          messageText,
          msg
        });
      }
    } catch (err) {
      this.addLog('error', `Error processing message: ${err.message}`);
    }
  }

  shutdown() {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, burst] of this.pendingBursts.entries()) {
      if (burst.timer) clearTimeout(burst.timer);
    }
    this.pendingBursts.clear();
    this.cleanupPreviousSocket();
  }
}

BaileysService.createFilteredBaileysLogger = createFilteredBaileysLogger;
BaileysService.shouldSuppressBaileysLog = shouldSuppressBaileysLog;
BaileysService.formatCleanBaileysLog = formatCleanBaileysLog;

module.exports = BaileysService;
