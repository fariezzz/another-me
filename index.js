/**
 * Another Me - Personal AI WhatsApp Auto-Reply & Web Dashboard
 * Titik masuk utama: merangkai komponen modular, server Express yang aman,
 * layanan Baileys WhatsApp, dan pemantau antrean !ask.
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const LLMClient = require('./src/llmClient');
const ContextManager = require('./src/contextManager');
const KnowledgeManager = require('./src/knowledgeManager');
const ToolRegistry = require('./src/tools/toolRegistry');
const SettingsStore = require('./src/settingsStore');
const BaileysService = require('./src/whatsapp/baileysService');
const { AskQueueMonitor } = require('./src/whatsapp/commandRouter');
const { createApiRouter } = require('./src/routes/apiRoutes');
const { cleanupOrphanedUploads } = require('./src/utils/atomicFile');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const UPLOADS_DIR = path.resolve(__dirname, 'uploads');

function buildAllowedOrigins(port) {
  const defaults = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    'https://another-me.kiraya.my.id'
  ];
  const extras = String(process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...defaults, ...extras]);
}

function createServerApp(deps = {}) {
  const activityLogs = deps.activityLogs || [];
  const addLog =
    deps.addLog ||
    function addLogEntry(type, text, meta = null) {
      const logItem = {
        id: Date.now() + Math.random().toString(36).substring(2, 5),
        time: new Date().toLocaleTimeString('id-ID', { hour12: false }),
        type,
        text,
        meta
      };
      activityLogs.unshift(logItem);
      if (activityLogs.length > 100) activityLogs.pop();
    };

  const llm = deps.llm || new LLMClient();
  const contextManager = deps.contextManager || new ContextManager();
  const knowledgeManager = deps.knowledgeManager || new KnowledgeManager();
  const toolRegistry = deps.toolRegistry || new ToolRegistry({ knowledgeManager });
  const settingsStore = deps.settingsStore || new SettingsStore();
  llm.setToolRegistry(toolRegistry);

  const askQueueMonitor =
    deps.askQueueMonitor ||
    new AskQueueMonitor({
      queueDir: path.resolve(__dirname, 'data/ask-queue'),
      addLog
    });

  const baileysService =
    deps.baileysService ||
    new BaileysService({
      llm,
      contextManager,
      knowledgeManager,
      settingsStore,
      addLog
    });

  const app = express();
  const allowedOrigins = buildAllowedOrigins(deps.port || PORT);

  // Header keamanan dasar
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // CORS ketat: hanya origin yang diizinkan (request tanpa Origin seperti curl/cron tetap lolos)
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) {
          return callback(null, true);
        }
        return callback(null, false);
      }
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.resolve(__dirname, 'public')));
  app.use('/stickers', express.static(toolRegistry.stickersDir));

  app.use(
    '/api',
    createApiRouter({
      llm,
      contextManager,
      knowledgeManager,
      toolRegistry,
      settingsStore,
      baileysService,
      askQueueMonitor,
      activityLogs,
      addLog,
      uploadsDir: deps.uploadsDir || UPLOADS_DIR
    })
  );

  return {
    app,
    llm,
    contextManager,
    knowledgeManager,
    toolRegistry,
    settingsStore,
    baileysService,
    askQueueMonitor,
    activityLogs,
    addLog
  };
}

if (require.main === module) {
  cleanupOrphanedUploads(UPLOADS_DIR);
  const ctx = createServerApp({ port: PORT });

  const server = ctx.app.listen(PORT, HOST, () => {
    console.log(`====================================================`);
    console.log(`🤖 Another Me - WhatsApp Auto-Reply Service`);
    console.log(`🌐 Dashboard UI : http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`🧠 Provider LLM : ${ctx.llm.model} (${ctx.llm.baseUrl})`);
    console.log(`====================================================`);
    ctx.askQueueMonitor.start();
    ctx.baileysService.start();
  });

  let shuttingDown = false;
  function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] Menerima sinyal ${signal}, menutup layanan dengan rapi...`);
    ctx.askQueueMonitor.stop();
    ctx.baileysService.shutdown();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('[UnhandledRejection]:', msg);
    ctx.addLog('error', `Unhandled Rejection: ${msg}`);
  });

  process.on('uncaughtException', (err) => {
    console.error('[UncaughtException]:', err.stack || err.message);
    ctx.addLog('error', `Uncaught Exception: ${err.message}`);
  });
}

module.exports = { createServerApp, buildAllowedOrigins };
