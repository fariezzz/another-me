const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseAskCommand,
  parseAcepCommand,
  enqueueAskQuestion,
  AskQueueMonitor
} = require('../src/whatsapp/commandRouter');
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
