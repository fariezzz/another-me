/**
 * Mesin Pengolah Gambar & Meme Berbasis Sharp
 * Menangani validasi batas 5 Megabyte, konversi stiker WhatsApp (!sticker / !toimg / !wm),
 * meme teks latar putih blur tipis (!text / !stext), serta meme gaya Impact untuk foto maupun
 * stiker diam/bergerak (!cap) dengan dua mode blur yang diatur lewat variabel environment
 * CAP_BLUR_MODE ('after' untuk blur sesudah caption, 'before' untuk blur sebelum caption).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Di Linux (seperti Muse Virtual Machine), daftarkan folder assets/fonts agar font cadangan
// Anton (lisensi SIL Open Font License 1.1) terbaca otomatis oleh Fontconfig/librsvg,
// sambil tetap mempertahankan FONTCONFIG_PATH sistem (/etc/fonts) agar font sistem seperti
// Impact juga terbaca oleh libfontconfig bawaan biner Sharp.
// Di Windows, sistem memakai font bawaan C:\Windows\Fonts (Impact & Arial Narrow).
if (process.platform !== 'win32') {
  if (!process.env.FONTCONFIG_PATH && fs.existsSync('/etc/fonts')) {
    process.env.FONTCONFIG_PATH = '/etc/fonts';
  }
  if (!process.env.FONTCONFIG_FILE) {
    const localFontsConf = path.resolve(__dirname, '../../assets/fonts/fonts.conf');
    if (fs.existsSync(localFontsConf)) {
      process.env.FONTCONFIG_FILE = localFontsConf;
    }
  }
}

const sharp = require('sharp');
const { injectWebpExif } = require('../utils/webpExif');
const {
  splitGraphemes,
  isEmojiGrapheme,
  hasEmoji,
  splitLineIntoRuns,
  fetchEmojiSvgBuffer
} = require('../utils/emojiRenderer');

const MAX_MEDIA_BYTES = parseInt(process.env.MAX_MEDIA_BYTES, 10) || 5 * 1024 * 1024; // 5 Megabyte
const MAX_ANIMATED_STICKER_BYTES = 500 * 1024; // 500 Kilobyte agar pasti diterima & diputar WhatsApp
const MAX_STICKER_AUDIO_BYTES = 900 * 1024; // 900 Kilobyte (aman di bawah batas ~950 KB stiker suara WhatsApp)
const MAX_VIDEO_INPUT_SECONDS = 15;
const MAX_CAP_VIDEO_SECONDS = 45;
const MAX_CROP_VIDEO_SECONDS = 60;
const MAX_CAP_CLEAN_PHOTO_DIM = 1600;
const MAX_CAP_CLEAN_VIDEO_DIM = 1080;
const DEFAULT_VIDEO_STICKER_SECONDS = clampNumber(
  parseInt(process.env.MAX_VIDEO_STICKER_SECONDS, 10),
  8,
  3,
  10
);
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const LIMIT_INPUT_PIXELS = 40_000_000;
const ALLOWED_IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif', 'heif']);

const DEFAULT_PACK_NAME = process.env.STICKER_PACK_NAME || 'Another Me';
const DEFAULT_PACK_AUTHOR = process.env.STICKER_PACK_AUTHOR || 'Fariez';
const DEFAULT_TEXT_BLUR_SIGMA = clampNumber(parseFloat(process.env.TEXT_BLUR_SIGMA), 2.0, 0.8, 4.0);
const DEFAULT_CAP_BLUR_SIGMA = clampNumber(
  parseFloat(process.env.CAP_BLUR_SIGMA || process.env.JMK_BLUR_SIGMA),
  2.8,
  0.8,
  10.0
);
const FALLBACK_CAP_TEXT_BLUR_SIGMA = 1.0;
const FALLBACK_CAP_MAX_DIM = 640;
const FALLBACK_CAP_FONT_SCALE = 1.0;
const VALID_CAP_BLUR_MODES = new Set(['before', 'after']);
const MAX_ANIMATED_CAP_FRAMES = 96;

function clampCapTextBlurSigma(value, fallback = FALLBACK_CAP_TEXT_BLUR_SIGMA) {
  if (!Number.isFinite(value)) return fallback;
  if (value < 0.3) return 0; // Nilai < 0.3 berarti teks tidak ikut didegradasi pada mode before
  return Math.min(4.0, value);
}

function resolveCapMaxDim(overrideMaxDim) {
  if (overrideMaxDim !== undefined && overrideMaxDim !== null && String(overrideMaxDim).trim() !== '') {
    return Math.round(clampNumber(Number(overrideMaxDim), FALLBACK_CAP_MAX_DIM, 240, 1080));
  }
  const rawEnv = process.env.CAP_MAX_DIM;
  if (rawEnv !== undefined && String(rawEnv).trim() !== '') {
    return Math.round(clampNumber(parseInt(rawEnv, 10), FALLBACK_CAP_MAX_DIM, 240, 1080));
  }
  return FALLBACK_CAP_MAX_DIM;
}

function resolveCapFontScale(overrideScale) {
  if (overrideScale !== undefined && overrideScale !== null && String(overrideScale).trim() !== '') {
    return clampNumber(Number(overrideScale), FALLBACK_CAP_FONT_SCALE, 0.5, 1.6);
  }
  const rawEnv = process.env.CAP_FONT_SCALE;
  if (rawEnv !== undefined && String(rawEnv).trim() !== '') {
    return clampNumber(parseFloat(rawEnv), FALLBACK_CAP_FONT_SCALE, 0.5, 1.6);
  }
  return FALLBACK_CAP_FONT_SCALE;
}

function resolveCapBlurMode(overrideMode) {
  const raw =
    overrideMode !== undefined && overrideMode !== null && String(overrideMode).trim() !== ''
      ? String(overrideMode)
      : String(process.env.CAP_BLUR_MODE || 'after');
  const normalized = raw.trim().toLowerCase();
  return VALID_CAP_BLUR_MODES.has(normalized) ? normalized : 'after';
}

function resolveCapBlurSigma(overrideSigma) {
  if (overrideSigma !== undefined && overrideSigma !== null && String(overrideSigma).trim() !== '') {
    return clampNumber(Number(overrideSigma), DEFAULT_CAP_BLUR_SIGMA, 0.8, 10.0);
  }
  const envVal = parseFloat(
    process.env.CAP_CRUSH_LEVEL || process.env.CAP_BLUR_SIGMA || process.env.JMK_BLUR_SIGMA
  );
  return clampNumber(envVal, DEFAULT_CAP_BLUR_SIGMA, 0.8, 10.0);
}

function resolveCapTextBlurSigma(overrideSigma) {
  if (overrideSigma !== undefined && overrideSigma !== null && String(overrideSigma).trim() !== '') {
    return clampCapTextBlurSigma(Number(overrideSigma), FALLBACK_CAP_TEXT_BLUR_SIGMA);
  }
  const rawEnv = process.env.CAP_TEXT_BLUR_SIGMA;
  if (rawEnv !== undefined && String(rawEnv).trim() !== '') {
    return clampCapTextBlurSigma(parseFloat(rawEnv), FALLBACK_CAP_TEXT_BLUR_SIGMA);
  }
  return FALLBACK_CAP_TEXT_BLUR_SIGMA;
}

/**
 * Mengonversi nilai intensitas burik (CAP_BLUR_SIGMA / CAP_CRUSH_LEVEL, rentang 0.8-10.0, default 2.8)
 * menjadi parameter siklus downscale -> kompresi kasar (JPEG/WebP) -> upscale khas meme shitpost.
 */
function computeCapDegradeParams(intensity) {
  const level = clampNumber(Number(intensity), 2.8, 0.8, 10.0);
  const scaleRatio = clampNumber(0.72 / (1 + 0.3 * level), 0.39, 0.16, 0.65);
  const crushQuality = Math.round(clampNumber(64 / (1 + 0.56 * level), 25, 8, 55));
  const finalQuality = Math.round(clampNumber(crushQuality + 16, 41, 18, 68));
  return { level, scaleRatio, crushQuality, finalQuality };
}

/**
 * Mengonversi nilai CAP_TEXT_BLUR_SIGMA (khusus mode 'before', rentang 0-4.0, default 1.0)
 * menjadi parameter kompresi penyatu ringan agar tepi teks ikut agak burik menyatu dengan foto.
 */
function computeCapTextDegradeParams(textLevel) {
  const level = clampCapTextBlurSigma(Number(textLevel), FALLBACK_CAP_TEXT_BLUR_SIGMA);
  if (level < 0.3) {
    return { enabled: false, level: 0, scaleRatio: 1, crushQuality: 84, finalQuality: 84 };
  }
  const scaleRatio = clampNumber(0.92 - 0.18 * level, 0.74, 0.36, 0.88);
  const crushQuality = Math.round(clampNumber(62 - 18 * level, 44, 16, 62));
  const finalQuality = Math.min(72, crushQuality + 10);
  return { enabled: true, level, scaleRatio, crushQuality, finalQuality };
}

const DEFAULT_CAP_BLUR_MODE = resolveCapBlurMode();
const DEFAULT_CAP_TEXT_BLUR_SIGMA = resolveCapTextBlurSigma();
const DEFAULT_CAP_MAX_DIM = resolveCapMaxDim();
const DEFAULT_CAP_FONT_SCALE = resolveCapFontScale();

class MediaValidationError extends Error {
  constructor(code, userMessage, logDetail = '') {
    super(logDetail || userMessage);
    this.name = 'MediaValidationError';
    this.code = code;
    this.userMessage = userMessage;
    this.logDetail = logDetail || '';
  }
}

function clampNumber(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Mengestimasi lebar relatif karakter dalam satuan em untuk pembungkusan baris SVG.
 * @param {string} ch
 * @param {'narrowSans'|'impact'} style
 */
function estimateCharWidthEm(ch, style) {
  if (isEmojiGrapheme(ch)) return 1.02;
  if (ch === ' ') return style === 'impact' ? 0.25 : 0.24;
  if ('iIljtf!|.,;:\'`'.includes(ch)) return style === 'impact' ? 0.28 : 0.27;
  if ('r()[]-/\\'.includes(ch)) return style === 'impact' ? 0.36 : 0.34;
  if ('MWmw@%#'.includes(ch)) return style === 'impact' ? 0.78 : 0.76;
  if (/[A-Z]/.test(ch)) return style === 'impact' ? 0.54 : 0.56;
  if (/[0-9]/.test(ch)) return style === 'impact' ? 0.52 : 0.50;
  // Karakter non-ASCII (simbol lebar lainnya) diberi ruang aman lebih besar
  if (ch.charCodeAt(0) > 127) return 0.92;
  return style === 'impact' ? 0.50 : 0.47;
}

function estimateTextWidthPx(text, fontSize, style) {
  let totalEm = 0;
  for (const ch of splitGraphemes(text)) {
    totalEm += estimateCharWidthEm(ch, style);
  }
  return totalEm * fontSize;
}

/**
 * Membungkus teks ke beberapa baris agar pas di dalam maxWidthPx.
 * Memecah kata sangat panjang yang tidak punya spasi agar tidak pernah keluar kanvas.
 */
function wrapTextLines(rawText, fontSize, maxWidthPx, style) {
  const paragraphs = String(rawText || '').replace(/\r\n/g, '\n').split('\n');
  const lines = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      if (lines.length > 0) lines.push('');
      continue;
    }

    const words = trimmed.split(/\s+/);
    let currentLine = '';

    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (estimateTextWidthPx(candidate, fontSize, style) <= maxWidthPx) {
        currentLine = candidate;
      } else {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = '';
        }
        // Jika satu kata tunggal lebih lebar dari kotak, pecah per grapheme utuh (tidak membelah emoji ZWJ)
        if (estimateTextWidthPx(word, fontSize, style) > maxWidthPx) {
          let chunk = '';
          for (const ch of splitGraphemes(word)) {
            if (chunk && estimateTextWidthPx(chunk + ch, fontSize, style) > maxWidthPx) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          currentLine = chunk;
        } else {
          currentLine = word;
        }
      }
    }

    if (currentLine) lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [''];
}

/**
 * Memvalidasi buffer masuk: harus <= 5 Megabyte dan berformat gambar valid yang dikenali Sharp.
 */
async function validateImageBuffer(buffer, { maxBytes = MAX_MEDIA_BYTES, requireWebp = false } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new MediaValidationError('EMPTY_BUFFER', 'Maaf, media gagal diunduh atau berkasnya kosong.');
  }
  if (buffer.length > maxBytes) {
    const maxMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
    throw new MediaValidationError(
      'TOO_LARGE',
      `Maaf, ukuran gambarnya melebihi batas maksimal ${maxMb} Megabyte. Coba kirim gambar yang lebih kecil ya.`
    );
  }

  let metadata;
  try {
    metadata = await sharp(buffer, { limitInputPixels: LIMIT_INPUT_PIXELS }).metadata();
  } catch {
    throw new MediaValidationError(
      'NOT_IMAGE',
      'Maaf, berkas yang dikirim bukan gambar yang valid atau berkasnya rusak.'
    );
  }

  if (!metadata || !metadata.format || !ALLOWED_IMAGE_FORMATS.has(metadata.format)) {
    throw new MediaValidationError(
      'NOT_IMAGE',
      'Maaf, format berkas ini tidak didukung. Kirim foto berformat gambar seperti Joint Photographic Experts Group (JPEG), Portable Network Graphics (PNG), atau Web Picture (WebP) ya.'
    );
  }

  if (requireWebp && metadata.format !== 'webp') {
    throw new MediaValidationError(
      'NOT_STICKER',
      'Maaf, perintah ini khusus untuk membalas stiker WhatsApp ya.'
    );
  }

  if (!metadata.width || !metadata.height) {
    throw new MediaValidationError(
      'NOT_IMAGE',
      'Maaf, dimensi gambar tidak dapat dibaca. Coba kirim ulang gambarnya ya.'
    );
  }

  return metadata;
}

/**
 * Memeriksa header magic bytes berkas animasi/video (GIF, MP4/MOV, WebM/MKV, AVI)
 * agar berkas bukan gambar/video yang disamarkan langsung ditolak sebelum masuk FFmpeg.
 */
function detectAnimatedMediaKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const ascii6 = buffer.subarray(0, 6).toString('ascii');
  if (ascii6 === 'GIF87a' || ascii6 === 'GIF89a') return 'gif';
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return 'webm';
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'AVI '
  ) {
    return 'avi';
  }
  return null;
}

/**
 * Fallback konversi GIF animasi murni menggunakan Sharp (jika FFmpeg tidak tersedia).
 */
async function convertAnimatedGifWithSharp(
  inputBuffer,
  { crop = false, packName = DEFAULT_PACK_NAME, author = DEFAULT_PACK_AUTHOR } = {}
) {
  const resizeOptions = crop
    ? { width: 512, height: 512, fit: 'cover', position: 'attention' }
    : {
        width: 512,
        height: 512,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      };

  // Kompresi bertahap agar hasil GIF Sharp juga mematuhi batas 500 Kilobyte WhatsApp (MEM-01)
  const qualities = [65, 42, 22];
  let finalWithExif = null;

  for (const quality of qualities) {
    const webpRaw = await sharp(inputBuffer, {
      animated: true,
      limitInputPixels: LIMIT_INPUT_PIXELS
    })
      .resize(resizeOptions)
      .webp({ quality, effort: 4, loop: 0 })
      .toBuffer();

    finalWithExif = injectWebpExif(webpRaw, {
      packName,
      author,
      width: 512,
      height: 512,
      hasAlpha: true
    });
    if (finalWithExif.length <= MAX_ANIMATED_STICKER_BYTES) {
      return finalWithExif;
    }
  }

  throw new MediaValidationError(
    'ANIMATED_TOO_LARGE',
    'Maaf, animasi GIF ini terlalu berat sehingga ukuran stiker bergeraknya masih melebihi batas 500 Kilobyte WhatsApp. Coba kirim GIF yang lebih singkat ya.'
  );
}

/**
 * Mengubah video pendek (.mp4/.webm/GIF WhatsApp) atau berkas .gif menjadi
 * stiker bergerak WhatsApp WebP 512x512 dengan kompresi adaptif (<= 500 Kilobyte)
 * dan metadata EXIF paket stiker.
 */
/**
 * Memeriksa info dasar stream video (apakah memiliki trek audio & durasi dalam detik)
 * melalui `ffmpeg -i` tanpa memerlukan biner `ffprobe`.
 */
async function probeVideoAudioInfo(inputPath, ffmpegPath = FFMPEG_PATH) {
  try {
    await execFileAsync(ffmpegPath, ['-i', inputPath], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return { hasAudio: false, durationSeconds: 0 };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { hasAudio: false, durationSeconds: 0 };
    }
    const stderr = String(err?.stderr || '');
    const hasAudio = /Stream\s+#\d+:\d+[^:\n]*:\s*Audio:/i.test(stderr);
    let durationSeconds = 0;
    const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (match) {
      durationSeconds =
        (Number(match[1]) || 0) * 3600 +
        (Number(match[2]) || 0) * 60 +
        (Number(match[3]) || 0);
    }
    return { hasAudio, durationSeconds };
  }
}

/**
 * Mengekstrak trek audio video menjadi berkas OGG/Opus murni (`audio/ogg; codecs=opus`,
 * tanpa stream video/sampul agar pasti diputar oleh fitur Stiker Suara WhatsApp).
 */
async function extractStickerOpusAudioFromFile(
  inputPath,
  outputPath,
  maxDurationSec,
  ffmpegPath = FFMPEG_PATH
) {
  const bitrates = ['48k', '24k'];
  for (const bitrate of bitrates) {
    const args = [
      '-y',
      '-i',
      inputPath,
      '-t',
      String(maxDurationSec),
      '-vn',
      '-map',
      '0:a:0',
      '-c:a',
      'libopus',
      '-b:a',
      bitrate,
      '-ac',
      '1',
      '-ar',
      '48000',
      '-application',
      'audio',
      outputPath
    ];

    await execFileAsync(ffmpegPath, args, {
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });

    if (fs.existsSync(outputPath)) {
      const audioBuf = fs.readFileSync(outputPath);
      if (audioBuf.length > 0 && audioBuf.length <= MAX_STICKER_AUDIO_BYTES) {
        return audioBuf;
      }
    }
  }
  return null;
}

async function convertVideoOrGifToSticker(
  inputBuffer,
  {
    crop = false,
    packName = DEFAULT_PACK_NAME,
    author = DEFAULT_PACK_AUTHOR,
    maxDurationSec = DEFAULT_VIDEO_STICKER_SECONDS,
    includeAudio = false,
    ffmpegPath = FFMPEG_PATH
  } = {}
) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new MediaValidationError('EMPTY_BUFFER', 'Maaf, media gagal diunduh atau berkasnya kosong.');
  }
  if (inputBuffer.length > MAX_MEDIA_BYTES) {
    const maxMb = Math.round((MAX_MEDIA_BYTES / (1024 * 1024)) * 10) / 10;
    throw new MediaValidationError(
      'TOO_LARGE',
      `Maaf, ukuran videonya melebihi batas maksimal ${maxMb} Megabyte. Coba kirim video atau GIF yang lebih kecil ya.`
    );
  }

  const detectedKind = detectAnimatedMediaKind(inputBuffer);
  if (!detectedKind) {
    throw new MediaValidationError(
      'NOT_MEDIA',
      'Maaf, format berkas video atau GIF ini tidak dikenali atau berkasnya rusak.'
    );
  }

  const safeDuration = clampNumber(Number(maxDurationSec), DEFAULT_VIDEO_STICKER_SECONDS, 3, 10);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-stk-'));
  const inputPath = path.join(tmpDir, `input.${detectedKind}`);
  const outputPath = path.join(tmpDir, 'output.webp');
  const audioOutPath = path.join(tmpDir, 'audio.ogg');

  const encodePass = async ({ fps, quality, duration }) => {
    const vf = crop
      ? `fps=${fps},scale=512:512:force_original_aspect_ratio=increase:flags=lanczos,crop=512:512,format=rgba`
      : `fps=${fps},scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;

    const args = [
      '-y',
      '-i',
      inputPath,
      '-t',
      String(duration),
      '-an',
      '-vf',
      vf,
      '-vcodec',
      'libwebp',
      '-lossless',
      '0',
      '-compression_level',
      '4',
      '-q:v',
      String(quality),
      '-loop',
      '0',
      '-preset',
      'default',
      outputPath
    ];

    await execFileAsync(ffmpegPath, args, {
      timeout: 25000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });
    return fs.readFileSync(outputPath);
  };

  try {
    fs.writeFileSync(inputPath, inputBuffer);

    // Kompresi adaptif bertahap agar hasil stiker bergerak <= 500 Kilobyte (termasuk EXIF) dan pasti diputar WhatsApp
    const passes = [
      { fps: 12, quality: 45, duration: safeDuration },
      { fps: 8, quality: 22, duration: Math.min(safeDuration, 6) },
      { fps: 6, quality: 12, duration: Math.min(safeDuration, 5) },
      { fps: 5, quality: 8, duration: Math.min(safeDuration, 3) }
    ];

    let finalSticker = null;
    let chosenDuration = safeDuration;
    for (const pass of passes) {
      const webpRaw = await encodePass(pass);
      finalSticker = injectWebpExif(webpRaw, {
        packName,
        author,
        width: 512,
        height: 512,
        hasAlpha: true
      });
      if (finalSticker.length <= MAX_ANIMATED_STICKER_BYTES) {
        chosenDuration = pass.duration;
        break;
      }
      finalSticker = null;
    }

    if (!finalSticker) {
      throw new MediaValidationError(
        'ANIMATED_TOO_LARGE',
        'Maaf, video atau GIF ini terlalu kompleks sehingga ukuran stiker bergeraknya masih melebihi batas 500 Kilobyte WhatsApp. Coba potong durasinya lebih pendek (3-4 detik) ya.'
      );
    }

    if (!includeAudio) {
      return finalSticker;
    }

    let audioBuffer = null;
    let audioSeconds = 0;
    if (detectedKind !== 'gif') {
      const streamInfo = await probeVideoAudioInfo(inputPath, ffmpegPath);
      if (streamInfo.hasAudio) {
        try {
          audioBuffer = await extractStickerOpusAudioFromFile(
            inputPath,
            audioOutPath,
            chosenDuration,
            ffmpegPath
          );
          if (audioBuffer) {
            const actualSec =
              streamInfo.durationSeconds > 0
                ? Math.min(streamInfo.durationSeconds, chosenDuration)
                : chosenDuration;
            audioSeconds = Math.max(1, Math.round(actualSec));
          }
        } catch {
          audioBuffer = null;
          audioSeconds = 0;
        }
      }
    }

    return {
      stickerBuffer: finalSticker,
      audioBuffer,
      audioSeconds,
      hasAudio: Boolean(audioBuffer)
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Untuk GIF asli, fallback ke Sharp animasi jika FFmpeg belum terpasang
      if (detectedKind === 'gif') {
        const sharpSticker = await convertAnimatedGifWithSharp(inputBuffer, { crop, packName, author });
        if (includeAudio) {
          return { stickerBuffer: sharpSticker, audioBuffer: null, audioSeconds: 0, hasAudio: false };
        }
        return sharpSticker;
      }
      throw new MediaValidationError(
        'FFMPEG_MISSING',
        'Maaf, fitur ubah video jadi stiker sedang belum bisa dipakai saat ini.',
        'FFmpeg tidak terpasang di sistem untuk konversi video menjadi stiker bergerak.'
      );
    }
    if (err instanceof MediaValidationError) throw err;
    throw new Error(`FFmpeg gagal mengonversi stiker bergerak: ${err.message}`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Mengubah gambar menjadi stiker WhatsApp WebP 512x512 dengan metadata paket EXIF.
 * Jika berkas adalah GIF animasi (> 1 bingkai), otomatis dikonversi menjadi stiker bergerak.
 */
async function convertImageToSticker(
  inputBuffer,
  { crop = false, packName = DEFAULT_PACK_NAME, author = DEFAULT_PACK_AUTHOR } = {}
) {
  const meta = await validateImageBuffer(inputBuffer);
  if (meta.format === 'gif' && meta.pages && meta.pages > 1) {
    return await convertVideoOrGifToSticker(inputBuffer, { crop, packName, author });
  }

  const resizeOptions = crop
    ? { width: 512, height: 512, fit: 'cover', position: 'attention' }
    : {
        width: 512,
        height: 512,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      };

  const webpRaw = await sharp(inputBuffer, { limitInputPixels: LIMIT_INPUT_PIXELS })
    .rotate()
    .resize(resizeOptions)
    .webp({ quality: 82, effort: 4 })
    .toBuffer();

  return injectWebpExif(webpRaw, {
    packName,
    author,
    width: 512,
    height: 512,
    hasAlpha: true
  });
}

/**
 * Mengubah stiker WhatsApp WebP menjadi gambar PNG.
 * Untuk stiker animasi, mengambil bingkai pertama secara aman.
 */
async function convertStickerToPng(webpBuffer) {
  const meta = await validateImageBuffer(webpBuffer, { requireWebp: true });
  const isAnimated = Boolean(meta.pages && meta.pages > 1);

  const pngBuffer = await sharp(webpBuffer, {
    limitInputPixels: LIMIT_INPUT_PIXELS,
    page: 0
  })
    .png()
    .toBuffer();

  return {
    buffer: pngBuffer,
    isAnimated,
    width: meta.width,
    height: meta.pageHeight || meta.height
  };
}

/**
 * Mengubah stiker bergerak WebP menjadi media GIF WhatsApp (MP4 H.264 untuk gifPlayback: true).
 * Langkah: dekode animasi WebP lewat Sharp (libwebp) -> GIF perantara -> FFmpeg H.264 MP4.
 * Jika FFmpeg tidak terpasang di sistem, fallback aman mengembalikan berkas .gif asli.
 */
async function convertAnimatedStickerToGif(webpBuffer, { ffmpegPath = FFMPEG_PATH } = {}) {
  const meta = await validateImageBuffer(webpBuffer, { requireWebp: true });

  // Sharp (libwebp) mendekode seluruh bingkai WebP animasi dan mempertahankan jeda antar bingkai
  const gifBuffer = await sharp(webpBuffer, {
    animated: true,
    limitInputPixels: LIMIT_INPUT_PIXELS
  })
    .flatten({ background: '#ffffff' })
    .gif()
    .toBuffer();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-togif-'));
  const gifPath = path.join(tmpDir, 'input.gif');
  const mp4Path = path.join(tmpDir, 'output.mp4');

  try {
    fs.writeFileSync(gifPath, gifBuffer);
    const args = [
      '-y',
      '-i',
      gifPath,
      '-movflags',
      '+faststart',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-an',
      mp4Path
    ];

    await execFileAsync(ffmpegPath, args, {
      timeout: 25000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });

    const mp4Buffer = fs.readFileSync(mp4Path);
    return {
      kind: 'gif',
      buffer: mp4Buffer,
      mimeType: 'video/mp4',
      isAnimated: true,
      width: meta.width,
      height: meta.pageHeight || meta.height
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        kind: 'gif_document',
        buffer: gifBuffer,
        mimeType: 'image/gif',
        isAnimated: true,
        width: meta.width,
        height: meta.pageHeight || meta.height
      };
    }
    throw new Error(`FFmpeg gagal mengonversi stiker bergerak ke GIF: ${err.message}`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Mengubah Stiker Suara WhatsApp (WebP diam maupun bergerak + audio OGG/Opus)
 * menjadi video MP4 H.264 bersuara (AAC) untuk perintah !toimg / .toimg.
 */
async function convertSoundStickerToVideo(
  webpBuffer,
  audioBuffer,
  { ffmpegPath = FFMPEG_PATH, maxDurationSec = 30 } = {}
) {
  const meta = await validateImageBuffer(webpBuffer, { requireWebp: true });
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new MediaValidationError(
      'EMPTY_AUDIO',
      'Maaf, suara pada stiker ini belum bisa diproses. Coba lagi ya.',
      'Data audio stiker suara kosong (EMPTY_AUDIO).'
    );
  }

  const isAnimated = Boolean(meta.pages && meta.pages > 1);
  const safeMaxDuration = clampNumber(Number(maxDurationSec), 30, 3, 60);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-tovid-'));
  const audioPath = path.join(tmpDir, 'audio.ogg');
  const mp4Path = path.join(tmpDir, 'output.mp4');

  try {
    fs.writeFileSync(audioPath, audioBuffer);
    let args;

    if (isAnimated) {
      const gifBuffer = await sharp(webpBuffer, {
        animated: true,
        limitInputPixels: LIMIT_INPUT_PIXELS
      })
        .flatten({ background: '#ffffff' })
        .gif()
        .toBuffer();
      const gifPath = path.join(tmpDir, 'input.gif');
      fs.writeFileSync(gifPath, gifBuffer);

      args = [
        '-y',
        '-stream_loop',
        '-1',
        '-i',
        gifPath,
        '-i',
        audioPath,
        '-t',
        String(safeMaxDuration),
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '22',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        '-shortest',
        mp4Path
      ];
    } else {
      const framePng = await sharp(webpBuffer, {
        limitInputPixels: LIMIT_INPUT_PIXELS,
        page: 0
      })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer();
      const framePath = path.join(tmpDir, 'frame.png');
      fs.writeFileSync(framePath, framePng);

      args = [
        '-y',
        '-loop',
        '1',
        '-framerate',
        '15',
        '-i',
        framePath,
        '-i',
        audioPath,
        '-t',
        String(safeMaxDuration),
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libx264',
        '-tune',
        'stillimage',
        '-preset',
        'veryfast',
        '-crf',
        '22',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        '-shortest',
        mp4Path
      ];
    }

    await execFileAsync(ffmpegPath, args, {
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });

    const mp4Buffer = fs.readFileSync(mp4Path);
    return {
      kind: 'video',
      buffer: mp4Buffer,
      mimeType: 'video/mp4',
      isAnimated,
      hasAudio: true,
      width: meta.width,
      height: meta.pageHeight || meta.height
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new MediaValidationError(
        'FFMPEG_MISSING',
        'Maaf, fitur ubah stiker bersuara jadi video sedang belum bisa dipakai saat ini.',
        'FFmpeg tidak terpasang di sistem untuk mengubah stiker bersuara menjadi video.'
      );
    }
    if (err instanceof MediaValidationError) throw err;
    throw new Error(`FFmpeg gagal mengubah stiker bersuara menjadi video: ${err.message}`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Konversi cerdas untuk perintah !toimg:
 * - Stiker bersuara (diam maupun bergerak) -> video MP4 bersuara
 * - Stiker diam tanpa suara -> gambar Portable Network Graphics (PNG)
 * - Stiker bergerak tanpa suara -> media GIF WhatsApp (MP4 gifPlayback: true)
 */
async function convertStickerToMedia(webpBuffer, options = {}) {
  if (Buffer.isBuffer(options?.audioBuffer) && options.audioBuffer.length > 0) {
    return await convertSoundStickerToVideo(webpBuffer, options.audioBuffer, options);
  }

  const meta = await validateImageBuffer(webpBuffer, { requireWebp: true });
  const isAnimated = Boolean(meta.pages && meta.pages > 1);

  if (isAnimated) {
    return await convertAnimatedStickerToGif(webpBuffer, options);
  }

  const pngRes = await convertStickerToPng(webpBuffer);
  return {
    kind: 'image',
    buffer: pngRes.buffer,
    mimeType: 'image/png',
    isAnimated: false,
    width: pngRes.width,
    height: pngRes.height
  };
}

/**
 * Mengganti metadata nama paket & pembuat (EXIF) pada stiker WebP tanpa re-encode gambar.
 */
async function rewriteStickerExif(
  webpBuffer,
  { packName = DEFAULT_PACK_NAME, author = DEFAULT_PACK_AUTHOR } = {}
) {
  const meta = await validateImageBuffer(webpBuffer, { requireWebp: true });
  return injectWebpExif(webpBuffer, {
    packName,
    author,
    width: meta.width || 512,
    height: meta.pageHeight || meta.height || 512,
    hasAlpha: Boolean(meta.hasAlpha)
  });
}

/**
 * Fitur 1: !text <teks> (dan !stext untuk versi stiker langsung)
 * Gambar latar putih polos, teks hitam sans-serif tebal, multi-baris, rata kiri,
 * lalu di-blur Gaussian tipis menyerupai meme teks blur referensi pertama.
 */
async function renderTextBlurImage(
  rawText,
  {
    blurSigma = DEFAULT_TEXT_BLUR_SIGMA,
    asSticker = false,
    packName = DEFAULT_PACK_NAME,
    author = DEFAULT_PACK_AUTHOR
  } = {}
) {
  const cleanedText = String(rawText || '').trim();
  if (!cleanedText) {
    throw new MediaValidationError(
      'INVALID_TEXT',
      'Pakai: !text <teks>, contoh: !text pro banget kak, problem'
    );
  }
  if (cleanedText.length > 220) {
    throw new MediaValidationError(
      'TEXT_TOO_LONG',
      'Maaf, teksnya kepanjangan (maksimal 220 karakter) supaya tetap terbaca jelas ya.'
    );
  }

  const canvasSize = 720;
  const padX = 62;
  const padY = 62;
  const maxWidth = canvasSize - padX * 2;
  const maxHeight = canvasSize - padY * 2;
  const lineHeightRatio = 1.08;

  // Cari ukuran font terbesar yang pas di dalam kotak persegi dengan margin lega
  let chosenSize = 30;
  let chosenLines = [cleanedText];

  for (let size = 132; size >= 26; size -= 2) {
    const lines = wrapTextLines(cleanedText, size, maxWidth * 0.94, 'narrowSans');
    const blockHeight = lines.length * size * lineHeightRatio;
    const widestLine = Math.max(...lines.map((l) => estimateTextWidthPx(l, size, 'narrowSans')));
    if (blockHeight <= maxHeight && widestLine <= maxWidth) {
      chosenSize = size;
      chosenLines = lines;
      break;
    }
  }

  const lineStep = Math.round(chosenSize * lineHeightRatio);
  const totalTextHeight = (chosenLines.length - 1) * lineStep + chosenSize;
  const startTop = Math.max(padY, Math.round((canvasSize - totalTextHeight) / 2));
  const firstBaselineY = Math.round(startTop + chosenSize * 0.82);

  const fontFamily =
    "'Arial Narrow', 'Liberation Sans Narrow', 'Archivo Narrow', 'Helvetica Neue', Arial, 'DejaVu Sans', sans-serif";

  const textNodes = chosenLines
    .map((line, idx) => {
      const y = firstBaselineY + idx * lineStep;
      return `<text x="${padX}" y="${y}" text-anchor="start" fill="#0b0b0b" font-family="${fontFamily}" font-size="${chosenSize}" font-weight="700" letter-spacing="-0.02em">${escapeXml(line)}</text>`;
    })
    .join('\n    ');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${canvasSize}" height="${canvasSize}" viewBox="0 0 ${canvasSize} ${canvasSize}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${textNodes}
</svg>`;

  const safeSigma = clampNumber(Number(blurSigma), DEFAULT_TEXT_BLUR_SIGMA, 0.8, 4.0);

  // Render SVG ke piksel putih murni lalu terapkan Gaussian blur tipis pada seluruh kanvas
  const renderedPng = await sharp(Buffer.from(svg, 'utf-8'))
    .flatten({ background: '#ffffff' })
    .blur(safeSigma)
    .png()
    .toBuffer();

  if (!asSticker) {
    return renderedPng;
  }

  const webpRaw = await sharp(renderedPng)
    .resize(512, 512, { fit: 'cover' })
    .webp({ quality: 85, effort: 4 })
    .toBuffer();

  return injectWebpExif(webpRaw, {
    packName,
    author,
    width: 512,
    height: 512,
    hasAlpha: false
  });
}

/**
 * Membagi teks menjadi 2 baris seimbang di batas kata sehingga lebar baris terpanjang seminimal mungkin.
 */
function splitBalancedTwoLines(text, style) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [String(text || '').trim()];

  let bestSplit = [words.slice(0, -1).join(' '), words[words.length - 1]];
  let bestMaxWidth = Infinity;

  for (let i = 1; i < words.length; i++) {
    const left = words.slice(0, i).join(' ');
    const right = words.slice(i).join(' ');
    const maxW = Math.max(
      estimateTextWidthPx(left, 100, style),
      estimateTextWidthPx(right, 100, style)
    );
    if (maxW < bestMaxWidth) {
      bestMaxWidth = maxW;
      bestSplit = [left, right];
    }
  }

  return bestSplit;
}

/**
 * Menghitung ukuran huruf dan baris yang pas untuk satu blok teks gaya Impact (atas atau bawah).
 * Prioritas tata letak:
 * 1. Pertahankan 1 baris selama masih terbaca jelas (tidak memotong "FARIEZ TIDUR" jadi 2 baris).
 * 2. Hanya pecah ke 2 baris seimbang bila teks memang panjang (atau pengguna memberi baris baru).
 * 3. Pecah ke 3 baris atau lebih hanya untuk kalimat yang sangat panjang.
 */
function layoutImpactBlock(upperText, imgWidth, imgHeight, fontScale) {
  const safeScale = resolveCapFontScale(fontScale);
  const maxWidth = imgWidth * 0.90;
  const maxBlockHeight = Math.min(imgHeight * 0.34, imgHeight * 0.235 * safeScale);
  const startSize = Math.max(
    18,
    Math.round(Math.min(imgWidth * 0.135, imgHeight * 0.12) * safeScale)
  );
  const minSize = Math.max(14, Math.round(imgWidth * 0.038 * safeScale));
  const lineHeightRatio = 1.06;
  const hasExplicitNewline = upperText.includes('\n');

  let chosenSize = minSize;
  let chosenLines = [upperText];
  let found = false;

  // Tahap 1: Prioritaskan 1 baris penuh selama ukuran huruf tetap proporsional & nyaman dibaca
  if (!hasExplicitNewline) {
    const singleLineMinSize = Math.max(minSize, Math.round(imgWidth * 0.088 * safeScale));
    const widthAtUnit = estimateTextWidthPx(upperText, 1, 'impact');
    if (widthAtUnit > 0) {
      const idealSingleSize = Math.floor((maxWidth * 0.94) / widthAtUnit);
      const clampedSingleSize = Math.min(startSize, idealSingleSize);
      if (clampedSingleSize >= singleLineMinSize && clampedSingleSize * lineHeightRatio <= maxBlockHeight) {
        chosenSize = clampedSingleSize;
        chosenLines = [upperText];
        found = true;
      }
    }
  }

  // Tahap 2: Jika memang terlalu panjang untuk 1 baris, prioritaskan 2 baris yang seimbang
  if (!found && !hasExplicitNewline) {
    const twoLineMinSize = Math.max(minSize, Math.round(imgWidth * 0.062 * safeScale));
    const balancedTwo = splitBalancedTwoLines(upperText, 'impact');
    if (balancedTwo.length === 2) {
      const widestUnit = Math.max(
        estimateTextWidthPx(balancedTwo[0], 1, 'impact'),
        estimateTextWidthPx(balancedTwo[1], 1, 'impact')
      );
      const maxSizeByHeight = Math.floor(maxBlockHeight / (2 * lineHeightRatio));
      const idealTwoSize = widestUnit > 0 ? Math.floor((maxWidth * 0.94) / widestUnit) : minSize;
      const clampedTwoSize = Math.min(startSize, maxSizeByHeight, idealTwoSize);
      if (clampedTwoSize >= twoLineMinSize) {
        chosenSize = clampedTwoSize;
        chosenLines = balancedTwo;
        found = true;
      }
    }
  }

  // Tahap 3: Fallback pembungkusan multi-baris untuk teks sangat panjang atau berisi newline eksplisit
  if (!found) {
    for (let size = startSize; size >= minSize; size -= 2) {
      const lines = wrapTextLines(upperText, size, maxWidth * 0.94, 'impact');
      const blockHeight = lines.length * size * lineHeightRatio;
      const widest = Math.max(...lines.map((l) => estimateTextWidthPx(l, size, 'impact')));
      if (lines.length <= 4 && blockHeight <= maxBlockHeight && widest <= maxWidth) {
        chosenSize = size;
        chosenLines = lines;
        found = true;
        break;
      }
    }
  }

  if (!found) {
    chosenSize = minSize;
    chosenLines = wrapTextLines(upperText, minSize, maxWidth * 0.94, 'impact');
  }

  const strokeWidth = Math.max(3, Math.round(chosenSize * 0.155));
  const lineStep = Math.round(chosenSize * lineHeightRatio);
  return { fontSize: chosenSize, lines: chosenLines, strokeWidth, lineStep };
}

/**
 * Membangun potongan SVG dua lapis untuk satu baris teks Impact tanpa emoji.
 */
function buildSingleImpactSvgLine(lineText, { centerX, y, fontSize, strokeWidth }) {
  const fontFamily = "'Impact', 'Anton', 'Arial Black', sans-serif";
  const escaped = escapeXml(lineText);
  return [
    `<text x="${centerX}" y="${Math.round(y)}" text-anchor="middle" fill="none" stroke="#000000" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round" font-family="${fontFamily}" font-size="${fontSize}" font-weight="400">${escaped}</text>`,
    `<text x="${centerX}" y="${Math.round(y)}" text-anchor="middle" fill="#ffffff" stroke="none" font-family="${fontFamily}" font-size="${fontSize}" font-weight="400">${escaped}</text>`
  ].join('\n  ');
}

/**
 * Membangun potongan SVG dua lapis (garis luar hitam tebal di bawah, isi putih di atas)
 * agar tampilan outline Impact selalu tajam dan konsisten di semua versi librsvg.
 */
function buildImpactTextSvgNodes(lines, { centerX, startBaselineY, fontSize, strokeWidth, lineStep }) {
  const nodes = [];
  for (let i = 0; i < lines.length; i++) {
    nodes.push(
      buildSingleImpactSvgLine(lines[i], {
        centerX,
        y: startBaselineY + i * lineStep,
        fontSize,
        strokeWidth
      })
    );
  }
  return nodes.join('\n  ');
}

/**
 * Memvalidasi dan menormalkan teks atas & bawah untuk perintah !cap.
 */
function validateCapTexts(topText, bottomText) {
  const cleanTop = String(topText || '').trim().toUpperCase();
  const cleanBottom = String(bottomText || '').trim().toUpperCase();

  if (!cleanTop && !cleanBottom) {
    throw new MediaValidationError(
      'INVALID_TEXT',
      'Pakai: kirim foto dengan caption atau balas foto/stiker dengan !cap <teks atas> | <teks bawah> (kalau cuma satu teks, otomatis ditaruh di bawah).'
    );
  }

  if (cleanTop.length + cleanBottom.length > 180) {
    throw new MediaValidationError(
      'TEXT_TOO_LONG',
      'Maaf, teks untuk !cap kepanjangan (maksimal 180 karakter total) supaya tetap rapi ya.'
    );
  }

  return { cleanTop, cleanBottom };
}

/**
 * Menghitung tata letak seluruh baris teks atas dan/atau bawah untuk !cap.
 */
function computeCapLineDescriptors({ imgWidth, imgHeight, cleanTop, cleanBottom, fontScale }) {
  const edgeMarginY = Math.max(12, Math.round(imgHeight * 0.032));
  const descriptors = [];

  if (cleanTop) {
    const topLayout = layoutImpactBlock(cleanTop, imgWidth, imgHeight, fontScale);
    const topStartY = edgeMarginY + Math.round(topLayout.fontSize * 0.88);
    for (let i = 0; i < topLayout.lines.length; i++) {
      descriptors.push({
        lineText: topLayout.lines[i],
        baselineY: Math.round(topStartY + i * topLayout.lineStep),
        fontSize: topLayout.fontSize,
        strokeWidth: topLayout.strokeWidth
      });
    }
  }

  if (cleanBottom) {
    const bottomLayout = layoutImpactBlock(cleanBottom, imgWidth, imgHeight, fontScale);
    const totalLinesOffset = (bottomLayout.lines.length - 1) * bottomLayout.lineStep;
    const bottomLastBaselineY =
      imgHeight - edgeMarginY - Math.round(bottomLayout.strokeWidth * 0.45);
    const bottomStartY = Math.max(
      Math.round(imgHeight * 0.55),
      bottomLastBaselineY - totalLinesOffset
    );
    for (let i = 0; i < bottomLayout.lines.length; i++) {
      descriptors.push({
        lineText: bottomLayout.lines[i],
        baselineY: Math.round(bottomStartY + i * bottomLayout.lineStep),
        fontSize: bottomLayout.fontSize,
        strokeWidth: bottomLayout.strokeWidth
      });
    }
  }

  return descriptors;
}

/**
 * Membangun lapisan SVG transparan berisi teks gaya Impact (atas dan/atau bawah)
 * yang siap ditempelkan ke foto maupun stiker.
 */
function buildCapOverlaySvg({ imgWidth, imgHeight, cleanTop, cleanBottom, fontScale }) {
  const centerX = Math.round(imgWidth / 2);
  const descriptors = computeCapLineDescriptors({
    imgWidth,
    imgHeight,
    cleanTop,
    cleanBottom,
    fontScale
  });
  const svgParts = descriptors.map((d) =>
    buildSingleImpactSvgLine(d.lineText, {
      centerX,
      y: d.baselineY,
      fontSize: d.fontSize,
      strokeWidth: d.strokeWidth
    })
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${imgWidth}" height="${imgHeight}" viewBox="0 0 ${imgWidth} ${imgHeight}" xmlns="http://www.w3.org/2000/svg">
  ${svgParts.join('\n  ')}
</svg>`;
}

/**
 * Merender satu baris campuran teks Impact + emoji berwarna penuh menjadi strip PNG RGBA
 * dengan pengukuran batas piksel teks yang presisi sehingga posisi emoji tidak pernah bertumpuk
 * maupun terlalu renggang, lalu disejajarkan tepat dengan garis dasar (baseline) teks.
 */
async function renderMixedImpactLineStrip({
  lineText,
  fontSize,
  strokeWidth,
  imgWidth,
  emojiSvgMap
}) {
  const fontFamily = "'Impact', 'Anton', 'Arial Black', sans-serif";
  const rawRuns = splitLineIntoRuns(lineText);

  // Gabungkan emoji yang gagal diambil ke segmen teks agar tetap tampil sebagai fallback
  const runs = [];
  for (const run of rawRuns) {
    if (run.type === 'emoji' && emojiSvgMap.get(run.value)) {
      runs.push(run);
    } else {
      const prev = runs[runs.length - 1];
      if (prev && prev.type === 'text') {
        prev.value += run.value;
      } else {
        runs.push({ type: 'text', value: run.value });
      }
    }
  }

  const spacePx = Math.max(6, Math.round(fontSize * 0.28));
  const emojiSize = Math.max(16, Math.round(fontSize * 0.96));
  const pad = Math.ceil(strokeWidth * 1.4);
  const baselineOffsetY = Math.round(fontSize * 0.96) + pad;
  const stripHeight = Math.round(fontSize * 1.25) + pad * 2;
  const items = [];

  for (const run of runs) {
    if (run.type === 'emoji') {
      const svgBuf = emojiSvgMap.get(run.value);
      const emojiPng = await sharp(svgBuf)
        .resize(emojiSize, emojiSize, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .ensureAlpha()
        .png()
        .toBuffer();
      const emojiTop = Math.max(
        0,
        Math.min(stripHeight - emojiSize, Math.round(baselineOffsetY - emojiSize * 0.87))
      );
      items.push({
        kind: 'emoji',
        buffer: emojiPng,
        width: emojiSize,
        height: emojiSize,
        top: emojiTop
      });
    } else {
      const leadingSpaces = (run.value.match(/^\s+/) || [''])[0].length;
      const trailingSpaces = (run.value.match(/\s+$/) || [''])[0].length;
      const core = run.value.trim();

      if (leadingSpaces > 0) {
        items.push({ kind: 'space', width: leadingSpaces * spacePx });
      }
      if (core) {
        const estW = Math.max(
          160,
          Math.ceil(estimateTextWidthPx(core, fontSize, 'impact') * 1.55) + pad * 6
        );
        const escaped = escapeXml(core);
        const segSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${estW}" height="${stripHeight}" viewBox="0 0 ${estW} ${stripHeight}" xmlns="http://www.w3.org/2000/svg">
  <text x="${pad * 2}" y="${baselineOffsetY}" text-anchor="start" fill="none" stroke="#000000" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round" font-family="${fontFamily}" font-size="${fontSize}" font-weight="400">${escaped}</text>
  <text x="${pad * 2}" y="${baselineOffsetY}" text-anchor="start" fill="#ffffff" stroke="none" font-family="${fontFamily}" font-size="${fontSize}" font-weight="400">${escaped}</text>
</svg>`;
        const rendered = await sharp(Buffer.from(segSvg, 'utf-8')).ensureAlpha().png().toBuffer();
        const { data, info } = await sharp(rendered)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        let minX = info.width;
        let maxX = -1;
        for (let y = 0; y < info.height; y++) {
          const rowStart = y * info.width * 4;
          for (let x = 0; x < info.width; x++) {
            if (data[rowStart + x * 4 + 3] > 8) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
        }
        if (maxX >= minX) {
          const cropW = maxX - minX + 1;
          const tightPng = await sharp(rendered)
            .extract({ left: minX, top: 0, width: cropW, height: info.height })
            .png()
            .toBuffer();
          items.push({
            kind: 'text',
            buffer: tightPng,
            width: cropW,
            height: info.height,
            top: 0
          });
        }
      }
      if (trailingSpaces > 0) {
        items.push({ kind: 'space', width: trailingSpaces * spacePx });
      }
    }
  }

  if (items.length === 0) return null;

  // Jarak tipis alami saat huruf & emoji langsung bersebelahan tanpa spasi (misal "BRO😹")
  const touchGap = Math.max(4, Math.round(fontSize * 0.08));
  let totalWidth = 0;
  const composites = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i > 0 && it.kind !== 'space' && items[i - 1].kind !== 'space') {
      totalWidth += touchGap;
    }
    if (it.buffer) {
      composites.push({ input: it.buffer, left: totalWidth, top: it.top });
    }
    totalWidth += it.width;
  }

  if (composites.length === 0 || totalWidth <= 0) return null;

  let stripBuf = await sharp({
    create: {
      width: totalWidth,
      height: stripHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(composites)
    .png()
    .toBuffer();

  const maxLineWidth = Math.max(32, Math.round(imgWidth * 0.94));
  let finalWidth = totalWidth;
  let finalHeight = stripHeight;
  let finalBaselineOffsetY = baselineOffsetY;

  if (totalWidth > maxLineWidth) {
    const scale = maxLineWidth / totalWidth;
    finalWidth = maxLineWidth;
    finalHeight = Math.max(1, Math.round(stripHeight * scale));
    finalBaselineOffsetY = Math.round(baselineOffsetY * scale);
    stripBuf = await sharp(stripBuf).resize(finalWidth, finalHeight).png().toBuffer();
  }

  return {
    buffer: stripBuf,
    width: finalWidth,
    height: finalHeight,
    baselineOffsetY: finalBaselineOffsetY
  };
}

/**
 * Merender lapisan teks Impact (beserta emoji berwarna penuh Twemoji bila ada) menjadi PNG RGBA.
 * Jika textBlurSigma >= 0.3 (khusus mode 'before'), seluruh lapisan teks & emoji ikut di-blur tipis terpisah.
 */
async function renderCapOverlayPng({
  imgWidth,
  imgHeight,
  cleanTop,
  cleanBottom,
  textBlurSigma = 0,
  fontScale,
  emojiOptions = {}
}) {
  const centerX = Math.round(imgWidth / 2);
  const descriptors = computeCapLineDescriptors({
    imgWidth,
    imgHeight,
    cleanTop,
    cleanBottom,
    fontScale
  });
  const pureSvgParts = [];
  const emojiDescriptors = [];

  for (const desc of descriptors) {
    if (hasEmoji(desc.lineText)) {
      emojiDescriptors.push(desc);
    } else {
      pureSvgParts.push(
        buildSingleImpactSvgLine(desc.lineText, {
          centerX,
          y: desc.baselineY,
          fontSize: desc.fontSize,
          strokeWidth: desc.strokeWidth
        })
      );
    }
  }

  let overlayPng;

  if (emojiDescriptors.length === 0) {
    const overlaySvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${imgWidth}" height="${imgHeight}" viewBox="0 0 ${imgWidth} ${imgHeight}" xmlns="http://www.w3.org/2000/svg">
  ${pureSvgParts.join('\n  ')}
</svg>`;
    overlayPng = await sharp(Buffer.from(overlaySvg, 'utf-8'))
      .resize(imgWidth, imgHeight)
      .ensureAlpha()
      .png()
      .toBuffer();
  } else {
    // Ambil seluruh ikon SVG emoji unik secara paralel (instan dari cache jika sudah pernah dipakai)
    const uniqueEmojiRuns = new Map();
    for (const desc of emojiDescriptors) {
      for (const run of splitLineIntoRuns(desc.lineText)) {
        if (run.type === 'emoji' && !uniqueEmojiRuns.has(run.value)) {
          uniqueEmojiRuns.set(run.value, run.candidates);
        }
      }
    }

    const emojiSvgMap = new Map();
    await Promise.all(
      Array.from(uniqueEmojiRuns.entries()).map(async ([emojiStr, candidates]) => {
        const svgBuf = await fetchEmojiSvgBuffer(candidates, emojiOptions);
        if (svgBuf) {
          emojiSvgMap.set(emojiStr, svgBuf);
        }
      })
    );

    const stripComposites = [];
    for (const desc of emojiDescriptors) {
      const hasResolvedEmoji = splitLineIntoRuns(desc.lineText).some(
        (run) => run.type === 'emoji' && emojiSvgMap.has(run.value)
      );
      if (!hasResolvedEmoji) {
        // Fallback aman jika seluruh emoji gagal diambil (misal offline total & belum di-cache)
        pureSvgParts.push(
          buildSingleImpactSvgLine(desc.lineText, {
            centerX,
            y: desc.baselineY,
            fontSize: desc.fontSize,
            strokeWidth: desc.strokeWidth
          })
        );
        continue;
      }

      const strip = await renderMixedImpactLineStrip({
        lineText: desc.lineText,
        fontSize: desc.fontSize,
        strokeWidth: desc.strokeWidth,
        imgWidth,
        emojiSvgMap
      });
      if (strip) {
        const left = Math.max(0, Math.round((imgWidth - strip.width) / 2));
        const top = Math.max(
          0,
          Math.min(imgHeight - strip.height, Math.round(desc.baselineY - strip.baselineOffsetY))
        );
        stripComposites.push({ input: strip.buffer, left, top });
      }
    }

    let baseCanvas;
    if (pureSvgParts.length > 0) {
      const baseSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${imgWidth}" height="${imgHeight}" viewBox="0 0 ${imgWidth} ${imgHeight}" xmlns="http://www.w3.org/2000/svg">
  ${pureSvgParts.join('\n  ')}
</svg>`;
      baseCanvas = await sharp(Buffer.from(baseSvg, 'utf-8'))
        .resize(imgWidth, imgHeight)
        .ensureAlpha()
        .png()
        .toBuffer();
    } else {
      baseCanvas = await sharp({
        create: {
          width: imgWidth,
          height: imgHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      })
        .png()
        .toBuffer();
    }

    overlayPng =
      stripComposites.length > 0
        ? await sharp(baseCanvas).composite(stripComposites).png().toBuffer()
        : baseCanvas;
  }

  // Blur tipis khusus mode 'before' diterapkan SETELAH seluruh teks & emoji selesai disusun
  if (textBlurSigma >= 0.3) {
    return await sharp(overlayPng).blur(textBlurSigma).png().toBuffer();
  }

  return overlayPng;
}

/**
 * Mengurangi jumlah bingkai animasi dengan menggabungkan jeda (delay) bingkai yang dilewati
 * agar kecepatan putar total animasi tetap sama dan minimal menyisakan 2 bingkai.
 */
function subsampleFrames(frames, delays, step) {
  if (step <= 1 || frames.length <= 2) {
    return { frames, delays };
  }
  const effectiveStep = Math.max(1, Math.min(step, frames.length - 1));
  const outFrames = [];
  const outDelays = [];
  for (let i = 0; i < frames.length; i += effectiveStep) {
    outFrames.push(frames[i]);
    let summedDelay = 0;
    for (let j = i; j < Math.min(frames.length, i + effectiveStep); j++) {
      summedDelay += delays[j] || 80;
    }
    outDelays.push(summedDelay);
  }
  return { frames: outFrames, delays: outDelays };
}

/**
 * Menerapkan siklus degradasi "burik" khas meme shitpost pada foto (tanpa Gaussian blur halus):
 * perkecil resolusi (downscale) -> kompres JPEG kualitas rendah tanpa mozjpeg (blok 8x8 DCT + mosquito noise)
 * -> tarik balik (upscale) ke ukuran kanvas target.
 */
async function degradePhotoCrustyJpeg(
  pngBuffer,
  { width, height, scaleRatio, crushQuality, finalQuality, returnPng = false }
) {
  const crushW = Math.max(64, Math.round(width * scaleRatio));
  const crushH = Math.max(64, Math.round(height * scaleRatio));

  const tinyJpg = await sharp(pngBuffer)
    .resize(crushW, crushH, { kernel: 'cubic', fit: 'fill' })
    .jpeg({ quality: crushQuality, mozjpeg: false, chromaSubsampling: '4:2:0' })
    .toBuffer();

  const upscaled = sharp(tinyJpg).resize(width, height, { kernel: 'linear', fit: 'fill' });
  if (returnPng) {
    return await upscaled.png().toBuffer();
  }
  return await upscaled
    .jpeg({ quality: finalQuality, mozjpeg: false, chromaSubsampling: '4:2:0' })
    .toBuffer();
}

/**
 * Menerapkan siklus degradasi "burik" yang setara untuk stiker WebP bertransparansi (RGBA):
 * perkecil resolusi -> kompres WebP lossy kasar (tetap menjaga saluran alpha!) -> tarik balik ke 512x512.
 */
async function degradeRgbaStickerCrusty(
  inputBuf,
  { isRaw = false, width, height, scaleRatio, crushQuality, returnRaw = false }
) {
  const crushW = Math.max(64, Math.round(width * scaleRatio));
  const crushH = Math.max(64, Math.round(height * scaleRatio));

  const srcPipeline = isRaw
    ? sharp(inputBuf, { raw: { width, height, channels: 4 } })
    : sharp(inputBuf);

  const tinyWebp = await srcPipeline
    .resize(crushW, crushH, { kernel: 'cubic', fit: 'fill' })
    .webp({ quality: crushQuality, effort: 1, alphaQuality: 78 })
    .toBuffer();

  const upscaled = sharp(tinyWebp)
    .resize(width, height, { kernel: 'linear', fit: 'fill' })
    .ensureAlpha();

  return returnRaw ? await upscaled.raw().toBuffer() : await upscaled.png().toBuffer();
}

/**
 * Fitur 2a: !cap <teks atas> | <teks bawah> pada foto (alias !caption / !burem / .cap / .caption)
 * Menghasilkan gaya meme shitpost "burik" (downscale -> kompresi JPEG rendah -> upscale, bukan blur lensa)
 * dengan dua mode urutan yang diatur lewat variabel environment CAP_BLUR_MODE:
 * - 'after' (bawaan, gaya PENGALAMAN PAHIT / IJIN TAMPIL):
 *     Tahap 1: Tempel teks Impact besar + emoji berwarna ke foto terlebih dahulu.
 *     Tahap 2: Burikkan SELURUH gambar hasil akhir bersama teks secara seragam.
 * - 'before' (gaya KESALAHAN POLA PIKIR / BERSIAPLAH):
 *     Tahap 1: Burikkan foto dasar terlebih dahulu sebelum teks.
 *     Tahap 2: Tempel teks Impact besar + emoji berwarna, lalu beri kompresi penyatu ringan (CAP_TEXT_BLUR_SIGMA).
 */
async function renderCapMeme(
  inputBuffer,
  {
    topText = '',
    bottomText = '',
    clean = false,
    blurSigma,
    textBlurSigma,
    blurMode,
    maxDim: overrideMaxDim,
    fontScale,
    emojiOptions,
    returnStages = false
  } = {}
) {
  const { cleanTop, cleanBottom } = validateCapTexts(topText, bottomText);
  const meta = await validateImageBuffer(inputBuffer);
  const isClean = Boolean(clean);
  const activeBlurMode = isClean ? 'none' : resolveCapBlurMode(blurMode);
  const safeSigma = isClean ? 0 : resolveCapBlurSigma(blurSigma);
  const activeTextBlurSigma =
    !isClean && activeBlurMode === 'before' ? resolveCapTextBlurSigma(textBlurSigma) : 0;
  const targetMaxDim = isClean
    ? overrideMaxDim !== undefined && overrideMaxDim !== ''
      ? Math.round(clampNumber(Number(overrideMaxDim), MAX_CAP_CLEAN_PHOTO_DIM, 240, 2048))
      : MAX_CAP_CLEAN_PHOTO_DIM
    : resolveCapMaxDim(overrideMaxDim);
  const activeFontScale = resolveCapFontScale(fontScale);
  const degradeParams = computeCapDegradeParams(safeSigma);
  const textDegradeParams = computeCapTextDegradeParams(activeTextBlurSigma);

  // Pra-tahap: perbaiki rotasi EXIF dan normalkan ukuran kanvas
  // (mode burik: CAP_MAX_DIM bawaan 640 piksel; mode jernih/clean: pertahankan resolusi hingga 1600 piksel).
  let basePipeline = sharp(inputBuffer, { limitInputPixels: LIMIT_INPUT_PIXELS }).rotate();
  const srcMaxDim = Math.max(meta.width || 0, meta.height || 0);
  const minDim = isClean ? 0 : Math.min(360, targetMaxDim);
  if (srcMaxDim > targetMaxDim) {
    basePipeline = basePipeline.resize({
      width: targetMaxDim,
      height: targetMaxDim,
      fit: 'inside',
      withoutEnlargement: true
    });
  } else if (minDim > 0 && srcMaxDim > 0 && srcMaxDim < minDim) {
    basePipeline = basePipeline.resize({
      width: targetMaxDim,
      height: targetMaxDim,
      fit: 'inside',
      withoutEnlargement: false
    });
  }

  const normalized = await basePipeline.png().toBuffer({ resolveWithObject: true });
  const imgWidth = normalized.info.width;
  const imgHeight = normalized.info.height;
  const overlayPng = await renderCapOverlayPng({
    imgWidth,
    imgHeight,
    cleanTop,
    cleanBottom,
    textBlurSigma: 0,
    fontScale: activeFontScale,
    emojiOptions
  });

  let stage1Buffer;
  let finalBuffer;

  if (isClean) {
    // MODE CLEAN / JERNIH (!caphd / !meme): tempel teks Impact + emoji berwarna langsung tanpa pemburikan.
    stage1Buffer = await sharp(normalized.data)
      .composite([{ input: overlayPng, top: 0, left: 0 }])
      .png()
      .toBuffer();

    const keepPng = Boolean(meta.hasAlpha && (meta.format === 'png' || meta.format === 'webp'));
    finalBuffer = keepPng
      ? stage1Buffer
      : await sharp(stage1Buffer)
          .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
          .toBuffer();
  } else if (activeBlurMode === 'before') {
    // =========================================================================
    // MODE BEFORE — TAHAP 1: Burikkan foto dasar terlebih dahulu (downscale -> JPEG -> upscale).
    // =========================================================================
    stage1Buffer = await degradePhotoCrustyJpeg(normalized.data, {
      width: imgWidth,
      height: imgHeight,
      scaleRatio: degradeParams.scaleRatio,
      crushQuality: degradeParams.crushQuality,
      finalQuality: degradeParams.finalQuality,
      returnPng: true
    });

    // =========================================================================
    // MODE BEFORE — TAHAP 2: Tempel teks Impact besar + emoji berwarna, lalu
    // beri satu lapis kompresi JPEG penyatu ringan bila CAP_TEXT_BLUR_SIGMA >= 0.3.
    // =========================================================================
    const composited = await sharp(stage1Buffer)
      .composite([{ input: overlayPng, top: 0, left: 0 }])
      .png()
      .toBuffer();

    if (textDegradeParams.enabled) {
      finalBuffer = await degradePhotoCrustyJpeg(composited, {
        width: imgWidth,
        height: imgHeight,
        scaleRatio: textDegradeParams.scaleRatio,
        crushQuality: textDegradeParams.crushQuality,
        finalQuality: textDegradeParams.finalQuality,
        returnPng: false
      });
    } else {
      finalBuffer = await sharp(composited)
        .jpeg({ quality: 84, mozjpeg: false, chromaSubsampling: '4:2:0' })
        .toBuffer();
    }
  } else {
    // =========================================================================
    // MODE AFTER — TAHAP 1: Tempelkan teks Impact besar + emoji berwarna ke foto.
    // =========================================================================
    stage1Buffer = await sharp(normalized.data)
      .composite([{ input: overlayPng, top: 0, left: 0 }])
      .png()
      .toBuffer();

    // =========================================================================
    // MODE AFTER — TAHAP 2: Setelah foto + teks menyatu, burikkan SELURUH gambar
    // secara bersamaan (downscale -> JPEG rendah tanpa mozjpeg -> upscale).
    // =========================================================================
    finalBuffer = await degradePhotoCrustyJpeg(stage1Buffer, {
      width: imgWidth,
      height: imgHeight,
      scaleRatio: degradeParams.scaleRatio,
      crushQuality: degradeParams.crushQuality,
      finalQuality: degradeParams.finalQuality,
      returnPng: false
    });
  }

  if (returnStages) {
    return {
      blurMode: activeBlurMode,
      stage1Buffer,
      composedBuffer: activeBlurMode === 'after' ? stage1Buffer : null,
      blurredBaseBuffer: activeBlurMode === 'before' ? stage1Buffer : null,
      finalBuffer,
      width: imgWidth,
      height: imgHeight,
      blurSigma: safeSigma,
      textBlurSigma: activeTextBlurSigma,
      fontScale: activeFontScale
    };
  }

  return finalBuffer;
}

/**
 * Fitur 2b: !cap <teks atas> | <teks bawah> khusus untuk stiker WebP (diam maupun bergerak).
 * Hasil tetap berbentuk stiker WhatsApp WebP 512x512 dengan metadata EXIF & transparansi terjaga,
 * memakai siklus degradasi burik WebP lossy (downscale -> WebP kasar -> upscale) mengikuti
 * CAP_BLUR_MODE ('after' atau 'before') serta CAP_TEXT_BLUR_SIGMA khusus pada mode 'before'.
 * Untuk stiker bergerak (> 1 bingkai), tiap bingkai diproses terpisah tanpa rembesan antar bingkai
 * dan dikompresi adaptif agar hasil akhir termasuk EXIF selalu <= 500 Kilobyte.
 */
async function renderCapSticker(
  webpBuffer,
  {
    topText = '',
    bottomText = '',
    clean = false,
    blurSigma,
    textBlurSigma,
    blurMode,
    fontScale,
    emojiOptions,
    packName = DEFAULT_PACK_NAME,
    author = DEFAULT_PACK_AUTHOR,
    returnStages = false
  } = {}
) {
  const { cleanTop, cleanBottom } = validateCapTexts(topText, bottomText);
  const meta = await validateImageBuffer(webpBuffer, { requireWebp: true });
  const isClean = Boolean(clean);
  const activeBlurMode = isClean ? 'none' : resolveCapBlurMode(blurMode);
  const safeSigma = isClean ? 0 : resolveCapBlurSigma(blurSigma);
  const activeTextBlurSigma =
    !isClean && activeBlurMode === 'before' ? resolveCapTextBlurSigma(textBlurSigma) : 0;
  const activeFontScale = resolveCapFontScale(fontScale);
  const degradeParams = computeCapDegradeParams(safeSigma);
  const textDegradeParams = computeCapTextDegradeParams(activeTextBlurSigma);
  const targetSize = 512;

  const overlayPng = await renderCapOverlayPng({
    imgWidth: targetSize,
    imgHeight: targetSize,
    cleanTop,
    cleanBottom,
    textBlurSigma: 0,
    fontScale: activeFontScale,
    emojiOptions
  });

  const isAnimated = Boolean(meta.pages && meta.pages > 1);

  if (!isAnimated) {
    const basePng = await sharp(webpBuffer, {
      limitInputPixels: LIMIT_INPUT_PIXELS,
      page: 0
    })
      .rotate()
      .resize({
        width: targetSize,
        height: targetSize,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .ensureAlpha()
      .png()
      .toBuffer();

    let stage1Buffer;
    let webpRaw;

    if (isClean) {
      stage1Buffer = await sharp(basePng)
        .composite([{ input: overlayPng, top: 0, left: 0 }])
        .png()
        .toBuffer();

      webpRaw = await sharp(stage1Buffer).webp({ quality: 90, effort: 4 }).toBuffer();
    } else if (activeBlurMode === 'before') {
      stage1Buffer = await degradeRgbaStickerCrusty(basePng, {
        isRaw: false,
        width: targetSize,
        height: targetSize,
        scaleRatio: degradeParams.scaleRatio,
        crushQuality: degradeParams.crushQuality,
        returnRaw: false
      });

      const composited = await sharp(stage1Buffer)
        .composite([{ input: overlayPng, top: 0, left: 0 }])
        .png()
        .toBuffer();

      const finalPng = textDegradeParams.enabled
        ? await degradeRgbaStickerCrusty(composited, {
            isRaw: false,
            width: targetSize,
            height: targetSize,
            scaleRatio: textDegradeParams.scaleRatio,
            crushQuality: textDegradeParams.crushQuality,
            returnRaw: false
          })
        : composited;

      webpRaw = await sharp(finalPng)
        .webp({ quality: textDegradeParams.enabled ? textDegradeParams.finalQuality : 84, effort: 4 })
        .toBuffer();
    } else {
      stage1Buffer = await sharp(basePng)
        .composite([{ input: overlayPng, top: 0, left: 0 }])
        .png()
        .toBuffer();

      const degradedPng = await degradeRgbaStickerCrusty(stage1Buffer, {
        isRaw: false,
        width: targetSize,
        height: targetSize,
        scaleRatio: degradeParams.scaleRatio,
        crushQuality: degradeParams.crushQuality,
        returnRaw: false
      });

      webpRaw = await sharp(degradedPng)
        .webp({ quality: degradeParams.finalQuality, effort: 4 })
        .toBuffer();
    }

    const finalBuffer = injectWebpExif(webpRaw, {
      packName,
      author,
      width: targetSize,
      height: targetSize,
      hasAlpha: true
    });

    if (returnStages) {
      return {
        isAnimated: false,
        blurMode: activeBlurMode,
        stage1Buffer,
        composedBuffer: activeBlurMode === 'after' ? stage1Buffer : null,
        blurredBaseBuffer: activeBlurMode === 'before' ? stage1Buffer : null,
        finalBuffer,
        width: targetSize,
        height: targetSize,
        pages: 1,
        blurSigma: safeSigma,
        textBlurSigma: activeTextBlurSigma,
        fontScale: activeFontScale
      };
    }

    return finalBuffer;
  }

  // Cabang stiker bergerak (> 1 bingkai)
  const totalPages = meta.pages;
  const frameW = meta.width;
  const frameH = meta.pageHeight || meta.height;
  const rawDelays =
    Array.isArray(meta.delay) && meta.delay.length === totalPages
      ? meta.delay.map((d) => (Number.isFinite(d) && d > 0 ? Math.round(d) : 80))
      : Array(totalPages).fill(80);

  const initialStep =
    totalPages > MAX_ANIMATED_CAP_FRAMES ? Math.ceil(totalPages / MAX_ANIMATED_CAP_FRAMES) : 1;

  const sourceFrames = [];
  const frameDelays = [];

  let decodedWhole = false;
  if (initialStep === 1 && totalPages * frameW * frameH <= LIMIT_INPUT_PIXELS) {
    try {
      const decoded = await sharp(webpBuffer, {
        animated: true,
        limitInputPixels: LIMIT_INPUT_PIXELS
      })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      if (decoded.info.width === frameW && decoded.info.height === frameH * totalPages) {
        const frameBytes = frameW * frameH * 4;
        for (let i = 0; i < totalPages; i++) {
          sourceFrames.push(decoded.data.subarray(i * frameBytes, (i + 1) * frameBytes));
          frameDelays.push(rawDelays[i]);
        }
        decodedWhole = true;
      }
    } catch {
      decodedWhole = false;
    }
  }

  if (!decodedWhole) {
    for (let i = 0; i < totalPages; i += initialStep) {
      const pageRaw = await sharp(webpBuffer, {
        page: i,
        pages: 1,
        limitInputPixels: LIMIT_INPUT_PIXELS
      })
        .ensureAlpha()
        .raw()
        .toBuffer();
      sourceFrames.push(pageRaw);

      let summedDelay = 0;
      for (let j = i; j < Math.min(totalPages, i + initialStep); j++) {
        summedDelay += rawDelays[j] || 80;
      }
      frameDelays.push(summedDelay);
    }
  }

  const processedFrames = [];
  let stage1Frame0Buffer = null;

  for (let i = 0; i < sourceFrames.length; i++) {
    let normalizedFrameRaw = sourceFrames[i];
    if (frameW !== targetSize || frameH !== targetSize) {
      normalizedFrameRaw = await sharp(sourceFrames[i], {
        raw: { width: frameW, height: frameH, channels: 4 }
      })
        .resize({
          width: targetSize,
          height: targetSize,
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .ensureAlpha()
        .raw()
        .toBuffer();
    }

    let stage1Raw;
    let finalFrameRaw;

    if (isClean) {
      stage1Raw = await sharp(normalizedFrameRaw, {
        raw: { width: targetSize, height: targetSize, channels: 4 }
      })
        .composite([{ input: overlayPng, top: 0, left: 0 }])
        .raw()
        .toBuffer();

      finalFrameRaw = stage1Raw;
    } else if (activeBlurMode === 'before') {
      stage1Raw = await degradeRgbaStickerCrusty(normalizedFrameRaw, {
        isRaw: true,
        width: targetSize,
        height: targetSize,
        scaleRatio: degradeParams.scaleRatio,
        crushQuality: degradeParams.crushQuality,
        returnRaw: true
      });

      const compositedRaw = await sharp(stage1Raw, {
        raw: { width: targetSize, height: targetSize, channels: 4 }
      })
        .composite([{ input: overlayPng, top: 0, left: 0 }])
        .raw()
        .toBuffer();

      finalFrameRaw = textDegradeParams.enabled
        ? await degradeRgbaStickerCrusty(compositedRaw, {
            isRaw: true,
            width: targetSize,
            height: targetSize,
            scaleRatio: textDegradeParams.scaleRatio,
            crushQuality: textDegradeParams.crushQuality,
            returnRaw: true
          })
        : compositedRaw;
    } else {
      stage1Raw = await sharp(normalizedFrameRaw, {
        raw: { width: targetSize, height: targetSize, channels: 4 }
      })
        .composite([{ input: overlayPng, top: 0, left: 0 }])
        .raw()
        .toBuffer();

      finalFrameRaw = await degradeRgbaStickerCrusty(stage1Raw, {
        isRaw: true,
        width: targetSize,
        height: targetSize,
        scaleRatio: degradeParams.scaleRatio,
        crushQuality: degradeParams.crushQuality,
        returnRaw: true
      });
    }

    if (returnStages && i === 0) {
      stage1Frame0Buffer = await sharp(stage1Raw, {
        raw: { width: targetSize, height: targetSize, channels: 4 }
      })
        .png()
        .toBuffer();
    }

    processedFrames.push(finalFrameRaw);
  }

  const passes = isClean
    ? [
        { step: 1, quality: 85 },
        { step: 1, quality: 68 },
        { step: 1, quality: 45 },
        { step: 1, quality: 25 },
        { step: 2, quality: 32 },
        { step: 2, quality: 16 },
        { step: 3, quality: 14 }
      ]
    : [
        { step: 1, quality: 68 },
        { step: 1, quality: 42 },
        { step: 1, quality: 22 },
        { step: 2, quality: 28 },
        { step: 2, quality: 14 },
        { step: 3, quality: 12 }
      ];
  const triedKeys = new Set();

  for (const pass of passes) {
    const { frames: passFrames, delays: passDelays } = subsampleFrames(
      processedFrames,
      frameDelays,
      pass.step
    );
    const key = `${passFrames.length}:${pass.quality}`;
    if (triedKeys.has(key)) continue;
    triedKeys.add(key);

    const combinedRaw = Buffer.concat(passFrames);
    const webpRaw = await sharp(combinedRaw, {
      raw: {
        width: targetSize,
        height: targetSize * passFrames.length,
        channels: 4,
        pageHeight: targetSize
      }
    })
      .webp({
        quality: pass.quality,
        effort: 4,
        loop: 0,
        delay: passDelays
      })
      .toBuffer();

    const finalWithExif = injectWebpExif(webpRaw, {
      packName,
      author,
      width: targetSize,
      height: targetSize,
      hasAlpha: true
    });

    if (finalWithExif.length <= MAX_ANIMATED_STICKER_BYTES) {
      if (returnStages) {
        return {
          isAnimated: true,
          blurMode: activeBlurMode,
          stage1Buffer: stage1Frame0Buffer,
          composedBuffer: activeBlurMode === 'after' ? stage1Frame0Buffer : null,
          blurredBaseBuffer: activeBlurMode === 'before' ? stage1Frame0Buffer : null,
          finalBuffer: finalWithExif,
          width: targetSize,
          height: targetSize,
          pages: passFrames.length,
          blurSigma: safeSigma,
          textBlurSigma: activeTextBlurSigma,
          fontScale: activeFontScale
        };
      }
      return finalWithExif;
    }
  }

  throw new MediaValidationError(
    'ANIMATED_TOO_LARGE',
    'Maaf, stiker bergerak ini terlalu kompleks sehingga hasil !cap masih melebihi batas 500 Kilobyte WhatsApp. Coba pakai stiker bergerak yang lebih singkat ya.'
  );
}

/**
 * Menghitung dimensi kanvas video genap (kelipatan 2 piksel agar valid untuk libx264 yuv420p)
 * yang menyesuaikan batas CAP_MAX_DIM seperti pada renderCapMeme.
 */
function computeEvenCapVideoDims(srcWidth, srcHeight, targetMaxDim, { upscaleSmall = true } = {}) {
  const safeW = Math.max(2, Math.round(Number(srcWidth) || 640));
  const safeH = Math.max(2, Math.round(Number(srcHeight) || 640));
  const maxDim = Math.max(240, Math.min(1080, Math.floor(targetMaxDim / 2) * 2));
  const minDim = upscaleSmall ? Math.min(360, maxDim) : 0;
  const srcMax = Math.max(safeW, safeH);

  let scale = 1;
  if (srcMax > maxDim || (minDim > 0 && srcMax > 0 && srcMax < minDim)) {
    scale = maxDim / srcMax;
  }

  const toEven = (n) => Math.max(64, Math.floor(Math.round(n) / 2) * 2);
  return {
    width: toEven(safeW * scale),
    height: toEven(safeH * scale)
  };
}

/**
 * Fitur 2c: !cap <teks atas> | <teks bawah> pada video (.mp4/.webm/.mov/.avi) atau GIF
 * (WhatsApp GIF maupun berkas .gif animasi).
 * Menggunakan overlay PNG transparan yang identik dengan renderCapMeme (font Impact/Anton +
 * emoji berwarna penuh Twemoji + CAP_FONT_SCALE), lalu menerapkan siklus burik shitpost
 * (downscale -> upscale + kompresi H.264 kasar) mengikuti CAP_BLUR_MODE ('after' | 'before'),
 * CAP_BLUR_SIGMA, CAP_TEXT_BLUR_SIGMA, dan CAP_MAX_DIM.
 * Trek audio dipertahankan untuk video biasa; GIF dikeluarkan sebagai MP4 gifPlayback tanpa audio.
 */
async function renderCapVideoOrGif(
  inputBuffer,
  {
    topText = '',
    bottomText = '',
    asGif = false,
    clean = false,
    blurSigma,
    textBlurSigma,
    blurMode,
    maxDim: overrideMaxDim,
    fontScale,
    emojiOptions,
    maxDurationSec = MAX_CAP_VIDEO_SECONDS,
    ffmpegPath = FFMPEG_PATH
  } = {}
) {
  const { cleanTop, cleanBottom } = validateCapTexts(topText, bottomText);

  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new MediaValidationError('EMPTY_BUFFER', 'Maaf, media gagal diunduh atau berkasnya kosong.');
  }
  if (inputBuffer.length > MAX_MEDIA_BYTES) {
    const maxMb = Math.round((MAX_MEDIA_BYTES / (1024 * 1024)) * 10) / 10;
    throw new MediaValidationError(
      'TOO_LARGE',
      `Maaf, ukuran videonya melebihi batas maksimal ${maxMb} Megabyte. Coba kirim berkas yang lebih kecil ya.`
    );
  }

  const detectedKind = detectAnimatedMediaKind(inputBuffer);
  if (!detectedKind) {
    throw new MediaValidationError(
      'NOT_MEDIA',
      'Maaf, format berkas video atau GIF ini tidak dikenali atau berkasnya rusak.'
    );
  }

  const isClean = Boolean(clean);
  const activeBlurMode = isClean ? 'none' : resolveCapBlurMode(blurMode);
  const safeSigma = isClean ? 0 : resolveCapBlurSigma(blurSigma);
  const activeTextBlurSigma =
    !isClean && activeBlurMode === 'before' ? resolveCapTextBlurSigma(textBlurSigma) : 0;
  const targetMaxDim = isClean
    ? overrideMaxDim !== undefined && overrideMaxDim !== ''
      ? Math.round(clampNumber(Number(overrideMaxDim), MAX_CAP_CLEAN_VIDEO_DIM, 240, 1080))
      : MAX_CAP_CLEAN_VIDEO_DIM
    : resolveCapMaxDim(overrideMaxDim);
  const activeFontScale = resolveCapFontScale(fontScale);
  const degradeParams = computeCapDegradeParams(safeSigma);
  const textDegradeParams = computeCapTextDegradeParams(activeTextBlurSigma);
  const treatAsGif = Boolean(asGif || detectedKind === 'gif');
  const safeMaxDuration = clampNumber(Number(maxDurationSec), MAX_CAP_VIDEO_SECONDS, 3, 60);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-capvid-'));
  const inputPath = path.join(tmpDir, `input.${detectedKind}`);
  const frame0Path = path.join(tmpDir, 'frame0.png');
  const overlayPath = path.join(tmpDir, 'overlay.png');
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    fs.writeFileSync(inputPath, inputBuffer);

    // Ambil bingkai pertama lewat FFmpeg agar rotasi metadata MP4 otomatis diterapkan sebelum ukur dimensi
    await execFileAsync(ffmpegPath, ['-y', '-i', inputPath, '-frames:v', '1', frame0Path], {
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });

    const frame0Meta = await sharp(frame0Path, { limitInputPixels: LIMIT_INPUT_PIXELS }).metadata();
    const { width: targetW, height: targetH } = computeEvenCapVideoDims(
      frame0Meta.width,
      frame0Meta.height,
      targetMaxDim,
      { upscaleSmall: !isClean }
    );

    const overlayPng = await renderCapOverlayPng({
      imgWidth: targetW,
      imgHeight: targetH,
      cleanTop,
      cleanBottom,
      textBlurSigma: 0,
      fontScale: activeFontScale,
      emojiOptions
    });
    fs.writeFileSync(overlayPath, overlayPng);

    const toEvenCrush = (n) => Math.max(64, Math.floor(Math.round(n) / 2) * 2);
    const crushW = toEvenCrush(targetW * degradeParams.scaleRatio);
    const crushH = toEvenCrush(targetH * degradeParams.scaleRatio);
    const videoCrf = Math.round(clampNumber(28 + Math.log1p(degradeParams.level) * 7.2, 38, 30, 46));

    let filterComplex;
    let encodeCrf;

    if (isClean) {
      encodeCrf = 20;
      filterComplex =
        `[0:v]scale=${targetW}:${targetH}:flags=lanczos,setsar=1[base];` +
        `[base][1:v]overlay=0:0:format=auto,format=yuv420p[outv]`;
    } else if (activeBlurMode === 'before') {
      if (textDegradeParams.enabled) {
        const textCrushW = toEvenCrush(targetW * textDegradeParams.scaleRatio);
        const textCrushH = toEvenCrush(targetH * textDegradeParams.scaleRatio);
        encodeCrf = Math.round(clampNumber(25 + textDegradeParams.level * 3.5, 29, 26, 39));
        filterComplex =
          `[0:v]scale=${crushW}:${crushH}:flags=bicubic,scale=${targetW}:${targetH}:flags=bilinear,setsar=1[base];` +
          `[base][1:v]overlay=0:0:format=auto[comp];` +
          `[comp]scale=${textCrushW}:${textCrushH}:flags=bicubic,scale=${targetW}:${targetH}:flags=bilinear,format=yuv420p[outv]`;
      } else {
        encodeCrf = 24;
        filterComplex =
          `[0:v]scale=${crushW}:${crushH}:flags=bicubic,scale=${targetW}:${targetH}:flags=bilinear,setsar=1[base];` +
          `[base][1:v]overlay=0:0:format=auto,format=yuv420p[outv]`;
      }
    } else {
      encodeCrf = videoCrf;
      filterComplex =
        `[0:v]scale=${targetW}:${targetH}:flags=bicubic,setsar=1[base];` +
        `[base][1:v]overlay=0:0:format=auto[comp];` +
        `[comp]scale=${crushW}:${crushH}:flags=bicubic,scale=${targetW}:${targetH}:flags=bilinear,format=yuv420p[outv]`;
    }

    const args = [
      '-y',
      '-i',
      inputPath,
      '-i',
      overlayPath,
      '-t',
      String(safeMaxDuration),
      '-filter_complex',
      filterComplex,
      '-map',
      '[outv]',
      ...(treatAsGif ? ['-an'] : ['-map', '0:a?', '-c:a', 'aac', '-b:a', '128k']),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      String(encodeCrf),
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outputPath
    ];

    await execFileAsync(ffmpegPath, args, {
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    });

    const mp4Buffer = fs.readFileSync(outputPath);
    return {
      kind: treatAsGif ? 'gif' : 'video',
      buffer: mp4Buffer,
      mimeType: 'video/mp4',
      width: targetW,
      height: targetH,
      blurMode: activeBlurMode,
      blurSigma: safeSigma,
      textBlurSigma: activeTextBlurSigma,
      fontScale: activeFontScale
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new MediaValidationError(
        'FFMPEG_MISSING',
        'Maaf, fitur caption untuk video atau GIF sedang belum bisa dipakai saat ini.',
        'FFmpeg tidak terpasang di sistem untuk perintah !cap pada video atau GIF.'
      );
    }
    if (err instanceof MediaValidationError) throw err;
    throw new Error(`FFmpeg gagal memproses !cap video: ${err.message}`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Memotong gambar (JPEG/PNG/WebP/GIF diam) menjadi kotak 1:1 tepat di tengah.
 * Jika berkas adalah GIF animasi (> 1 bingkai), otomatis diteruskan ke pemotong GIF/video 1:1.
 */
async function cropImageToSquare(inputBuffer, { maxSide = 2048 } = {}) {
  const meta = await validateImageBuffer(inputBuffer);
  if (meta.format === 'gif' && meta.pages && meta.pages > 1) {
    return await cropVideoOrGifToSquare(inputBuffer, { asGif: true });
  }

  const rotated = await sharp(inputBuffer, { limitInputPixels: LIMIT_INPUT_PIXELS })
    .rotate()
    .toBuffer({ resolveWithObject: true });

  const side = Math.min(rotated.info.width, rotated.info.height);
  const left = Math.floor((rotated.info.width - side) / 2);
  const top = Math.floor((rotated.info.height - side) / 2);
  const safeMaxSide = Math.max(64, Math.min(4096, Math.round(Number(maxSide)) || 2048));
  const targetSide = Math.min(side, safeMaxSide);
  const keepPng = Boolean(meta.hasAlpha && (meta.format === 'png' || meta.format === 'webp'));

  let pipeline = sharp(rotated.data).extract({ left, top, width: side, height: side });
  if (side > targetSide) {
    pipeline = pipeline.resize({ width: targetSide, height: targetSide, fit: 'fill' });
  }

  const outBuffer = keepPng
    ? await pipeline.png().toBuffer()
    : await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer();

  return {
    kind: 'image',
    buffer: outBuffer,
    mimeType: keepPng ? 'image/png' : 'image/jpeg',
    width: targetSide,
    height: targetSide
  };
}

/**
 * Memotong video (.mp4/.webm/.mov/.avi) atau GIF (WhatsApp GIF maupun berkas .gif)
 * menjadi kotak 1:1 tepat di tengah menggunakan FFmpeg (dengan fallback Sharp untuk .gif).
 * Untuk video biasa, trek audio tetap dipertahankan jika ada; untuk GIF, audio dihilangkan
 * dan dikirim kembali sebagai video MP4 H.264 siap putar (gifPlayback: true).
 */
async function cropVideoOrGifToSquare(
  inputBuffer,
  { asGif = false, maxSide = 1080, ffmpegPath = FFMPEG_PATH } = {}
) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new MediaValidationError('EMPTY_BUFFER', 'Maaf, media gagal diunduh atau berkasnya kosong.');
  }
  if (inputBuffer.length > MAX_MEDIA_BYTES) {
    const maxMb = Math.round((MAX_MEDIA_BYTES / (1024 * 1024)) * 10) / 10;
    throw new MediaValidationError(
      'TOO_LARGE',
      `Maaf, ukuran medianya melebihi batas maksimal ${maxMb} Megabyte. Coba kirim berkas yang lebih kecil ya.`
    );
  }

  const detectedKind = detectAnimatedMediaKind(inputBuffer);
  if (!detectedKind) {
    throw new MediaValidationError(
      'NOT_MEDIA',
      'Maaf, format berkas video atau GIF ini tidak dikenali atau berkasnya rusak.'
    );
  }

  const treatAsGif = Boolean(asGif || detectedKind === 'gif');
  const safeMaxSide = Math.max(64, Math.min(1080, Math.floor((Number(maxSide) || 1080) / 2) * 2));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'another-me-crop-'));
  const inputPath = path.join(tmpDir, `input.${detectedKind}`);
  const outputPath = path.join(tmpDir, 'output.mp4');

  const vf = `crop='trunc(min(iw,ih)/2)*2':'trunc(min(iw,ih)/2)*2',scale='min(iw,${safeMaxSide})':'min(ih,${safeMaxSide})',setsar=1`;

  try {
    fs.writeFileSync(inputPath, inputBuffer);

    const args = treatAsGif
      ? [
          '-y',
          '-i',
          inputPath,
          '-map',
          '0:v:0',
          '-an',
          '-vf',
          vf,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          outputPath
        ]
      : [
          '-y',
          '-i',
          inputPath,
          '-map',
          '0:v:0',
          '-map',
          '0:a?',
          '-vf',
          vf,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          outputPath
        ];

    await execFileAsync(ffmpegPath, args, {
      timeout: 45000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });

    const mp4Buffer = fs.readFileSync(outputPath);
    return {
      kind: treatAsGif ? 'gif' : 'video',
      buffer: mp4Buffer,
      mimeType: 'video/mp4'
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      if (detectedKind === 'gif') {
        const gifMeta = await sharp(inputBuffer, { limitInputPixels: LIMIT_INPUT_PIXELS }).metadata();
        const side = Math.min(
          gifMeta.width || 512,
          gifMeta.pageHeight || gifMeta.height || 512,
          safeMaxSide
        );
        const croppedGif = await sharp(inputBuffer, {
          animated: true,
          limitInputPixels: LIMIT_INPUT_PIXELS
        })
          .resize({ width: side, height: side, fit: 'cover', position: 'centre' })
          .gif()
          .toBuffer();
        return {
          kind: 'gif_document',
          buffer: croppedGif,
          mimeType: 'image/gif',
          width: side,
          height: side
        };
      }
      throw new MediaValidationError(
        'FFMPEG_MISSING',
        'Maaf, fitur potong video 1:1 sedang belum bisa dipakai saat ini.',
        'FFmpeg tidak terpasang di sistem untuk pemotongan video 1:1.'
      );
    }
    if (err instanceof MediaValidationError) throw err;
    throw new Error(`FFmpeg gagal memotong media 1:1: ${err.message}`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = {
  MAX_MEDIA_BYTES,
  MAX_ANIMATED_STICKER_BYTES,
  MAX_STICKER_AUDIO_BYTES,
  MAX_VIDEO_INPUT_SECONDS,
  MAX_CAP_VIDEO_SECONDS,
  MAX_CROP_VIDEO_SECONDS,
  DEFAULT_VIDEO_STICKER_SECONDS,
  LIMIT_INPUT_PIXELS,
  DEFAULT_PACK_NAME,
  DEFAULT_PACK_AUTHOR,
  DEFAULT_TEXT_BLUR_SIGMA,
  DEFAULT_CAP_BLUR_SIGMA,
  DEFAULT_CAP_BLUR_MODE,
  DEFAULT_CAP_TEXT_BLUR_SIGMA,
  DEFAULT_CAP_MAX_DIM,
  DEFAULT_CAP_FONT_SCALE,
  VALID_CAP_BLUR_MODES,
  resolveCapBlurMode,
  resolveCapBlurSigma,
  resolveCapTextBlurSigma,
  resolveCapMaxDim,
  resolveCapFontScale,
  computeCapDegradeParams,
  computeCapTextDegradeParams,
  MediaValidationError,
  escapeXml,
  wrapTextLines,
  layoutImpactBlock,
  subsampleFrames,
  detectAnimatedMediaKind,
  probeVideoAudioInfo,
  validateImageBuffer,
  convertImageToSticker,
  convertVideoOrGifToSticker,
  convertStickerToPng,
  convertAnimatedStickerToGif,
  convertSoundStickerToVideo,
  convertStickerToMedia,
  rewriteStickerExif,
  renderTextBlurImage,
  renderCapMeme,
  renderCapSticker,
  renderCapVideoOrGif,
  cropImageToSquare,
  cropVideoOrGifToSquare
};
