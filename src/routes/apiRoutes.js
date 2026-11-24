/**
 * Express API Routes
 * Seluruh endpoint HTTP /api/* untuk Dashboard, Kontrol Layanan, Kontak,
 * Persona, Knowledge Base, Stiker, dan Training Room.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { isValidWebpBuffer, moveFileSafeSync } = require('../utils/atomicFile');

function createApiRouter({
  llm,
  contextManager,
  knowledgeManager,
  toolRegistry,
  settingsStore,
  baileysService,
  askQueueMonitor,
  activityLogs,
  addLog,
  uploadsDir
}) {
  const router = express.Router();
  const maxUploadBytes = parseInt(process.env.MAX_UPLOAD_BYTES, 10) || 10 * 1024 * 1024;
  const upload = multer({
    dest: uploadsDir,
    limits: {
      fileSize: maxUploadBytes,
      files: 1
    }
  });

  // Optional internal bearer token guard (aktif hanya jika DASHBOARD_API_TOKEN diset)
  router.use((req, res, next) => {
    const requiredToken = (process.env.DASHBOARD_API_TOKEN || '').trim();
    if (!requiredToken) return next();

    const remoteAddr = req.ip || req.socket?.remoteAddress || '';
    const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
    if (isLoopback && process.env.ALLOW_LOCAL_NO_AUTH !== 'false') {
      return next();
    }

    const authHeader = String(req.headers.authorization || '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const headerToken = String(req.headers['x-dashboard-token'] || '').trim();
    if (bearerToken === requiredToken || headerToken === requiredToken) {
      return next();
    }

    return res.status(401).json({ success: false, error: 'Autentikasi API diperlukan.' });
  });

  // ==========================================
  // STATUS & PAIRING API
  // ==========================================
  router.get('/status', async (req, res) => {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const llmHealth = await llm.checkHealth({ force: forceRefresh });
    const settings = settingsStore.getAll();
    const waStatus = baileysService.getStatus();
    const askQueue = askQueueMonitor ? askQueueMonitor.inspectAndMaintain() : { pendingCount: 0, stalePendingCount: 0, staleItems: [] };

    res.json({
      whatsapp: waStatus,
      llm: {
        baseUrl: llm.baseUrl,
        model: llm.model,
        visionModel: llm.visionModel || null,
        hasApiKey: Boolean(llm.apiKey),
        locked: process.env.LOCK_LLM_CONFIG === 'true',
        connected: llmHealth.connected,
        message: llmHealth.message || null,
        cached: Boolean(llmHealth.cached)
      },
      settings: {
        serviceEnabled: settings.serviceEnabled,
        whitelistOnly: settings.whitelistOnly,
        replyGroups: settings.replyGroups,
        totalContacts: Object.keys(contextManager.contacts).length,
        totalKnowledge: knowledgeManager.registry.length,
        totalStickers: toolRegistry.executeGetAvailableStickers().total || 0,
        toolsAvailable: toolRegistry.getToolDefinitions().map((t) => t.function.name)
      },
      askQueue: {
        pendingCount: askQueue.pendingCount,
        stalePendingCount: askQueue.stalePendingCount,
        staleItems: askQueue.staleItems
      }
    });
  });

  router.post('/pairing-code', async (req, res) => {
    try {
      const pairingCode = await baileysService.requestPairingCode(req.body?.phone);
      res.json({ success: true, pairingCode });
    } catch (err) {
      const status = err.statusCode || (err.message === 'WhatsApp belum jalan' ? 503 : 500);
      addLog('error', `Gagal meminta kode pairing: ${err.message}`);
      res.status(status).json({ success: false, error: err.message });
    }
  });

  // ==========================================
  // MANUAL SEND API
  // ==========================================
  router.post('/send-message', async (req, res) => {
    try {
      if (!baileysService.isConnected()) {
        return res.status(503).json({ success: false, error: 'WhatsApp belum connected' });
      }

      let phone = String(req.body?.phone || '').replace(/\D/g, '');
      // Cek kecocokan langsung di contacts/contact_jids SEBELUM mengubah awalan 0 ke 62
      // agar angka LID yang kebetulan diawali 0 tidak rusak.
      const isDirectKnown = Boolean(contextManager.contacts[phone] || contextManager.getStoredJid(phone));
      if (!isDirectKnown && phone.startsWith('0')) {
        phone = '62' + phone.slice(1);
      }

      if (!/^\d{8,20}$/.test(phone)) {
        return res.status(400).json({
          success: false,
          error: 'Nomor tidak valid, pakai 8-20 digit kode negara atau ID LID (misal 62812...)'
        });
      }

      const message = String(req.body?.message || '').trim();
      if (!message) return res.status(400).json({ success: false, error: 'Pesan tidak boleh kosong' });
      if (message.length > 4000) return res.status(400).json({ success: false, error: 'Pesan maksimal 4000 karakter' });

      const targetJid = await baileysService.resolveTargetJidForManualSend(phone);
      const { bubbles, sentIds } = await baileysService.sendManualMessage(targetJid, phone, message);
      const profile = contextManager.getContactProfile(targetJid, '');
      addLog('manual-send', `Pesan manual terkirim ke ${profile.name || phone} (${bubbles} balon): "${message.slice(0, 120)}"`, { phone, bubbles });

      res.json({ success: true, phone, jid: targetJid, bubbles, messageIds: sentIds });
    } catch (err) {
      const status = err.statusCode || 500;
      addLog('error', `Gagal mengirim pesan manual: ${err.message}`);
      res.status(status).json({ success: false, error: err.message });
    }
  });

  router.post('/send-to-contact', async (req, res) => {
    try {
      if (!baileysService.isConnected()) {
        return res.status(503).json({ success: false, error: 'WhatsApp belum connected' });
      }
      const query = String(req.body?.nameOrPhone || req.body?.name || req.body?.phone || '').trim();
      const message = String(req.body?.message || '').trim();
      if (!query) return res.status(400).json({ success: false, error: 'Nama atau ID kontak wajib diisi' });
      if (!message) return res.status(400).json({ success: false, error: 'Pesan tidak boleh kosong' });
      if (message.length > 4000) return res.status(400).json({ success: false, error: 'Pesan maksimal 4000 karakter' });

      const found = contextManager.findContactByQuery(query);
      if (!found) return res.status(404).json({ success: false, error: 'Kontak tidak ditemukan di daftar kontak' });
      const { phone, contact } = found;

      const targetJid = contextManager.getStoredJid(phone);
      if (!targetJid) {
        return res.status(409).json({
          success: false,
          error: 'JID kontak belum tersimpan: tunggu kontak mengirim pesan dulu, atau kirim pakai nomor HP asli lewat /api/send-message',
          phone,
          contactName: contact.name
        });
      }

      const { bubbles, sentIds } = await baileysService.sendManualMessage(targetJid, phone, message);
      addLog('manual-send', `Pesan manual terkirim ke ${contact.name} (${bubbles} balon) via JID tersimpan.`, { phone, bubbles });
      res.json({ success: true, phone, contactName: contact.name, jid: targetJid, bubbles, messageIds: sentIds });
    } catch (err) {
      const status = err.statusCode || 500;
      addLog('error', `Gagal mengirim ke kontak: ${err.message}`);
      res.status(status).json({ success: false, error: err.message });
    }
  });

  // ==========================================
  // SETTINGS API
  // ==========================================
  router.post('/settings/toggle-service', (req, res) => {
    const serviceEnabled = settingsStore.toggleService();
    addLog('info', `Service Auto-Reply WhatsApp diubah menjadi: ${serviceEnabled ? 'AKTIF (ON)' : 'NONAKTIF (OFF)'}`);
    res.json({ success: true, serviceEnabled });
  });

  router.post('/settings/llm', async (req, res) => {
    if (process.env.LOCK_LLM_CONFIG === 'true') {
      return res.status(403).json({
        success: false,
        error: 'Konfigurasi LLM dikunci melalui variabel lingkungan LOCK_LLM_CONFIG.'
      });
    }
    try {
      const { baseUrl, apiKey, model, visionModel } = req.body || {};
      llm.updateConfig({ baseUrl, apiKey, model, visionModel });
      const health = await llm.checkHealth({ force: true });
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
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.post('/settings/toggle-whitelist', (req, res) => {
    const whitelistOnly = settingsStore.toggleWhitelist();
    addLog('info', `Mode Whitelist diubah menjadi: ${whitelistOnly ? 'AKTIF' : 'NONAKTIF'}`);
    res.json({ success: true, whitelistOnly });
  });

  router.post('/settings/toggle-groups', (req, res) => {
    const replyGroups = settingsStore.toggleGroups();
    addLog('info', `Balas Grup diubah menjadi: ${replyGroups ? 'AKTIF' : 'NONAKTIF'}`);
    res.json({ success: true, replyGroups });
  });

  // ==========================================
  // CONTACTS API
  // ==========================================
  router.get('/contacts', (req, res) => {
    contextManager.syncFromDiskIfChanged();
    const contactMeta = {};
    for (const phone of Object.keys(contextManager.contacts || {})) {
      const meta = contextManager.getJidMetadata(phone);
      contactMeta[phone] = {
        hasStoredJid: meta.hasStoredJid,
        jidType: meta.jidType
      };
    }
    res.json({
      contacts: contextManager.contacts,
      contactMeta,
      categories: Object.keys(contextManager.persona.categories || {})
    });
  });

  router.post('/contacts', (req, res) => {
    const { phone, oldPhone, name, category, enabled, notes } = req.body || {};
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone) {
      return res.status(400).json({ error: 'Nomor telepon atau ID kontak wajib diisi' });
    }
    const updated = contextManager.upsertContact(cleanPhone, { name, category, enabled, notes }, oldPhone);
    addLog('info', `Kontak disimpan: ${name || cleanPhone} (${category || 'default'})`);
    res.json({ success: true, contact: updated });
  });

  router.post('/contacts/:phone/toggle', (req, res) => {
    const { phone } = req.params;
    const newState = contextManager.toggleContactStatus(phone);
    addLog('info', `Status AI untuk ${phone} diubah menjadi: ${newState ? 'AKTIF' : 'NONAKTIF'}`);
    res.json({ success: true, enabled: newState });
  });

  router.delete('/contacts/:phone', (req, res) => {
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
  // PERSONA API
  // ==========================================
  router.get('/persona', (req, res) => {
    res.json(contextManager.getPersonaData());
  });

  router.post('/persona/general', (req, res) => {
    const { identity, core_typing_rules } = req.body || {};
    const updated = contextManager.updateGeneralPersona({ identity, core_typing_rules });
    addLog('info', 'Persona umum (identitas & aturan ketik) diperbarui.');
    res.json({ success: true, general_persona: updated });
  });

  router.post('/persona/category', (req, res) => {
    const { categoryKey, tone, vocabulary, guidelines, few_shots } = req.body || {};
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

  router.delete('/persona/category/:key', (req, res) => {
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
  // KNOWLEDGE BASE API (MULTI-FORMAT + VIEW/EDIT)
  // ==========================================
  router.get('/knowledge', (req, res) => {
    res.json({ documents: knowledgeManager.registry });
  });

  router.get('/knowledge/:id', (req, res) => {
    const doc = knowledgeManager.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });
    res.json({ success: true, document: doc });
  });

  router.put('/knowledge/:id', (req, res) => {
    try {
      const { title, content, category } = req.body || {};
      const updated = knowledgeManager.updateDocument(req.params.id, { title, content, category });
      if (!updated) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });
      addLog('info', `Dokumen pengetahuan diperbarui: "${updated.title}"`);
      res.json({ success: true, document: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/knowledge/upload', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'File tidak ditemukan' });
      }
      const { title, category } = req.body || {};
      const doc = await knowledgeManager.addDocument({
        title: title || req.file.originalname,
        originalName: req.file.originalname,
        tempFilePath: req.file.path,
        category: category || 'all'
      });

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

  router.post('/knowledge/snippet', (req, res) => {
    try {
      const { title, content, category } = req.body || {};
      const doc = knowledgeManager.addTextSnippet({ title, content, category });
      addLog('info', `Snippet knowledge ditambahkan: "${doc.title}"`);
      res.json({ success: true, document: doc });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/knowledge/:id/toggle', (req, res) => {
    const state = knowledgeManager.toggleDocument(req.params.id);
    if (state !== null) {
      res.json({ success: true, enabled: state });
    } else {
      res.status(404).json({ error: 'Dokumen tidak ditemukan' });
    }
  });

  router.delete('/knowledge/:id', (req, res) => {
    const deleted = knowledgeManager.deleteDocument(req.params.id);
    if (deleted) {
      addLog('info', `Knowledge ${req.params.id} dihapus`);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Dokumen tidak ditemukan' });
    }
  });

  // ==========================================
  // STICKERS MANAGEMENT API
  // ==========================================
  router.get('/stickers', (req, res) => {
    res.json(toolRegistry.executeGetAvailableStickers());
  });

  router.post('/stickers/upload', upload.single('sticker'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'File stiker tidak ditemukan' });

      const headerBuf = fs.readFileSync(req.file.path);
      if (!isValidWebpBuffer(headerBuf)) {
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({ error: 'File harus berupa gambar WebP valid (header RIFF/WEBP).' });
      }

      const rawTag = req.body?.tag || path.basename(req.file.originalname, path.extname(req.file.originalname));
      const tag = String(rawTag || '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .replace(/^_+|_+$/g, '');

      if (!tag || !/[a-z0-9]/.test(tag)) {
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({ error: 'Tag stiker wajib mengandung huruf atau angka (contoh: ketawa, peluk).' });
      }

      const destFileName = `${tag}.webp`;
      const destPath = path.join(toolRegistry.stickersDir, destFileName);
      moveFileSafeSync(req.file.path, destPath);

      addLog('info', `Stiker baru ditambahkan: "${destFileName}"`);
      res.json({ success: true, fileName: destFileName, tag });
    } catch (err) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch {}
      }
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/stickers/:fileName', (req, res) => {
    const { fileName } = req.params;
    const safeName = path.basename(fileName);
    const targetPath = path.join(toolRegistry.stickersDir, safeName);
    if (fs.existsSync(targetPath)) {
      try {
        fs.unlinkSync(targetPath);
        addLog('info', `Stiker ${safeName} dihapus`);
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
  router.post('/simulation/chat', async (req, res) => {
    try {
      const { message, category, customContext, history } = req.body || {};
      if (!message) return res.status(400).json({ error: 'Pesan simulasi tidak boleh kosong' });

      const simCategory = category || 'default';
      const relevantKnowledge = knowledgeManager.getInjectedKnowledge(simCategory, message);

      // Menggunakan perakit prompt tunggal milik ContextManager agar 100% selaras dengan WhatsApp asli
      const promptMessages = contextManager.buildPromptMessages(
        'SIMULATION_USER',
        message,
        relevantKnowledge,
        '',
        {
          isSimulation: true,
          category: simCategory,
          customContext,
          simulationHistory: Array.isArray(history) ? history : []
        }
      );

      const agentResult = await llm.runAgentLoop(promptMessages, {
        category: simCategory,
        senderPhone: 'SIMULATION_USER'
      });

      addLog('info', `🧪 Simulasi [${simCategory}]: "${message}" -> "${agentResult.replyText}"`);

      const replyBubbles = llm
        .splitIntoMessages(agentResult.replyText, 2)
        .map((b) => llm.capitalizeFirstLetter(b));

      res.json({
        success: true,
        replyText: agentResult.replyText,
        replyBubbles,
        toolCallsLog: agentResult.toolCallsLog || [],
        actions: agentResult.actions || []
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/simulation/interpret', async (req, res) => {
    try {
      const { category, userMessage, aiReply, perfectReply, history, scenarioContext } = req.body || {};
      if (!userMessage && (!history || history.length === 0)) {
        return res.status(400).json({ error: 'Tidak ada data percakapan untuk diinterpretasi' });
      }

      const hasUserInHistory = Array.isArray(history) && history.some((h) => h && h.role === 'user');
      const conversationSnippet =
        Array.isArray(history) && history.length > 0 && hasUserInHistory
          ? history.map((h) => `${h.role === 'user' ? 'Lawan Bicara' : 'Respon Awal AI'}: ${h.content}`).join('\n')
          : `Lawan Bicara: ${userMessage || '(tidak tersedia)'}\nRespon Awal AI: ${aiReply || '(kosong)'}`;

      const safePerfect = String(perfectReply || '').trim();

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
        max_tokens: 600
      };

      // Gunakan postChatCompletion agar mendapatkan retry otomatis (500/503/429) & timeout
      const data = await llm.postChatCompletion(endpoint, headers, payload, false);
      const rawContent = llm.cleanResponse(data.choices?.[0]?.message?.content || '{}');

      let parsed = {};
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
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

  router.post('/simulation/describe-sticker', upload.single('sticker'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'File stiker tidak ditemukan' });
      const buffer = fs.readFileSync(req.file.path);
      try { fs.unlinkSync(req.file.path); } catch {}

      if (!isValidWebpBuffer(buffer)) {
        return res.status(400).json({ error: 'File uji stiker harus berformat WebP valid.' });
      }

      const desc = await llm.describeImage(buffer, 'image/webp');
      res.json({ success: true, description: desc || 'Stiker tidak dapat diinterpretasi' });
    } catch (err) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch {}
      }
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/simulation/learn/knowledge', (req, res) => {
    try {
      const { title, lesson, category } = req.body || {};
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

  router.post('/simulation/learn/fewshot', (req, res) => {
    try {
      const { category, userMessage, approvedReply } = req.body || {};
      if (!category || !userMessage || !approvedReply) {
        return res.status(400).json({ error: 'Kategori, userMessage, dan approvedReply wajib diisi' });
      }

      const count = contextManager.addFewShot(category, userMessage, approvedReply);
      if (count === null) {
        return res.status(404).json({ error: `Kategori '${category}' tidak ditemukan` });
      }

      addLog('info', `🎯 Contoh dialog baru disimpan ke Persona Few-Shot [${category}]: "${String(approvedReply).trim()}"`);
      res.json({ success: true, fewShotsCount: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================
  // LOGS & HISTORY API
  // ==========================================
  router.get('/logs', (req, res) => {
    res.json({ logs: activityLogs });
  });

  router.get('/conversations', (req, res) => {
    res.json({ conversations: contextManager.getConversationsSummary() });
  });

  router.get('/history/:phone', (req, res) => {
    const { phone } = req.params;
    const history = contextManager.getHistory(phone.replace(/\D/g, ''));
    res.json({ phone, history });
  });

  router.delete('/history/:phone', (req, res) => {
    const { phone } = req.params;
    const cleanPhone = phone.replace(/\D/g, '');
    contextManager.clearHistory(cleanPhone);
    addLog('info', `Riwayat chat untuk kontak ${cleanPhone} telah dihapus.`);
    res.json({ success: true, phone: cleanPhone });
  });

  // Error handler untuk Multer (ukuran file melebihi batas)
  router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          success: false,
          error: `Ukuran file melebihi batas maksimal (${Math.round(maxUploadBytes / (1024 * 1024))} MB).`
        });
      }
      return res.status(400).json({ success: false, error: `Galat unggah berkas: ${err.message}` });
    }
    return next(err);
  });

  return router;
}

module.exports = { createApiRouter };
