/**
 * Another Me - Personal AI WhatsApp Auto-Reply & Web Dashboard
 * Baileys + Universal OpenAI-compatible LLM Client + Express Dashboard Control
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');

const LLMClient = require('./src/llmClient');
const ContextManager = require('./src/contextManager');
const KnowledgeManager = require('./src/knowledgeManager');
const ToolRegistry = require('./src/tools/toolRegistry');

// Inisialisasi komponen
const llm = new LLMClient();
const contextManager = new ContextManager();
const knowledgeManager = new KnowledgeManager();
const toolRegistry = new ToolRegistry({ knowledgeManager });

// Tautkan Tool Registry ke LLM Agent Harness
llm.setToolRegistry(toolRegistry);

const logger = pino({ level: 'silent' });
const authPath = path.resolve(__dirname, 'auth_info_baileys');

// Konfigurasi Environment & State
let SERVICE_ENABLED = true;
let WHITELIST_ONLY = process.env.WHITELIST_ONLY === 'true';
let REPLY_GROUPS = process.env.REPLY_GROUPS === 'true';
const TYPING_DELAY_MIN = parseInt(process.env.TYPING_DELAY_MIN, 10) || 2000;
const TYPING_DELAY_MAX = parseInt(process.env.TYPING_DELAY_MAX, 10) || 4500;
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Persistensi Pengaturan Bot (Settings Persistence)
const settingsFile = path.resolve(__dirname, 'data/settings.json');

function loadPersistedSettings() {
  try {
    if (!fs.existsSync(settingsFile)) {
      const exampleFile = path.resolve(__dirname, 'data/settings.example.json');
      if (fs.existsSync(exampleFile)) {
        fs.copyFileSync(exampleFile, settingsFile);
      }
    }
    if (fs.existsSync(settingsFile)) {
      const data = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (typeof data.serviceEnabled === 'boolean') SERVICE_ENABLED = data.serviceEnabled;
      if (typeof data.whitelistOnly === 'boolean') WHITELIST_ONLY = data.whitelistOnly;
      if (typeof data.replyGroups === 'boolean') REPLY_GROUPS = data.replyGroups;
    }
  } catch (err) {
    console.warn('[Settings] Gagal memuat settings.json:', err.message);
  }
}

function savePersistedSettings() {
  try {
    const payload = {
      serviceEnabled: SERVICE_ENABLED,
      whitelistOnly: WHITELIST_ONLY,
      replyGroups: REPLY_GROUPS,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(settingsFile, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Settings] Gagal menyimpan settings.json:', err.message);
  }
}

// Muat pengaturan terakhir yang disimpan
loadPersistedSettings();

let waSocket = null;
let connectionStatus = 'connecting'; // 'connecting', 'qr_ready', 'connected', 'disconnected'
let currentQR = null;
let lastDisconnectReason = null;
const activityLogs = [];

function addLog(type, text, meta = null) {
  const logItem = {
    id: Date.now() + Math.random().toString(36).substring(2, 5),
    time: new Date().toLocaleTimeString('id-ID', { hour12: false }),
    type,
    text,
    meta
  };
  activityLogs.unshift(logItem);
  if (activityLogs.length > 100) activityLogs.pop();
}

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startWhatsApp() {
  connectionStatus = 'connecting';
  currentQR = null;
  addLog('info', 'Memulai inisialisasi koneksi WhatsApp...');

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: state,
      browser: ['Another Me AI', 'Desktop', '1.0.0'],
      syncFullHistory: false
    });

    waSocket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        connectionStatus = 'qr_ready';
        qrcode.generate(qr, { small: true });
        addLog('warn', 'QR Code siap di-scan di terminal atau Dashboard Web.');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionStatus = 'disconnected';
        lastDisconnectReason = statusCode;
        addLog('error', `Koneksi terputus (Status: ${statusCode}). Reconnect: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(startWhatsApp, 3000);
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        currentQR = null;
        addLog('info', '✅ WhatsApp Berhasil Terhubung! Bot Another Me aktif.');
      }
    });

    waSocket.ev.on('creds.update', saveCreds);

    waSocket.ev.on('messages.upsert', async (m) => {
      try {
        if (!SERVICE_ENABLED) return;
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
          if (!msg.key) continue;
          if (msg.key.fromMe) continue; // Abaikan pesan diri sendiri

          const remoteJid = msg.key.remoteJid;
          if (!remoteJid) continue;
          if (remoteJid === 'status@broadcast' || remoteJid.includes('@broadcast')) continue;

          const isGroup = remoteJid.endsWith('@g.us');
          if (isGroup && !REPLY_GROUPS) continue;

          const isSticker = Boolean(msg.message?.stickerMessage);
          let messageText =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';

          let stickerDescription = '';
          if (isSticker) {
            try {
              // Unduh buffer gambar stiker asli dari server WhatsApp
              const stickerBuffer = await downloadMediaMessage(
                msg,
                'buffer',
                {},
                {
                  logger,
                  reuploadRequest: waSocket.updateMediaMessage
                }
              );

              if (stickerBuffer && stickerBuffer.length > 0) {
                // Analisis visual stiker via Vision LLM
                stickerDescription = await llm.describeImage(stickerBuffer, 'image/webp');
              }
            } catch (dlErr) {
              console.warn('[Sticker Download Warning]:', dlErr.message);
            }

            if (stickerDescription) {
              messageText = `[Lawan bicara mengirim stiker WhatsApp: "${stickerDescription}"]`;
              addLog('info', `🖼️ Stiker Terdeteksi Visual: "${stickerDescription}"`);
            } else {
              messageText = '[Lawan bicara mengirim stiker WhatsApp]';
            }
          }

          if (!messageText || messageText.trim().length === 0) continue;

          const senderPhone = remoteJid.replace(/@.*$/, '').replace(/\D/g, '');
          const senderPushName = msg.pushName || '';
          const profile = contextManager.getContactProfile(remoteJid, senderPushName);

          // Evaluasi aturan whitelist & toggle kontak
          const allowed = contextManager.shouldReply(remoteJid, WHITELIST_ONLY);
          if (!allowed) {
            addLog('info', `Pesan dari ${profile.name} (${senderPhone}) dilewati (AI nonaktif / bukan whitelist).`, {
              sender: profile.name,
              pushName: senderPushName,
              phone: senderPhone,
              message: messageText
            });
            continue;
          }

          addLog('incoming', `Pesan Masuk dari ${profile.name} [${senderPushName || senderPhone}]: "${messageText}"`, {
            sender: profile.name,
            pushName: senderPushName,
            phone: senderPhone,
            category: profile.category
          });

          // Simpan pesan lawan bicara beserta metadata sender ke riwayat percakapan
          contextManager.addMessage(senderPhone, 'user', messageText, {
            senderName: profile.name,
            pushName: senderPushName,
            phone: senderPhone,
            category: profile.category
          });

          // Tandai sudah dibaca
          await waSocket.readMessages([msg.key]);

          // Tampilkan status "sedang mengetik..."
          await waSocket.sendPresenceUpdate('composing', remoteJid);
          const delay = getRandomDelay(TYPING_DELAY_MIN, TYPING_DELAY_MAX);
          await sleep(delay);

          // Ambil knowledge base yang relevan untuk kategori ini
          const relevantKnowledge = knowledgeManager.getInjectedKnowledge(profile.category);

          // Generate respons via LLM Agent Harness (Function Calling Loop) dengan metadata pengirim
          const promptMessages = contextManager.buildPromptMessages(remoteJid, messageText, relevantKnowledge, senderPushName);
          let agentResult = { replyText: '', actions: [], toolCallsLog: [] };

          try {
            agentResult = await llm.runAgentLoop(promptMessages, {
              category: profile.category,
              senderPhone,
              senderName: profile.name,
              senderPushName
            });
          } catch (aiErr) {
            addLog('error', `Gagal menjalankan Agent Loop LLM: ${aiErr.message}`);
            await waSocket.sendPresenceUpdate('paused', remoteJid);
            continue;
          }

          const replyText = agentResult.replyText;

          // Catat pemanggilan tools di log aktivitas jika ada
          if (agentResult.toolCallsLog && agentResult.toolCallsLog.length > 0) {
            for (const tlog of agentResult.toolCallsLog) {
              addLog('info', `🔧 Tool Call [${tlog.name}] -> Args: ${JSON.stringify(tlog.args)}`, {
                tool: tlog.name,
                result: tlog.result
              });
            }
          }

          // Kirim balasan teks (mendukung multi-bubble beruntun)
          const replyBubbles = llm.splitIntoMessages(replyText);

          if (replyBubbles.length > 0) {
            for (let i = 0; i < replyBubbles.length; i++) {
              const bubbleText = replyBubbles[i];
              if (!bubbleText || bubbleText.trim().length === 0) continue;

              // Jika bukan chat pertama, beri jeda mengetik singkat antar balon chat
              if (i > 0) {
                await waSocket.sendPresenceUpdate('composing', remoteJid);
                const interDelay = getRandomDelay(1500, 2800);
                await sleep(interDelay);
              }

              await waSocket.sendPresenceUpdate('paused', remoteJid);
              // Untuk bubble pertama bisa di-quote ke pesan pengirim, bubble selanjutnya dikirim langsung
              const sendOptions = i === 0 ? { quoted: msg } : {};
              await waSocket.sendMessage(remoteJid, { text: bubbleText }, sendOptions);

              // Simpan ke riwayat memori
              contextManager.addMessage(senderPhone, 'assistant', bubbleText);

              addLog('reply', `Balasan AI [${i + 1}/${replyBubbles.length}] terkirim ke ${profile.name}: "${bubbleText}"`, {
                recipient: profile.name,
                reply: bubbleText
              });
            }
          }

          // Eksekusi actions lanjutan dari tools (misal: pengiriman stiker)
          if (agentResult.actions && agentResult.actions.length > 0) {
            for (const act of agentResult.actions) {
              if (act.type === 'send_sticker' && act.filePath) {
                try {
                  const stickerBuffer = fs.readFileSync(act.filePath);
                  await waSocket.sendMessage(remoteJid, { sticker: stickerBuffer });
                  addLog('reply', `Stiker [${act.tag}] terkirim ke ${profile.name}`);
                  contextManager.addMessage(senderPhone, 'assistant', `[Mengirim Stiker: ${act.tag}]`);
                } catch (stkErr) {
                  addLog('error', `Gagal mengirim stiker [${act.tag}]: ${stkErr.message}`);
                }
              }
            }
          }
        }
      } catch (err) {
        addLog('error', `Error processing message: ${err.message}`);
      }
    });
  } catch (err) {
    addLog('error', `Inisialisasi Baileys gagal: ${err.message}`);
  }
}

// ----------------------------------------------------
// Express API & Dashboard Server
// ----------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname, 'public')));

// Konfigurasi Multer untuk upload dokumen & stiker
const multer = require('multer');
const upload = multer({ dest: path.resolve(__dirname, 'uploads') });

// Serve static stickers directly
app.use('/stickers', express.static(path.resolve(__dirname, 'data/stickers')));

// Status API
app.get('/api/status', async (req, res) => {
  const llmHealth = await llm.checkHealth();
  res.json({
    whatsapp: {
      status: connectionStatus,
      qrAvailable: Boolean(currentQR),
      qr: currentQR
    },
    llm: {
      baseUrl: llm.baseUrl,
      model: llm.model,
      visionModel: llm.visionModel || null,
      hasApiKey: Boolean(llm.apiKey),
      connected: llmHealth.connected,
      message: llmHealth.message || null
    },
    settings: {
      serviceEnabled: SERVICE_ENABLED,
      whitelistOnly: WHITELIST_ONLY,
      replyGroups: REPLY_GROUPS,
      totalContacts: Object.keys(contextManager.contacts).length,
      totalKnowledge: knowledgeManager.registry.length,
      totalStickers: toolRegistry.executeGetAvailableStickers().total || 0,
      toolsAvailable: toolRegistry.getToolDefinitions().map(t => t.function.name)
    }
  });
});

// Toggle Master Service ON/OFF
app.post('/api/settings/toggle-service', (req, res) => {
  SERVICE_ENABLED = !SERVICE_ENABLED;
  savePersistedSettings();
  addLog('info', `Service Auto-Reply WhatsApp diubah menjadi: ${SERVICE_ENABLED ? 'AKTIF (ON)' : 'NONAKTIF (OFF)'}`);
  res.json({ success: true, serviceEnabled: SERVICE_ENABLED });
});

// Update LLM Config Langsung dari Web
app.post('/api/settings/llm', async (req, res) => {
  const { baseUrl, apiKey, model, visionModel } = req.body;
  llm.updateConfig({ baseUrl, apiKey, model, visionModel });
  const health = await llm.checkHealth();
  addLog('info', `Konfigurasi LLM diperbarui: Chat [${llm.model}], Vision [${llm.visionModel || llm.model}] @ ${llm.baseUrl}`);
  res.json({
    success: true,
    llm: {
      baseUrl: llm.baseUrl,
      model: llm.model,
      visionModel: llm.visionModel || null,
      connected: health.connected,
      message: health.message || null
    }
  });
});

// Toggle Whitelist Mode Global
app.post('/api/settings/toggle-whitelist', (req, res) => {
  WHITELIST_ONLY = !WHITELIST_ONLY;
  savePersistedSettings();
  addLog('info', `Mode Whitelist diubah menjadi: ${WHITELIST_ONLY ? 'AKTIF' : 'NONAKTIF'}`);
  res.json({ success: true, whitelistOnly: WHITELIST_ONLY });
});

// Toggle Reply Groups
app.post('/api/settings/toggle-groups', (req, res) => {
  REPLY_GROUPS = !REPLY_GROUPS;
  savePersistedSettings();
  addLog('info', `Balas Grup diubah menjadi: ${REPLY_GROUPS ? 'AKTIF' : 'NONAKTIF'}`);
  res.json({ success: true, replyGroups: REPLY_GROUPS });
});

// Contacts CRUD
app.get('/api/contacts', (req, res) => {
  res.json({
    contacts: contextManager.contacts,
    categories: Object.keys(contextManager.persona.categories || {})
  });
});

// ==========================================
// PERSONA CRUD API
// ==========================================
app.get('/api/persona', (req, res) => {
  res.json(contextManager.getPersonaData());
});

app.post('/api/persona/general', (req, res) => {
  const { identity, core_typing_rules } = req.body;
  const updated = contextManager.updateGeneralPersona({ identity, core_typing_rules });
  addLog('info', 'Persona umum (identitas & aturan ketik) diperbarui.');
  res.json({ success: true, general_persona: updated });
});

app.post('/api/persona/category', (req, res) => {
  const { categoryKey, tone, vocabulary, guidelines, few_shots } = req.body;
  if (!categoryKey) return res.status(400).json({ error: 'Nama kategori wajib diisi' });

  const updated = contextManager.updateCategoryPersona(categoryKey, {
    tone,
    vocabulary,
    guidelines,
    few_shots
  });
  addLog('info', `Kategori persona '${categoryKey}' diperbarui.`);
  res.json({ success: true, category: updated });
});

app.delete('/api/persona/category/:key', (req, res) => {
  const { key } = req.params;
  const deleted = contextManager.deleteCategoryPersona(key);
  if (deleted) {
    addLog('info', `Kategori persona '${key}' dihapus.`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Kategori tidak ditemukan' });
  }
});

// ==========================================
// KNOWLEDGE BASE API (MULTI-FORMAT)
// ==========================================
app.get('/api/knowledge', (req, res) => {
  res.json({ documents: knowledgeManager.registry });
});

app.post('/api/knowledge/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File tidak ditemukan' });
    }
    const { title, category } = req.body;
    const doc = await knowledgeManager.addDocument({
      title: title || req.file.originalname,
      originalName: req.file.originalname,
      tempFilePath: req.file.path,
      category: category || 'all'
    });

    // Hapus file temporary di uploads/
    try { fs.unlinkSync(req.file.path); } catch {}

    addLog('info', `Knowledge berhasil diinject: "${doc.title}" (${doc.fileType})`);
    res.json({ success: true, document: doc });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/knowledge/snippet', (req, res) => {
  try {
    const { title, content, category } = req.body;
    const doc = knowledgeManager.addTextSnippet({ title, content, category });
    addLog('info', `Snippet knowledge ditambahkan: "${doc.title}"`);
    res.json({ success: true, document: doc });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/knowledge/:id/toggle', (req, res) => {
  const { id } = req.params;
  const state = knowledgeManager.toggleDocument(id);
  if (state !== null) {
    res.json({ success: true, enabled: state });
  } else {
    res.status(404).json({ error: 'Dokumen tidak ditemukan' });
  }
});

app.delete('/api/knowledge/:id', (req, res) => {
  const { id } = req.params;
  const deleted = knowledgeManager.deleteDocument(id);
  if (deleted) {
    addLog('info', `Knowledge ${id} dihapus`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Dokumen tidak ditemukan' });
  }
});

app.post('/api/contacts', (req, res) => {
  const { phone, oldPhone, name, category, enabled, notes } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Nomor telepon wajib diisi' });
  }
  const updated = contextManager.upsertContact(phone, { name, category, enabled, notes }, oldPhone);
  addLog('info', `Kontak disimpan: ${name || phone} (${category || 'default'})`);
  res.json({ success: true, contact: updated });
});

app.post('/api/contacts/:phone/toggle', (req, res) => {
  const { phone } = req.params;
  const newState = contextManager.toggleContactStatus(phone);
  addLog('info', `Status AI untuk ${phone} diubah menjadi: ${newState ? 'AKTIF' : 'NONAKTIF'}`);
  res.json({ success: true, enabled: newState });
});

app.delete('/api/contacts/:phone', (req, res) => {
  const { phone } = req.params;
  const deleted = contextManager.deleteContact(phone);
  if (deleted) {
    addLog('info', `Kontak ${phone} dihapus`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Kontak tidak ditemukan' });
  }
});

// ==========================================
// STICKERS MANAGEMENT API
// ==========================================
app.get('/api/stickers', (req, res) => {
  const result = toolRegistry.executeGetAvailableStickers();
  res.json(result);
});

app.post('/api/stickers/upload', upload.single('sticker'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File stiker tidak ditemukan' });
    const tag = (req.body.tag || path.basename(req.file.originalname, path.extname(req.file.originalname)))
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_');

    const destFileName = `${tag}.webp`;
    const destPath = path.join(toolRegistry.stickersDir, destFileName);

    // Pindahkan file ke direktori stickers
    fs.renameSync(req.file.path, destPath);
    addLog('info', `Stiker baru ditambahkan: "${destFileName}"`);
    res.json({ success: true, fileName: destFileName, tag });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/stickers/:fileName', (req, res) => {
  const { fileName } = req.params;
  const targetPath = path.join(toolRegistry.stickersDir, path.basename(fileName));
  if (fs.existsSync(targetPath)) {
    try {
      fs.unlinkSync(targetPath);
      addLog('info', `Stiker ${fileName} dihapus`);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } else {
    res.status(404).json({ error: 'File stiker tidak ditemukan' });
  }
});

// ==========================================
// SIMULATION & TRAINING ROOM API
// ==========================================
app.post('/api/simulation/chat', async (req, res) => {
  try {
    const { message, category, customContext, history } = req.body;
    if (!message) return res.status(400).json({ error: 'Pesan simulasi tidak boleh kosong' });

    const simCategory = category || 'default';
    const relevantKnowledge = knowledgeManager.getInjectedKnowledge(simCategory);

    // Bangun prompt simulasi
    const profile = {
      phone: 'SIMULATION_USER',
      name: `Penguji Simulasi (${simCategory})`,
      category: simCategory,
      notes: customContext || 'Sesi latihan dan pengujian persona AI'
    };

    const categoryKey = contextManager.persona.categories[simCategory] ? simCategory : 'default';
    const catConfig = contextManager.persona.categories[categoryKey] || {};
    const general = contextManager.persona.general_persona || {};
    const availableStickers = contextManager.getAvailableStickersList();

    const systemInstructions = [
      general.identity || 'Kamu adalah representasi digital diri saya (Another Me). Balas chat seperti gaya asli saya mengetik di WhatsApp.',
      '',
      '--- MODE LATIHAN / SIMULASI SANDBOX ---',
      'Ini adalah sesi pengujian dan pelatihan. Jawab sesuai persona kategori yang dipilih seolah-olah kamu sedang membalas di WhatsApp aslinya.',
      '',
      '--- ATURAN UMUM PENGETIKAN ---',
      ...(general.core_typing_rules || []).map((r) => `- ${r}`),
      '',
      `--- KONTEKS LAWAN BICARA (SIMULASI) ---`,
      `- Peran Lawan Bicara: ${profile.name}`,
      `- Kategori Relasi: ${categoryKey}`,
      profile.notes ? `- Catatan Skenario: ${profile.notes}` : '',
      catConfig.tone ? `- Nada Bicara / Sikap: ${catConfig.tone}` : '',
      catConfig.guidelines ? `- Panduan Perilaku: ${catConfig.guidelines}` : '',
      catConfig.vocabulary && catConfig.vocabulary.length ? `- Kata-kata khas / Panggilan yang sering dipakai: ${catConfig.vocabulary.join(', ')}` : '',
      '',
      relevantKnowledge ? `--- BASIS PENGETAHUAN PRIBADI (KNOWLEDGE BASE) ---\n${relevantKnowledge}\n` : '',
      '--- KEBIASAAN PENGIRIMAN STIKER (PRIORITAS EKSPRESI) ---',
      'Sebagai "Another Me", kamu sangat ekspresif dan sering menggunakan stiker WhatsApp dalam chatting sehari-hari.',
      'SETIAP KALI membalas pesan, SELALU PERTIMBANGKAN mood, nada emosi, atau topik chat saat ini (apakah lucu, tertawa, manja, kangen, lelah, gemes, ngambek bercanda, atau menyindir santai).',
      availableStickers.length > 0
        ? `Stiker yang kamu miliki di koleksi:\n[ ${availableStickers.join(', ')} ]\nJika suasana percakapan cocok dengan salah satu stiker di atas, PANGGIL tool "send_sticker" dengan tag stiker tersebut bersama balasan teksmu. Jangan ragu mengirim stiker agar percakapan terasa hidup dan natural!`
        : 'Jika belum ada stiker di koleksi, cukup balas dengan teks.',
      '',
      '--- ATURAN PENGIRIMAN MULTI-CHAT (MULTI-BUBBLE) ---',
      'Pisahkan setiap balon chat terpisah dengan penanda garis tiga: "---".',
      '',
      '--- PENTING ---',
      'Hanya hasilkan teks balasan WhatsApp tanpa format kode, tanpa penjelasan, dan tanpa dialog ganda.'
    ].filter(Boolean).join('\n');

    const promptMessages = [{ role: 'system', content: systemInstructions }];

    // Tambahkan few shots jika ada
    if (Array.isArray(catConfig.few_shots) && catConfig.few_shots.length > 0) {
      for (const shot of catConfig.few_shots) {
        if (shot.user && shot.reply) {
          promptMessages.push({ role: 'user', content: shot.user });
          promptMessages.push({ role: 'assistant', content: shot.reply });
        }
      }
    }

    // Tambahkan histori simulasi sementara
    if (Array.isArray(history)) {
      for (const h of history) {
        if (h.role && h.content) {
          promptMessages.push({ role: h.role, content: h.content });
        }
      }
    }

    // Pesan simulasi saat ini
    promptMessages.push({ role: 'user', content: message });

    // Eksekusi agent loop (bisa panggil tool waktu/cuaca/stiker/knowledge)
    const agentResult = await llm.runAgentLoop(promptMessages, {
      category: simCategory,
      senderPhone: 'SIMULATION_USER'
    });

    addLog('info', `🧪 Simulasi [${simCategory}]: "${message}" -> "${agentResult.replyText}"`);

    const replyBubbles = llm.splitIntoMessages(agentResult.replyText);

    res.json({
      success: true,
      replyText: agentResult.replyText,
      replyBubbles: replyBubbles,
      toolCallsLog: agentResult.toolCallsLog || [],
      actions: agentResult.actions || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint untuk AI Menginterpretasi Sesi Obrolan Berdasarkan Jawaban Sempurna Pemilik
app.post('/api/simulation/interpret', async (req, res) => {
  try {
    const { category, userMessage, aiReply, perfectReply, history, scenarioContext } = req.body;
    if (!userMessage && (!history || history.length === 0)) {
      return res.status(400).json({ error: 'Tidak ada data percakapan untuk diinterpretasi' });
    }

    const conversationSnippet = (history && history.length > 0)
      ? history.map(h => `${h.role === 'user' ? 'Lawan Bicara' : 'Respon Awal AI'}: ${h.content}`).join('\n')
      : `Lawan Bicara: ${userMessage}\nRespon Awal AI: ${aiReply}`;

    const safePerfect = (perfectReply || '').trim();

    const promptText = `Kamu adalah AI evaluator dan trainer untuk asisten pribadi WhatsApp "Another Me".
Pemilik asli baru saja memberikan "Jawaban Sempurna Menurut Pemilik" sebagai koreksi terhadap respon AI pada simulasi berikut.

KATEGORI RELASI: ${category || 'default'}
${scenarioContext ? `SKENARIO KONTEKS: ${scenarioContext}` : ''}

DIALOG SIMULASI:
${conversationSnippet}

${safePerfect ? `JAWABAN SEMPURNA / KOREKSI DARI PEMILIK ASLI:
"${safePerfect}"` : `RESPON AI SAAT INI:
"${aiReply}"`}

Tugasmu sebagai AI:
Pelajari jawaban sempurna dari pemilik asli tersebut ("Ohhh, jadi jawabannya harusnya kayak gitu!").
1. Buat "pelajaran_knowledge": Rumuskan 1-2 kalimat fakta spesifik, preferensi pribadi, atau aturan perilaku yang tersirat dari jawaban pemilik tersebut agar diserap ke Knowledge Base (misal: "Jika ditanya X, saya lebih suka merespons dengan santai Y", atau fakta/kebiasaan baru yang terungkap).
2. Buat "refleksi_pemahaman": 1-2 kalimat refleksi bagaimana kamu sebagai AI menyadari perbedaan gaya atau kesalahan pemahaman respon sebelumnya dibanding jawaban pemilik asli.

KEMBALIKAN HANYA JSON MURNI DENGAN FORMAT:
{
  "pelajaran_knowledge": "...",
  "refleksi_pemahaman": "..."
}`;

    const endpoint = `${llm.baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (llm.apiKey) headers['Authorization'] = `Bearer ${llm.apiKey}`;

    const payload = {
      model: llm.model,
      messages: [{ role: 'user', content: promptText }],
      temperature: 0.3,
      max_tokens: 400
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`LLM Error (${response.status}): ${await response.text()}`);
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content || '{}';

    const safeUserMsg = userMessage || (history && history.length > 0 ? history[history.length - 1].content : '') || 'Percakapan';

    let parsed = {};
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {}
    }

    if (!parsed || Object.keys(parsed).length === 0) {
      parsed = {
        pelajaran_knowledge: `Pelajaran dari jawaban sempurna: saat lawan bicara menyampaikan topik ini, gunakan gaya bahasa yang lebih santai dan autentik untuk kategori ${category || 'default'}.`,
        refleksi_pemahaman: 'AI memahami bahwa jawaban yang diberikan pemilik lebih alami dan sesuai konteks.'
      };
    }

    res.json({
      success: true,
      interpretation: {
        lesson: parsed.pelajaran_knowledge || '',
        correction: safePerfect || aiReply || '',
        analysis: parsed.refleksi_pemahaman || ''
      }
    });
  } catch (err) {
    console.error('[Interpret Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload & Uji Vision Stiker di Training Room
app.post('/api/simulation/describe-sticker', upload.single('sticker'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File stiker tidak ditemukan' });
    const buffer = fs.readFileSync(req.file.path);
    const desc = await llm.describeImage(buffer, 'image/webp');
    try { fs.unlinkSync(req.file.path); } catch {}
    res.json({ success: true, description: desc || 'Stiker tidak dapat diinterpretasi' });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: err.message });
  }
});

// Menyimpan hasil review simulasi langsung ke Knowledge Base
app.post('/api/simulation/learn/knowledge', (req, res) => {
  try {
    const { title, lesson, category } = req.body;
    if (!lesson) return res.status(400).json({ error: 'Catatan pelajaran/fakta tidak boleh kosong' });

    const docTitle = title || `Pelajaran Simulasi (${new Date().toLocaleDateString('id-ID')})`;
    const doc = knowledgeManager.addTextSnippet({
      title: docTitle,
      content: lesson,
      category: category || 'all'
    });

    addLog('info', `💡 Hasil review simulasi diserap ke Knowledge Base: "${doc.title}"`);
    res.json({ success: true, document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Menyimpan contoh dialog simulasi langsung ke Few-Shot Persona
app.post('/api/simulation/learn/fewshot', (req, res) => {
  try {
    const { category, userMessage, approvedReply } = req.body;
    if (!category || !userMessage || !approvedReply) {
      return res.status(400).json({ error: 'Kategori, userMessage, dan approvedReply wajib diisi' });
    }

    const catConfig = contextManager.persona.categories[category];
    if (!catConfig) {
      return res.status(404).json({ error: `Kategori '${category}' tidak ditemukan` });
    }

    if (!Array.isArray(catConfig.few_shots)) {
      catConfig.few_shots = [];
    }

    catConfig.few_shots.push({
      user: userMessage.trim(),
      reply: approvedReply.trim()
    });

    contextManager.savePersona();
    addLog('info', `🎯 Contoh dialog baru disimpan ke Persona Few-Shot [${category}]: "${approvedReply.trim()}"`);
    res.json({ success: true, fewShotsCount: catConfig.few_shots.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logs & History
app.get('/api/logs', (req, res) => {
  res.json({ logs: activityLogs });
});

// Endpoint untuk daftar kontak beserta pesan terakhir & status obrolan
app.get('/api/conversations', (req, res) => {
  const result = [];

  // Muat data memory & contacts terbaru
  contextManager.loadData();

  const phones = new Set([
    ...Object.keys(contextManager.contacts || {}),
    ...Object.keys(contextManager.memory || {})
  ]);

  for (const phone of phones) {
    const cleanPhone = phone.replace(/\D/g, '');
    const contact = contextManager.contacts[cleanPhone] || contextManager.contacts[phone] || {
      name: '',
      category: 'default',
      enabled: false,
      notes: ''
    };
    const history = contextManager.getHistory(cleanPhone);
    const lastMsg = history.length > 0 ? history[history.length - 1] : null;
    const senderMessage = [...history].reverse().find((message) => message.role === 'user' && message.meta);
    const senderName = senderMessage?.meta?.senderName || senderMessage?.meta?.pushName || '';

    result.push({
      phone: cleanPhone,
      name: contact.name || senderName || cleanPhone,
      category: contact.category || 'default',
      enabled: contact.enabled !== false,
      notes: contact.notes || '',
      messageCount: history.length,
      lastMessage: lastMsg ? {
        role: lastMsg.role,
        content: lastMsg.content,
        timestamp: lastMsg.timestamp
      } : null
    });
  }

  // Urutkan berdasarkan waktu pesan terakhir (yang terbaru paling atas)
  result.sort((a, b) => {
    const timeA = a.lastMessage?.timestamp ? new Date(a.lastMessage.timestamp).getTime() : 0;
    const timeB = b.lastMessage?.timestamp ? new Date(b.lastMessage.timestamp).getTime() : 0;
    return timeB - timeA;
  });

  res.json({ conversations: result });
});

app.get('/api/history/:phone', (req, res) => {
  const { phone } = req.params;
  const history = contextManager.getHistory(phone.replace(/\D/g, ''));
  res.json({ phone, history });
});

app.delete('/api/history/:phone', (req, res) => {
  const { phone } = req.params;
  const cleanPhone = phone.replace(/\D/g, '');
  contextManager.clearHistory(cleanPhone);
  addLog('info', `Riwayat chat untuk kontak ${cleanPhone} telah dihapus.`);
  res.json({ success: true, phone: cleanPhone });
});

// Jalankan Server & WhatsApp
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🤖 Another Me - WhatsApp Auto-Reply Service`);
  console.log(`🌐 Dashboard UI : http://localhost:${PORT}`);
  console.log(`🧠 Provider LLM : ${llm.model} (${llm.baseUrl})`);
  console.log(`====================================================`);
  startWhatsApp();
});
