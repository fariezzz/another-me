/**
 * Ask Media Helper
 * Menyiapkan lampiran media untuk perintah `!ask` (khusus pemilik / fromMe):
 * - Menyimpan berkas media ke `data/ask-queue/media/`
 * - Mengonversi stiker & format gambar khusus menjadi PNG siap baca
 * - Mengekstrak hingga 3 bingkai gambar dari video/GIF melalui FFmpeg
 * - Mengekstrak teks dokumen (.pdf, .docx, .txt, .md, .csv, .json, kode)
 * - Menyusun ringkasan konteks media untuk diteruskan ke Muse melalui berkas antrean
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sharp = require('sharp');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { LIMIT_INPUT_PIXELS } = require('../media/imageProcessor');
const { unwrapWhatsAppMessage } = require('./utilityCommands');

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_ASK_MEDIA_BYTES = 15 * 1024 * 1024; // 15 Megabyte
const MIN_ASK_MEDIA_BYTES = 1 * 1024 * 1024;
const MAX_ASK_MEDIA_BYTES_CAP = 50 * 1024 * 1024;
const MAX_INLINE_DOC_EXCERPT_CHARS = 1500;
const MAX_QUOTED_TEXT_CHARS = 1000;

function resolveMaxAskMediaBytes(raw = process.env.MAX_ASK_MEDIA_BYTES) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_ASK_MEDIA_BYTES;
  return Math.min(MAX_ASK_MEDIA_BYTES_CAP, Math.max(MIN_ASK_MEDIA_BYTES, Math.floor(n)));
}

const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/heif': '.heif',
  'image/heic': '.heic',
  'image/tiff': '.tiff',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'audio/ogg': '.ogg',
  'audio/ogg; codecs=opus': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  'text/html': '.html',
  'text/css': '.css',
  'application/xml': '.xml',
  'text/xml': '.xml'
};

const TEXT_DOCUMENT_EXTS = new Set([
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.html',
  '.css',
  '.xml',
  '.yaml',
  '.yml',
  '.log',
  '.ini',
  '.sh',
  '.sql'
]);

function sanitizeFilenameSegment(rawName, fallback = 'lampiran') {
  const base = path.basename(String(rawName || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const trimmed = base.replace(/^\.+/, '').slice(0, 64);
  return trimmed || fallback;
}

function resolveExtension(mimeType, fileName, kind) {
  const cleanMime = String(mimeType || '')
    .toLowerCase()
    .split(';')[0]
    .trim();

  if (fileName) {
    const ext = path.extname(path.basename(String(fileName))).toLowerCase();
    if (/^\.[a-z0-9]{1,8}$/.test(ext)) {
      return ext;
    }
  }

  if (MIME_TO_EXT[cleanMime]) return MIME_TO_EXT[cleanMime];

  switch (kind) {
    case 'image':
      return '.jpg';
    case 'sticker':
      return '.webp';
    case 'video':
      return '.mp4';
    case 'audio':
      return '.ogg';
    default:
      return '.bin';
  }
}

/**
 * Mengekstrak teks pesan yang dibalas (reply / quotedMessage) bila pemilik membalas
 * pesan teks biasa (bukan media) dengan `!ask`.
 */
function extractQuotedText(msg, normalizedMessage) {
  const directContent = normalizedMessage || unwrapWhatsAppMessage(msg?.message);
  if (!directContent || typeof directContent !== 'object') return '';

  const ctxInfo =
    directContent.extendedTextMessage?.contextInfo ||
    directContent.imageMessage?.contextInfo ||
    directContent.videoMessage?.contextInfo ||
    directContent.documentMessage?.contextInfo ||
    null;

  if (!ctxInfo || !ctxInfo.quotedMessage) return '';
  const quoted = unwrapWhatsAppMessage(ctxInfo.quotedMessage);
  if (!quoted || typeof quoted !== 'object') return '';

  const text =
    quoted.conversation ||
    quoted.extendedTextMessage?.text ||
    quoted.imageMessage?.caption ||
    quoted.videoMessage?.caption ||
    quoted.documentMessage?.caption ||
    '';

  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (trimmed.length > MAX_QUOTED_TEXT_CHARS) {
    return `${trimmed.slice(0, MAX_QUOTED_TEXT_CHARS)}...`;
  }
  return trimmed;
}

async function probeVideoDurationWithFfmpeg(inputPath, ffmpegPath) {
  try {
    await execFileAsync(ffmpegPath, ['-i', inputPath], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return 0;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    const stderr = String(err?.stderr || '');
    const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return 0;
    const hours = Number(match[1]) || 0;
    const mins = Number(match[2]) || 0;
    const secs = Number(match[3]) || 0;
    return hours * 3600 + mins * 60 + secs;
  }
}

async function extractVideoKeyframes(inputPath, mediaDir, askId, durationHint, ffmpegPath) {
  const durationSeconds =
    durationHint > 0 ? durationHint : await probeVideoDurationWithFfmpeg(inputPath, ffmpegPath);

  let timestamps = [0];
  if (durationSeconds > 4) {
    timestamps = [
      Math.max(0, durationSeconds * 0.1),
      Math.max(0, durationSeconds * 0.5),
      Math.max(0, durationSeconds * 0.85)
    ];
  } else if (durationSeconds > 1.5) {
    timestamps = [Math.max(0, durationSeconds * 0.15), Math.max(0, durationSeconds * 0.75)];
  }

  const viewablePaths = [];
  const savedFiles = [];

  for (let i = 0; i < timestamps.length; i++) {
    const fileName = `${askId}_frame${i + 1}.jpg`;
    const outPath = path.join(mediaDir, fileName);
    const args = [
      '-y',
      '-ss',
      timestamps[i].toFixed(2),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-vf',
      "scale='min(1280,iw)':-2",
      '-q:v',
      '3',
      outPath
    ];

    try {
      await execFileAsync(ffmpegPath, args, {
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true
      });
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        viewablePaths.push(outPath);
        savedFiles.push(fileName);
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { viewablePaths: [], savedFiles: [], durationSeconds };
      }
    }
  }

  // Cadangan frame 0 tanpa -ss bila seek meleset karena metadata kontainer aneh
  if (viewablePaths.length === 0) {
    const fallbackName = `${askId}_frame1.jpg`;
    const fallbackPath = path.join(mediaDir, fallbackName);
    try {
      await execFileAsync(
        ffmpegPath,
        ['-y', '-i', inputPath, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', fallbackPath],
        {
          timeout: 15000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        }
      );
      if (fs.existsSync(fallbackPath) && fs.statSync(fallbackPath).size > 0) {
        viewablePaths.push(fallbackPath);
        savedFiles.push(fallbackName);
      }
    } catch {}
  }

  return {
    viewablePaths,
    savedFiles,
    durationSeconds: Math.round(durationSeconds * 10) / 10
  };
}

async function extractDocumentTextSafe(buffer, ext, mediaDir, askId) {
  let rawText = '';
  try {
    if (ext === '.pdf') {
      const parsed = await pdfParse(buffer);
      rawText = parsed?.text || '';
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ buffer });
      rawText = result?.value || '';
    } else if (TEXT_DOCUMENT_EXTS.has(ext)) {
      rawText = buffer.toString('utf-8');
      if (ext === '.json') {
        try {
          rawText = JSON.stringify(JSON.parse(rawText), null, 2);
        } catch {}
      }
    } else {
      return { extractedText: '', extractedTextPath: null, savedFiles: [] };
    }
  } catch {
    return { extractedText: '', extractedTextPath: null, savedFiles: [] };
  }

  const cleaned = String(rawText || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .trim();

  if (!cleaned) {
    return { extractedText: '', extractedTextPath: null, savedFiles: [] };
  }

  if (cleaned.length <= MAX_INLINE_DOC_EXCERPT_CHARS) {
    return { extractedText: cleaned, extractedTextPath: null, savedFiles: [] };
  }

  const txtName = `${askId}_extracted.txt`;
  const txtPath = path.join(mediaDir, txtName);
  fs.writeFileSync(txtPath, cleaned, 'utf-8');
  return {
    extractedText: `${cleaned.slice(0, MAX_INLINE_DOC_EXCERPT_CHARS)}\n... [terpotong, teks lengkap ${cleaned.length} karakter tersimpan di berkas terpisah]`,
    extractedTextPath: txtPath,
    savedFiles: [txtName]
  };
}

/**
 * Menyimpan berkas media `!ask` ke `<queueDir>/media/` beserta versi gambar/teks siap baca untuk Muse.
 */
async function prepareAskMediaAttachment({
  askId,
  queueDir,
  candidate,
  buffer,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Buffer media kosong.');
  }
  const maxBytes = resolveMaxAskMediaBytes();
  if (buffer.length > maxBytes) {
    const maxMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
    const err = new Error(`Ukuran media melebihi batas ${maxMb} Megabyte.`);
    err.code = 'TOO_LARGE';
    err.userMessage = `Maaf, ukuran media terlalu besar untuk !ask (maksimal ${maxMb} Megabyte).`;
    throw err;
  }

  const mediaDir = path.join(queueDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const kind = candidate.kind || 'document';
  const mimeType = String(candidate.mimeType || 'application/octet-stream');
  const savedFiles = [];
  let viewablePaths = [];
  let width = null;
  let height = null;
  let pages = 1;
  let durationSeconds = Number(candidate.seconds) || 0;
  let extractedText = '';
  let extractedTextPath = null;
  let originalPath = '';
  let originalFileName = '';

  if (kind === 'image' || kind === 'sticker') {
    let meta = null;
    try {
      meta = await sharp(buffer, { limitInputPixels: LIMIT_INPUT_PIXELS }).metadata();
    } catch {}

    const format = String(meta?.format || '').toLowerCase();
    const ext =
      format === 'jpeg'
        ? '.jpg'
        : format === 'png'
          ? '.png'
          : format === 'webp'
            ? '.webp'
            : format === 'gif'
              ? '.gif'
              : resolveExtension(mimeType, candidate.fileName, kind);

    originalFileName = `${askId}${ext}`;
    originalPath = path.join(mediaDir, originalFileName);
    fs.writeFileSync(originalPath, buffer);
    savedFiles.push(originalFileName);

    if (meta) {
      width = meta.width || null;
      height = meta.pageHeight || meta.height || null;
      pages = meta.pages || 1;
    }

    if (kind === 'image' && (format === 'jpeg' || format === 'png') && pages <= 1) {
      viewablePaths = [originalPath];
    } else if (meta) {
      // Konversi stiker/WebP/GIF/AVIF/HEIF menjadi PNG siap baca (hingga 3 bingkai bila animasi)
      const frameIndices =
        pages > 2 ? [0, Math.floor(pages / 2), pages - 1] : pages === 2 ? [0, 1] : [0];

      for (let idx = 0; idx < frameIndices.length; idx++) {
        const page = frameIndices[idx];
        const pngName =
          frameIndices.length === 1
            ? `${askId}_${kind === 'sticker' ? 'sticker' : 'view'}.png`
            : `${askId}_${kind === 'sticker' ? 'sticker' : 'frame'}${idx + 1}.png`;
        const pngPath = path.join(mediaDir, pngName);
        try {
          await sharp(buffer, { page, limitInputPixels: LIMIT_INPUT_PIXELS })
            .rotate()
            .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
            .png()
            .toFile(pngPath);
          viewablePaths.push(pngPath);
          savedFiles.push(pngName);
        } catch {}
      }

      if (viewablePaths.length === 0) {
        viewablePaths = [originalPath];
      }
    } else {
      viewablePaths = [originalPath];
    }
  } else if (kind === 'video') {
    const ext = resolveExtension(mimeType, candidate.fileName, 'video');
    originalFileName = `${askId}${ext}`;
    originalPath = path.join(mediaDir, originalFileName);
    fs.writeFileSync(originalPath, buffer);
    savedFiles.push(originalFileName);

    const frameResult = await extractVideoKeyframes(
      originalPath,
      mediaDir,
      askId,
      durationSeconds,
      ffmpegPath
    );
    viewablePaths = frameResult.viewablePaths;
    savedFiles.push(...frameResult.savedFiles);
    if (frameResult.durationSeconds > 0) {
      durationSeconds = frameResult.durationSeconds;
    }
  } else if (kind === 'audio') {
    const ext = resolveExtension(mimeType, candidate.fileName, 'audio');
    originalFileName = `${askId}${ext}`;
    originalPath = path.join(mediaDir, originalFileName);
    fs.writeFileSync(originalPath, buffer);
    savedFiles.push(originalFileName);
  } else {
    // Dokumen
    const ext = resolveExtension(mimeType, candidate.fileName, 'document');
    const safeName = candidate.fileName
      ? sanitizeFilenameSegment(candidate.fileName, `dokumen${ext}`)
      : `dokumen${ext}`;
    const finalSafeName = path.extname(safeName) ? safeName : `${safeName}${ext}`;
    originalFileName = `${askId}_${finalSafeName}`;
    originalPath = path.join(mediaDir, originalFileName);
    fs.writeFileSync(originalPath, buffer);
    savedFiles.push(originalFileName);

    const docText = await extractDocumentTextSafe(buffer, ext, mediaDir, askId);
    extractedText = docText.extractedText;
    extractedTextPath = docText.extractedTextPath;
    savedFiles.push(...docText.savedFiles);
  }

  return {
    kind,
    source: candidate.source || 'direct',
    mimeType,
    fileName: candidate.fileName || originalFileName,
    bytes: buffer.length,
    width,
    height,
    pages,
    durationSeconds: durationSeconds || null,
    gifPlayback: Boolean(candidate.gifPlayback),
    isVoiceNote: Boolean(candidate.ptt),
    caption: candidate.source === 'quoted' ? String(candidate.caption || '').trim() : '',
    filePath: originalPath,
    viewablePaths,
    extractedText: extractedText || null,
    extractedTextPath,
    savedFiles
  };
}

/**
 * Menyusun teks `question` lengkap dengan konteks lampiran media & pesan yang dibalas
 * agar Muse langsung melihat jalur berkas absolut dan teks dokumen meskipun hook eksternal
 * hanya meneruskan kolom `question`.
 */
function formatAskQuestionWithContext(rawQuestion, mediaMeta, quotedText = '') {
  const parts = [String(rawQuestion || '').trim()];

  if (quotedText && !mediaMeta) {
    parts.push(`[Konteks pesan yang dibalas: "${quotedText}"]`);
  }

  if (mediaMeta) {
    const typeLabel =
      mediaMeta.kind === 'image'
        ? 'foto'
        : mediaMeta.kind === 'sticker'
          ? mediaMeta.pages > 1
            ? 'stiker bergerak'
            : 'stiker'
          : mediaMeta.kind === 'video'
            ? mediaMeta.gifPlayback
              ? 'GIF'
              : 'video'
            : mediaMeta.kind === 'audio'
              ? mediaMeta.isVoiceNote
                ? 'pesan suara'
                : 'audio'
              : `dokumen "${mediaMeta.fileName || 'lampiran'}"`;

    const details = [`Jenis: ${typeLabel} (${mediaMeta.mimeType})`];
    if (mediaMeta.width && mediaMeta.height) {
      details.push(`Dimensi: ${mediaMeta.width}x${mediaMeta.height}`);
    }
    if (mediaMeta.durationSeconds) {
      details.push(`Durasi: ${mediaMeta.durationSeconds} detik`);
    }
    if (mediaMeta.caption) {
      details.push(`Keterangan media: "${mediaMeta.caption}"`);
    }
    if (Array.isArray(mediaMeta.viewablePaths) && mediaMeta.viewablePaths.length > 0) {
      details.push(`Berkas gambar siap baca: ${mediaMeta.viewablePaths.join(', ')}`);
    }
    if (
      mediaMeta.filePath &&
      (!Array.isArray(mediaMeta.viewablePaths) || !mediaMeta.viewablePaths.includes(mediaMeta.filePath))
    ) {
      details.push(`Berkas asli: ${mediaMeta.filePath}`);
    }
    if (mediaMeta.extractedTextPath) {
      details.push(`Berkas teks lengkap: ${mediaMeta.extractedTextPath}`);
    }

    let block = `[Lampiran Media !ask | ${details.join(' | ')}`;
    if (mediaMeta.extractedText) {
      block += `\nCuplikan isi dokumen:\n${mediaMeta.extractedText}`;
    }
    block += '\nSilakan buka dan periksa berkas media di atas untuk menjawab pertanyaan pemilik.]';
    parts.push(block);
  }

  return parts.filter(Boolean).join('\n\n');
}

/**
 * Menghapus berkas media terkait suatu item antrean dari `<queueDir>/media/` secara aman.
 */
function cleanupAskMediaFiles(queueDir, mediaMeta) {
  if (!mediaMeta || !Array.isArray(mediaMeta.savedFiles) || mediaMeta.savedFiles.length === 0) {
    return 0;
  }
  const mediaRoot = path.resolve(queueDir, 'media');
  let deleted = 0;
  for (const relName of mediaMeta.savedFiles) {
    const safeName = path.basename(String(relName || ''));
    if (!safeName) continue;
    const candidatePath = path.resolve(mediaRoot, safeName);
    if (!candidatePath.startsWith(mediaRoot + path.sep)) continue;
    try {
      if (fs.existsSync(candidatePath)) {
        fs.unlinkSync(candidatePath);
        deleted++;
      }
    } catch {}
  }
  return deleted;
}

module.exports = {
  DEFAULT_MAX_ASK_MEDIA_BYTES,
  resolveMaxAskMediaBytes,
  extractQuotedText,
  prepareAskMediaAttachment,
  formatAskQuestionWithContext,
  cleanupAskMediaFiles
};
