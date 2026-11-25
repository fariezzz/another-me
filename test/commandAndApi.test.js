const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sharp = require('sharp');

const execFileAsync = promisify(execFile);

const {
  ASK_USAGE_REPLY,
  ASK_ACK_REPLY,
  ASK_DEFAULT_MEDIA_QUESTION,
  ASK_VIEW_ONCE_REPLY,
  parseAskCommand,
  parseAcepCommand,
  enqueueAskQuestion,
  AskQueueMonitor,
  handleInstantCommands
} = require('../src/whatsapp/commandRouter');
const BaileysService = require('../src/whatsapp/baileysService');
const { buildMenuText } = require('../src/whatsapp/utilityCommands');
const { isValidWebpBuffer, renderQrToSvg } = require('../src/utils/atomicFile');
const { createServerApp } = require('../index');
const ContextManager = require('../src/contextManager');
const KnowledgeManager = require('../src/knowledgeManager');
const ToolRegistry = require('../src/tools/toolRegistry');
const SettingsStore = require('../src/settingsStore');
const LLMClient = require('../src/llmClient');

test('parseAcepCommand handles all command variants and ignores natural language', () => {
  assert.deepEqual(parseAcepCommand('!acep', true), { matched: true, newState: false, reply: 'oke, acep off dulu ya' });
  assert.deepEqual(parseAcepCommand('!acep', false), { matched: true, newState: true, reply: 'acep on lagi ya' });
  assert.deepEqual(parseAcepCommand('!acep nyala', false), { matched: true, newState: true, reply: 'acep on lagi ya' });
  assert.deepEqual(parseAcepCommand('!acep mati', true), { matched: true, newState: false, reply: 'oke, acep off dulu ya' });
  assert.deepEqual(parseAcepCommand('!acep status', false), { matched: true, newState: null, reply: 'acep lagi off' });
  assert.equal(parseAcepCommand('!acep aneh', true).newState, null);
  assert.equal(parseAcepCommand('acep tolong matiin', true).matched, false);
});

test('parseAskCommand and AskQueueMonitor handle queue, stale warning, and 7-day cleanup', () => {
  assert.deepEqual(parseAskCommand('!ask ibu kota jepang'), { matched: true, question: 'ibu kota jepang' });
  assert.deepEqual(parseAskCommand('!tanya '), { matched: true, question: '' });
  assert.equal(parseAskCommand('halo ask').matched, false);

  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-ask-'));
  try {
    const entry = enqueueAskQuestion(queueDir, {
      phone: '111222333444',
      name: 'Kiraya',
      category: 'teman_dekat',
      question: 'Tes antrean'
    });
    assert.equal(entry.status, 'pending');

    // Create an old answered item (> 7 days) and a stale pending item (> 5 min)
    const oldAnsweredPath = path.join(queueDir, 'old-answered.json');
    fs.writeFileSync(
      oldAnsweredPath,
      JSON.stringify({
        id: 'old-answered',
        status: 'answered',
        askedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        answeredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      })
    );
    fs.writeFileSync(
      path.join(queueDir, 'stale-pending.json'),
      JSON.stringify({
        id: 'stale-pending',
        name: 'Kiraya',
        question: 'Kenapa belum dijawab?',
        status: 'pending',
        askedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
      })
    );

    const logs = [];
    const monitor = new AskQueueMonitor({
      queueDir,
      addLog: (type, text) => logs.push({ type, text })
    });
    const summary = monitor.inspectAndMaintain();

    assert.equal(summary.pendingCount, 2);
    assert.equal(summary.stalePendingCount, 1);
    assert.equal(summary.answeredCleanedCount, 1);
    assert.equal(fs.existsSync(oldAnsweredPath), false);
    assert.equal(logs.length, 1);
  } finally {
    fs.rmSync(queueDir, { recursive: true, force: true });
  }
});

test('isValidWebpBuffer and renderQrToSvg validate magic bytes and render local SVG', () => {
  const validWebp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8 ')]);
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  assert.equal(isValidWebpBuffer(validWebp), true);
  assert.equal(isValidWebpBuffer(fakePng), false);

  const svg = renderQrToSvg('2@example-whatsapp-qr-payload');
  assert.ok(svg && svg.startsWith('<svg ') && svg.includes('</svg>'));
});

test('Express API enforces CORS, security headers, LID validation, LLM URL validation, and Knowledge edit', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-api-'));
  const uploadsDir = path.join(tmpDir, 'uploads');
  const stickersDir = path.join(tmpDir, 'stickers');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(stickersDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'persona.json'),
    JSON.stringify({ general_persona: { identity: 'Test' }, categories: { default: { tone: 'Netral', few_shots: [] } } })
  );

  const contextManager = new ContextManager({ dataPath: tmpDir });
  contextManager.upsertContact('1749123456789012', { name: 'Kontak LID', category: 'default', enabled: true });
  const knowledgeManager = new KnowledgeManager({ dataPath: tmpDir });
  const toolRegistry = new ToolRegistry({ stickersDir, knowledgeManager });
  const settingsStore = new SettingsStore({ dataPath: tmpDir });
  const llm = new LLMClient({ baseUrl: 'http://127.0.0.1:4000/v1beta/openai', model: 'gemma-4-26b-a4b-it' });
  llm.checkHealth = async () => ({ connected: true, cached: false });

  const mockBaileys = {
    getStatus: () => ({
      status: 'qr_ready',
      qrAvailable: true,
      qr: 'sample-qr',
      qrSvg: renderQrToSvg('sample-qr'),
      pairingCode: '1234-5678',
      lastDisconnectReason: 408
    }),
    isConnected: () => true,
    resolveTargetJidForManualSend: async (phone) => {
      if (contextManager.contacts[phone] && !contextManager.getStoredJid(phone)) {
        const err = new Error('JID kontak terdaftar belum tersimpan');
        err.statusCode = 409;
        throw err;
      }
      return `${phone}@s.whatsapp.net`;
    },
    sendManualMessage: async () => ({ bubbles: 1, sentIds: ['id-1'] })
  };

  const { app } = createServerApp({
    llm,
    contextManager,
    knowledgeManager,
    toolRegistry,
    settingsStore,
    baileysService: mockBaileys,
    askQueueMonitor: new AskQueueMonitor({ queueDir: path.join(tmpDir, 'ask-queue') }),
    uploadsDir
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Security headers (incl. CSP), CORS restriction, & CSRF cross-site rejection (SEC-02)
    const evilRes = await fetch(`${base}/api/status`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(evilRes.headers.get('access-control-allow-origin'), null);
    assert.equal(evilRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(evilRes.headers.get('x-frame-options'), 'DENY');
    assert.ok((evilRes.headers.get('content-security-policy') || '').includes("default-src 'self'"));

    const csrfRes = await fetch(`${base}/api/settings/toggle-whitelist`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' }
    });
    assert.equal(csrfRes.status, 403);

    const csrfFetchSiteRes = await fetch(`${base}/api/settings/toggle-service`, {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'cross-site' }
    });
    assert.equal(csrfFetchSiteRes.status, 403);

    // 1b. Cloudflare Tunnel header prevents loopback auth bypass when DASHBOARD_API_TOKEN is set (SEC-01)
    const prevToken = process.env.DASHBOARD_API_TOKEN;
    process.env.DASHBOARD_API_TOKEN = 'secret-audit-token-123';
    try {
      const cfNoToken = await fetch(`${base}/api/status`, {
        headers: { 'CF-Connecting-IP': '203.0.113.10' }
      });
      assert.equal(cfNoToken.status, 401);

      const cfWithToken = await fetch(`${base}/api/status`, {
        headers: { 'CF-Connecting-IP': '203.0.113.10', 'X-Dashboard-Token': 'secret-audit-token-123' }
      });
      assert.equal(cfWithToken.status, 200);

      // Pure local loopback without proxy headers still works when ALLOW_LOCAL_NO_AUTH !== 'false'
      const localOk = await fetch(`${base}/api/status`);
      assert.equal(localOk.status, 200);
    } finally {
      if (prevToken === undefined) delete process.env.DASHBOARD_API_TOKEN;
      else process.env.DASHBOARD_API_TOKEN = prevToken;
    }

    // 1c. Toggling unknown contact returns 404 instead of silently creating a ghost contact (BUG-06)
    const ghostToggle = await fetch(`${base}/api/contacts/628000000000/toggle`, { method: 'POST' });
    assert.equal(ghostToggle.status, 404);
    assert.equal(contextManager.contacts['628000000000'], undefined);

    const statusData = await evilRes.json();
    assert.equal(statusData.whatsapp.lastDisconnectReason, 408);
    assert.ok(statusData.whatsapp.qrSvg.startsWith('<svg '));
    assert.equal(statusData.askQueue.pendingCount, 0);

    // 2. Reject invalid LLM URL protocol & cloud metadata SSRF host (SEC-03)
    const badLlmRes = await fetch(`${base}/api/settings/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'file:///etc/passwd', model: 'x' })
    });
    assert.equal(badLlmRes.status, 400);

    const ssrfRes = await fetch(`${base}/api/settings/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://169.254.169.254/latest/meta-data', model: 'x' })
    });
    assert.equal(ssrfRes.status, 400);

    // 3. 16-digit registered LID without stored JID returns 409 instead of guessing @s.whatsapp.net (BUG-06)
    const lidRes = await fetch(`${base}/api/send-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '1749123456789012', message: 'Tes' })
    });
    assert.equal(lidRes.status, 409);

    // 4. Knowledge snippet create -> GET -> PUT edit flow
    const createRes = await fetch(`${base}/api/knowledge/snippet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Catatan Lama', content: 'Isi awal', category: 'all' })
    });
    const created = await createRes.json();
    assert.equal(created.success, true);

    const putRes = await fetch(`${base}/api/knowledge/${created.document.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Catatan Baru', content: 'Isi diperbarui', category: 'default' })
    });
    const edited = await putRes.json();
    assert.equal(edited.success, true);
    assert.equal(edited.document.title, 'Catatan Baru');
    assert.equal(edited.document.content, 'Isi diperbarui');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('public/index.html has zero external CDNs, zero inline onclick handlers, and fixes simHistory & XSS escaping', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf-8');
  assert.ok(!html.includes('cdn.tailwindcss.com'), 'Tidak boleh memuat Tailwind Play CDN');
  assert.ok(!html.includes('cdnjs.cloudflare.com'), 'Tidak boleh memuat qrcode CDN eksternal');
  assert.ok(!/\bonclick\s*=/i.test(html), 'Tidak boleh ada handler onclick inline');
  assert.ok(html.includes('function escapeHtml('), 'Harus memiliki fungsi escapeHtml');
  assert.ok(html.includes("simHistory.push({ role: 'user', content: msg })"), 'Harus menyimpan pesan user ke simHistory');
  assert.ok(html.includes('/api/pairing-code'), 'Harus mendukung fitur Kode Pairing di dashboard');
  assert.ok(html.includes('/api/send-to-contact'), 'Harus merutekan kontak terdaftar ke /api/send-to-contact');
});

test('!ask is strictly owner-only (fromMe) across all chats while !acep remains usable by registered contacts', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-ask-owner-'));
  const queueDir = path.join(tmpDir, 'ask-queue');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'persona.json'),
    JSON.stringify({ general_persona: { identity: 'Test' }, categories: { default: { tone: 'Netral', few_shots: [] } } })
  );

  const contextManager = new ContextManager({ dataPath: tmpDir });
  contextManager.upsertContact('1749111222333', { name: 'Kontak Terdaftar', category: 'pacar', enabled: false });
  const knowledgeManager = new KnowledgeManager({ dataPath: tmpDir });
  const settingsStore = new SettingsStore({ dataPath: tmpDir });
  settingsStore.settings = { serviceEnabled: true, whitelistOnly: true, replyGroups: false };
  const llm = new LLMClient({ baseUrl: 'http://127.0.0.1:4000/v1beta/openai', model: 'gemma-4-26b-a4b-it' });

  const sent = [];
  const logs = [];
  const service = new BaileysService({
    llm,
    contextManager,
    knowledgeManager,
    settingsStore,
    addLog: (type, text) => logs.push({ type, text }),
    options: { askQueueDir: queueDir }
  });
  service.connectionStatus = 'connected';
  service.waSocket = {
    user: { id: '628111111111:1@s.whatsapp.net', lid: '999888777666@lid' },
    sendMessage: async (jid, content, opts) => {
      const id = `sent-${sent.length + 1}`;
      sent.push({ jid, content, opts });
      return { key: { id } };
    },
    readMessages: async () => {}
  };

  try {
    // 1. Kontak terdaftar (fromMe: false) mencoba !ask -> diabaikan diam-diam, 0 balasan, 0 berkas antrean
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '1749111222333@lid', fromMe: false, id: 'm-nonowner-1' },
          pushName: 'Kontak Terdaftar',
          message: { conversation: '!ask rahasia apa aja?' }
        }
      ]
    });
    assert.equal(sent.length, 0, 'Non-pemilik terdaftar tidak boleh mendapat balasan dari !ask');
    assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 0);

    // 2. Orang asing (fromMe: false) mencoba !tanya -> juga diabaikan diam-diam
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628999000111@s.whatsapp.net', fromMe: false, id: 'm-stranger-1' },
          pushName: 'Asing',
          message: { conversation: '!tanya halo' }
        }
      ]
    });
    assert.equal(sent.length, 0);
    assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 0);

    // 3. Kontak terdaftar (fromMe: false) tetap boleh memakai !acep status (aturan 7.3 utuh)
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '1749111222333@lid', fromMe: false, id: 'm-acep-1' },
          pushName: 'Kontak Terdaftar',
          message: { conversation: '!acep status' }
        }
      ]
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content.text, 'acep lagi off');

    // 4. Pemilik (fromMe: true) memakai !ask di obrolan pribadi TAK TERDAFTAR -> berhasil & masuk antrean dengan remoteJid
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628777888999@s.whatsapp.net', fromMe: true, id: 'm-owner-unreg-1' },
          message: { conversation: '!ask cek jadwal besok' }
        }
      ]
    });
    // Event duplikat (append dengan key.id yang sama) tidak boleh menggandakan antrean
    await service.handleMessagesUpsert({
      type: 'append',
      messages: [
        {
          key: { remoteJid: '628777888999@s.whatsapp.net', fromMe: true, id: 'm-owner-unreg-1' },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: { conversation: '!ask cek jadwal besok' }
        }
      ]
    });

    assert.equal(sent.length, 2);
    assert.equal(sent[1].content.text, ASK_ACK_REPLY);
    let qFiles = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
    assert.equal(qFiles.length, 1);
    const unregEntry = JSON.parse(fs.readFileSync(path.join(queueDir, qFiles[0]), 'utf-8'));
    assert.equal(unregEntry.remoteJid, '628777888999@s.whatsapp.net');
    assert.equal(unregEntry.fromMe, true);
    assert.equal(unregEntry.isGroup, false);

    // 5. Pemilik (fromMe: true) memakai !ask di GRUP sambil membalas pesan teks biasa -> berhasil!
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: '120363098765432100@g.us',
            fromMe: false,
            participant: '999888777666@lid', // LID pemilik sendiri di grup
            id: 'm-owner-group-1'
          },
          message: {
            extendedTextMessage: {
              text: '!ask rangkum pesan ini dong',
              contextInfo: {
                stanzaId: 'orig-text-1',
                quotedMessage: { conversation: 'Rapat dipindah ke Jumat jam 09.00 WIB di ruang B.' }
              }
            }
          }
        }
      ]
    });
    assert.equal(sent.length, 3);
    assert.equal(sent[2].jid, '120363098765432100@g.us');
    assert.equal(sent[2].content.text, ASK_ACK_REPLY);

    qFiles = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
    assert.equal(qFiles.length, 2);
    const groupEntry = qFiles
      .map((f) => JSON.parse(fs.readFileSync(path.join(queueDir, f), 'utf-8')))
      .find((e) => e.isGroup);
    assert.ok(groupEntry);
    assert.equal(groupEntry.remoteJid, '120363098765432100@g.us');
    assert.ok(groupEntry.question.includes('Rapat dipindah ke Jumat jam 09.00 WIB'));

    // 6. buildMenuText menyembunyikan !ask dari kontak terdaftar non-pemilik, tapi menampilkannya ke pemilik
    const nonOwnerMenu = buildMenuText({ showOwnerCommands: true, isOwner: false });
    assert.ok(nonOwnerMenu.includes('!acep'));
    assert.ok(!nonOwnerMenu.includes('!ask'));

    const ownerMenu = buildMenuText({ showOwnerCommands: true, isOwner: true });
    assert.ok(ownerMenu.includes('!acep'));
    assert.ok(ownerMenu.includes('!ask'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('!ask supports photo, sticker, video keyframes, documents, rejects View Once, and cleans up old media', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-ask-media-'));
  const queueDir = path.join(tmpDir, 'ask-queue');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'persona.json'),
    JSON.stringify({ general_persona: { identity: 'Test' }, categories: { default: { tone: 'Netral', few_shots: [] } } })
  );

  const contextManager = new ContextManager({ dataPath: tmpDir });
  const knowledgeManager = new KnowledgeManager({ dataPath: tmpDir });
  const settingsStore = new SettingsStore({ dataPath: tmpDir });
  settingsStore.settings = { serviceEnabled: true, whitelistOnly: true, replyGroups: false };
  const llm = new LLMClient({ baseUrl: 'http://127.0.0.1:4000/v1beta/openai', model: 'gemma-4-26b-a4b-it' });

  const sampleJpg = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 220, g: 80, b: 40 } }
  })
    .jpeg()
    .toBuffer();

  const sampleStickerWebp = await sharp({
    create: { width: 256, height: 256, channels: 4, background: { r: 30, g: 160, b: 220, alpha: 1 } }
  })
    .webp()
    .toBuffer();

  const sampleDocText = Buffer.from('Daftar belanja:\n1. Kopi Arabika\n2. Susu Oat\n3. Roti Gandum', 'utf-8');

  // Buat video MP4 mini 2 detik memakai FFmpeg bila tersedia
  let sampleMp4 = null;
  const mp4Tmp = path.join(tmpDir, 'sample.mp4');
  try {
    await execFileAsync(
      process.env.FFMPEG_PATH || 'ffmpeg',
      ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', mp4Tmp],
      { timeout: 15000, windowsHide: true }
    );
    sampleMp4 = fs.readFileSync(mp4Tmp);
  } catch {}

  const downloadMap = new Map([
    ['img-direct', sampleJpg],
    ['stk-quoted', sampleStickerWebp],
    ['doc-direct', sampleDocText],
    ...(sampleMp4 ? [['vid-direct', sampleMp4]] : [])
  ]);
  let downloadCalls = 0;

  const sent = [];
  const service = new BaileysService({
    llm,
    contextManager,
    knowledgeManager,
    settingsStore,
    addLog: () => {},
    options: { askQueueDir: queueDir }
  });
  service.connectionStatus = 'connected';
  service.waSocket = {
    user: { id: '628111111111:1@s.whatsapp.net', lid: '999888777666@lid' },
    sendMessage: async (jid, content, opts) => {
      sent.push({ jid, content, opts });
      return { key: { id: `ack-${sent.length}` } };
    }
  };
  service.downloadMediaBuffer = async (targetMsg) => {
    downloadCalls++;
    const keyId = targetMsg?.key?.id;
    const buf = downloadMap.get(keyId);
    if (!buf) throw new Error(`Mock media ${keyId} tidak ditemukan`);
    return buf;
  };

  try {
    // 1. Foto langsung dengan caption "!ask" saja (tanpa teks tambahan) -> memakai pertanyaan default + menyimpan JPG
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111111111@s.whatsapp.net', fromMe: true, id: 'img-direct' },
          message: {
            imageMessage: { mimetype: 'image/jpeg', fileLength: sampleJpg.length, caption: '!ask' }
          }
        }
      ]
    });
    assert.equal(sent[sent.length - 1].content.text, ASK_ACK_REPLY);

    // 2. Membalas stiker WebP dengan "!ask stiker apa ini?" -> konversi PNG siap baca di viewablePaths
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111111111@s.whatsapp.net', fromMe: true, id: 'reply-stk-1' },
          message: {
            extendedTextMessage: {
              text: '!ask stiker apa ini?',
              contextInfo: {
                stanzaId: 'stk-quoted',
                quotedMessage: {
                  stickerMessage: { mimetype: 'image/webp', fileLength: sampleStickerWebp.length }
                }
              }
            }
          }
        }
      ]
    });
    assert.equal(sent[sent.length - 1].content.text, ASK_ACK_REPLY);

    // 3. Dokumen teks dengan caption "!ask ringkas file ini" -> simpan berkas + ekstrak isi teks ke question
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111111111@s.whatsapp.net', fromMe: true, id: 'doc-direct' },
          message: {
            documentMessage: {
              mimetype: 'text/plain',
              fileName: 'belanja.txt',
              fileLength: sampleDocText.length,
              caption: '!ask ringkas file ini'
            }
          }
        }
      ]
    });
    assert.equal(sent[sent.length - 1].content.text, ASK_ACK_REPLY);

    // 4. Video MP4 (bila FFmpeg tersedia) -> simpan MP4 + ekstrak bingkai JPEG siap baca
    if (sampleMp4) {
      await service.handleMessagesUpsert({
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '628111111111@s.whatsapp.net', fromMe: true, id: 'vid-direct' },
            message: {
              videoMessage: {
                mimetype: 'video/mp4',
                seconds: 2,
                fileLength: sampleMp4.length,
                caption: '!ask video ini isinya apa?'
              }
            }
          }
        ]
      });
      assert.equal(sent[sent.length - 1].content.text, ASK_ACK_REPLY);
    }

    // 5. Media View Once -> ditolak sopan TANPA memanggil downloadMediaBuffer
    const callsBeforeViewOnce = downloadCalls;
    await service.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111111111@s.whatsapp.net', fromMe: true, id: 'vo-1' },
          message: {
            viewOnceMessageV2: {
              message: {
                imageMessage: { mimetype: 'image/jpeg', viewOnce: true, caption: '!ask lihat ini' }
              }
            }
          }
        }
      ]
    });
    assert.equal(downloadCalls, callsBeforeViewOnce, 'View Once tidak boleh diunduh');
    assert.equal(sent[sent.length - 1].content.text, ASK_VIEW_ONCE_REPLY);

    // Verifikasi seluruh isi berkas antrean yang terbentuk
    const entries = fs
      .readdirSync(queueDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(queueDir, f), 'utf-8')));

    const imgEntry = entries.find((e) => e.media?.kind === 'image');
    assert.ok(imgEntry);
    assert.equal(imgEntry.rawQuestion, ASK_DEFAULT_MEDIA_QUESTION);
    assert.equal(fs.existsSync(imgEntry.media.viewablePaths[0]), true);
    assert.ok(imgEntry.question.includes(imgEntry.media.viewablePaths[0]));

    const stkEntry = entries.find((e) => e.media?.kind === 'sticker');
    assert.ok(stkEntry);
    assert.ok(stkEntry.media.viewablePaths[0].endsWith('.png'));
    assert.equal(fs.existsSync(stkEntry.media.viewablePaths[0]), true);

    const docEntry = entries.find((e) => e.media?.kind === 'document');
    assert.ok(docEntry);
    assert.ok(docEntry.question.includes('Kopi Arabika'));
    assert.equal(fs.existsSync(docEntry.media.filePath), true);

    if (sampleMp4) {
      const vidEntry = entries.find((e) => e.media?.kind === 'video');
      assert.ok(vidEntry);
      assert.ok(vidEntry.media.viewablePaths.length >= 1, 'Video harus menghasilkan minimal 1 bingkai gambar');
      assert.equal(fs.existsSync(vidEntry.media.viewablePaths[0]), true);
    }

    // 6. Pembersihan 7 hari AskQueueMonitor ikut menghapus berkas media terkait di data/ask-queue/media/
    const imgJsonPath = path.join(queueDir, `${imgEntry.id}.json`);
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(imgJsonPath, JSON.stringify({ ...imgEntry, status: 'answered', answeredAt: oldTs }));

    const monitor = new AskQueueMonitor({ queueDir });
    const summary = monitor.inspectAndMaintain();
    assert.equal(summary.answeredCleanedCount, 1);
    assert.equal(fs.existsSync(imgJsonPath), false);
    assert.equal(fs.existsSync(imgEntry.media.filePath), false, 'Berkas media antrean lama harus ikut terhapus');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('POST /api/send-to-contact delivers Muse !ask replies to groups and unregistered chats via queue target, askId, or jid', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-send-ask-'));
  const queueDir = path.join(tmpDir, 'ask-queue');
  const uploadsDir = path.join(tmpDir, 'uploads');
  const stickersDir = path.join(tmpDir, 'stickers');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(stickersDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'persona.json'),
    JSON.stringify({ general_persona: { identity: 'Test' }, categories: { default: { tone: 'Netral', few_shots: [] } } })
  );

  const contextManager = new ContextManager({ dataPath: tmpDir });
  const knowledgeManager = new KnowledgeManager({ dataPath: tmpDir });
  const toolRegistry = new ToolRegistry({ stickersDir, knowledgeManager });
  const settingsStore = new SettingsStore({ dataPath: tmpDir });
  const llm = new LLMClient({ baseUrl: 'http://127.0.0.1:4000/v1beta/openai', model: 'gemma-4-26b-a4b-it' });
  llm.checkHealth = async () => ({ connected: true, cached: false });

  const delivered = [];
  const mockBaileys = {
    getStatus: () => ({ status: 'connected' }),
    isConnected: () => true,
    sendManualMessage: async (targetJid, historyKey, message) => {
      delivered.push({ targetJid, historyKey, message });
      return { bubbles: 1, sentIds: [`msg-${delivered.length}`] };
    }
  };

  const askQueueMonitor = new AskQueueMonitor({ queueDir });
  const groupEntry = enqueueAskQuestion(queueDir, {
    phone: '1203630555666777@g.us',
    name: 'Grup 1203630555666777',
    category: 'group',
    question: 'Tes dari grup',
    remoteJid: '1203630555666777@g.us',
    isGroup: true,
    fromMe: true
  });
  const unregEntry = enqueueAskQuestion(queueDir, {
    phone: '628555444333',
    name: '628555444333',
    category: 'default',
    question: 'Tes dari obrolan tak terdaftar',
    remoteJid: '628555444333@s.whatsapp.net',
    isGroup: false,
    fromMe: true
  });

  const { app } = createServerApp({
    llm,
    contextManager,
    knowledgeManager,
    toolRegistry,
    settingsStore,
    baileysService: mockBaileys,
    askQueueMonitor,
    uploadsDir
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Muse membalas ke grup cukup memakai name dari berkas antrean (kontrak lama tetap jalan!)
    const resGroup = await fetch(`${base}/api/send-to-contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: groupEntry.name, message: 'Jawaban untuk grup' })
    });
    assert.equal(resGroup.status, 200);
    const dataGroup = await resGroup.json();
    assert.equal(dataGroup.jid, '1203630555666777@g.us');
    assert.equal(delivered[0].historyKey, 'group:1203630555666777');

    // 2. Muse membalas ke obrolan tak terdaftar memakai phone dari berkas antrean
    const resUnreg = await fetch(`${base}/api/send-to-contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: unregEntry.phone, message: 'Jawaban untuk pribadi tak terdaftar' })
    });
    assert.equal(resUnreg.status, 200);
    const dataUnreg = await resUnreg.json();
    assert.equal(dataUnreg.jid, '628555444333@s.whatsapp.net');

    // 3. Muse juga bisa memakai askId atau jid eksplisit
    const resAskId = await fetch(`${base}/api/send-to-contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ askId: groupEntry.id, message: 'Balasan via askId' })
    });
    assert.equal(resAskId.status, 200);

    const resBadJid = await fetch(`${base}/api/send-to-contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: 'status@broadcast', message: 'Tidak valid' })
    });
    assert.equal(resBadJid.status, 400);

    // 4. Nama acak tak dikenal tetap 404
    const resMissing = await fetch(`${base}/api/send-to-contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'TidakAdaSamaSekali', message: 'Halo' })
    });
    assert.equal(resMissing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
