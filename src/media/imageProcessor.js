/**
 * Mesin Pengolah Gambar & Meme Berbasis Sharp
 * Menangani validasi batas 5 Megabyte, konversi stiker WhatsApp (!sticker / !toimg / !wm),
 * meme teks latar putih blur tipis (!text / !stext), serta meme gaya Impact dengan
 * urutan blur dua tahap ketat (!cap: tempel teks dulu, lalu blur seluruh gambar hasil akhir).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Di Linux (seperti Muse Virtual Machine), daftarkan folder assets/fonts agar font cadangan
// Anton (lisensi SIL Open Font License 1.1) terbaca otomatis oleh Fontconfig/librsvg.
// Di Windows, sistem memakai font bawaan C:\Windows\Fonts (Impact & Arial Narrow).
if (process.platform !== 'win32' && !process.env.FONTCONFIG_FILE) {
  const localFontsConf = path.resolve(__dirname, '../../assets/fonts/fonts.conf');
  if (fs.existsSync(localFontsConf)) {
    process.env.FONTCONFIG_FILE = localFontsConf;
  }
}

const sharp = require('sharp');
const { injectWebpExif } = require('../utils/webpExif');

const MAX_MEDIA_BYTES = parseInt(process.env.MAX_MEDIA_BYTES, 10) || 5 * 1024 * 1024; // 5 Megabyte
const MAX_ANIMATED_STICKER_BYTES = 500 * 1024; // 500 Kilobyte agar pasti diterima & diputar WhatsApp
const MAX_VIDEO_INPUT_SECONDS = 15;
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
  2.0,
  4.0
);

class MediaValidationError extends Error {
  constructor(code, userMessage) {
    super(userMessage);
    this.name = 'MediaValidationError';
    this.code = code;
    this.userMessage = userMessage;
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
  if (ch === ' ') return style === 'impact' ? 0.25 : 0.24;
  if ('iIljtf!|.,;:\'`'.includes(ch)) return style === 'impact' ? 0.28 : 0.27;
  if ('r()[]-/\\'.includes(ch)) return style === 'impact' ? 0.36 : 0.34;
  if ('MWmw@%#'.includes(ch)) return style === 'impact' ? 0.78 : 0.76;
  if (/[A-Z]/.test(ch)) return style === 'impact' ? 0.54 : 0.56;
  if (/[0-9]/.test(ch)) return style === 'impact' ? 0.52 : 0.50;
  // Karakter non-ASCII (emoji / simbol lebar) diberi ruang aman lebih besar
  if (ch.charCodeAt(0) > 127) return 0.92;
  return style === 'impact' ? 0.50 : 0.47;
}

function estimateTextWidthPx(text, fontSize, style) {
  let totalEm = 0;
  for (const ch of Array.from(String(text || ''))) {
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
        // Jika satu kata tunggal lebih lebar dari kotak, pecah per karakter secara aman
        if (estimateTextWidthPx(word, fontSize, style) > maxWidthPx) {
          let chunk = '';
          for (const ch of Array.from(word)) {
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
async function convertVideoOrGifToSticker(
  inputBuffer,
  {
    crop = false,
    packName = DEFAULT_PACK_NAME,
    author = DEFAULT_PACK_AUTHOR,
    maxDurationSec = DEFAULT_VIDEO_STICKER_SECONDS,
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
        return finalSticker;
      }
    }

    throw new MediaValidationError(
      'ANIMATED_TOO_LARGE',
      'Maaf, video atau GIF ini terlalu kompleks sehingga ukuran stiker bergeraknya masih melebihi batas 500 Kilobyte WhatsApp. Coba potong durasinya lebih pendek (3-4 detik) ya.'
    );
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Untuk GIF asli, fallback ke Sharp animasi jika FFmpeg belum terpasang
      if (detectedKind === 'gif') {
        return await convertAnimatedGifWithSharp(inputBuffer, { crop, packName, author });
      }
      throw new MediaValidationError(
        'FFMPEG_MISSING',
        'Maaf, konversi video menjadi stiker bergerak memerlukan FFmpeg yang terpasang di sistem.'
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
 * Konversi cerdas untuk perintah !toimg:
 * - Stiker diam -> gambar Portable Network Graphics (PNG)
 * - Stiker bergerak -> media GIF WhatsApp (MP4 gifPlayback: true)
 */
async function convertStickerToMedia(webpBuffer, options = {}) {
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
    "'Arial Narrow', 'Liberation Sans Narrow', 'Helvetica Neue', Arial, 'DejaVu Sans', sans-serif";

  const textNodes = chosenLines
    .map((line, idx) => {
      const y = firstBaselineY + idx * lineStep;
      return `<text x="${padX}" y="${y}" text-anchor="start" fill="#0b0b0b" font-family="${fontFamily}" font-size="${chosenSize}" font-weight="600" letter-spacing="-0.02em">${escapeXml(line)}</text>`;
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
function layoutImpactBlock(upperText, imgWidth, imgHeight) {
  const maxWidth = imgWidth * 0.92;
  const maxBlockHeight = imgHeight * 0.27;
  const startSize = Math.max(24, Math.round(Math.min(imgWidth * 0.165, imgHeight * 0.145)));
  const minSize = Math.max(18, Math.round(imgWidth * 0.042));
  const lineHeightRatio = 1.08;
  const hasExplicitNewline = upperText.includes('\n');

  let chosenSize = minSize;
  let chosenLines = [upperText];
  let found = false;

  // Tahap 1: Prioritaskan 1 baris penuh selama ukuran huruf tetap besar & nyaman dibaca (>= 9.5% lebar gambar)
  if (!hasExplicitNewline) {
    const singleLineMinSize = Math.max(minSize, Math.round(imgWidth * 0.095));
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
    const twoLineMinSize = Math.max(minSize, Math.round(imgWidth * 0.068));
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

  const strokeWidth = Math.max(4, Math.round(chosenSize * 0.16));
  const lineStep = Math.round(chosenSize * lineHeightRatio);
  return { fontSize: chosenSize, lines: chosenLines, strokeWidth, lineStep };
}

/**
 * Membangun potongan SVG dua lapis (garis luar hitam tebal di bawah, isi putih di atas)
 * agar tampilan outline Impact selalu tajam dan konsisten di semua versi librsvg.
 */
function buildImpactTextSvgNodes(lines, { centerX, startBaselineY, fontSize, strokeWidth, lineStep }) {
  const fontFamily = "'Impact', 'Anton', 'Arial Black', sans-serif";
  const nodes = [];

  for (let i = 0; i < lines.length; i++) {
    const y = Math.round(startBaselineY + i * lineStep);
    const escaped = escapeXml(lines[i]);
    // Lapisan 1: Outline hitam tebal
    nodes.push(
      `<text x="${centerX}" y="${y}" text-anchor="middle" fill="none" stroke="#000000" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round" font-family="${fontFamily}" font-size="${fontSize}" font-weight="900">${escaped}</text>`
    );
    // Lapisan 2: Isi putih bersih di atas outline
    nodes.push(
      `<text x="${centerX}" y="${y}" text-anchor="middle" fill="#ffffff" stroke="none" font-family="${fontFamily}" font-size="${fontSize}" font-weight="900">${escaped}</text>`
    );
  }

  return nodes.join('\n  ');
}

/**
 * Fitur 2: !cap <teks atas> | <teks bawah> (alias !caption / !burem / .cap / .caption)
 * PENTING: urutan pemrosesan ketat dua tahap:
 *   Tahap 1: Masukkan teks Impact kapital (isi putih, outline hitam tebal) ke foto asli sampai selesai.
 *   Tahap 2: BARU setelah teks selesai menempel di foto, blur SELURUH gambar hasil akhir
 *            dengan Gaussian blur ringan (2 sampai 4 piksel) agar foto dan teks ikut blur bareng.
 */
async function renderCapMeme(
  inputBuffer,
  { topText = '', bottomText = '', blurSigma = DEFAULT_CAP_BLUR_SIGMA, returnStages = false } = {}
) {
  const cleanTop = String(topText || '').trim().toUpperCase();
  const cleanBottom = String(bottomText || '').trim().toUpperCase();

  if (!cleanTop && !cleanBottom) {
    throw new MediaValidationError(
      'INVALID_TEXT',
      'Pakai: kirim foto dengan caption atau balas foto dengan !cap <teks atas> | <teks bawah> (kalau cuma satu teks, otomatis ditaruh di bawah).'
    );
  }

  if (cleanTop.length + cleanBottom.length > 180) {
    throw new MediaValidationError(
      'TEXT_TOO_LONG',
      'Maaf, teks untuk !cap kepanjangan (maksimal 180 karakter total) supaya tetap rapi di foto ya.'
    );
  }

  const meta = await validateImageBuffer(inputBuffer);

  // Pra-tahap: perbaiki rotasi EXIF dan normalkan ukuran (maksimal 1080 piksel, minimal 480 piksel
  // untuk thumbnail kecil) agar efek blur 2-4 piksel selalu seragam di segala resolusi kamera.
  let basePipeline = sharp(inputBuffer, { limitInputPixels: LIMIT_INPUT_PIXELS }).rotate();
  const maxDim = Math.max(meta.width || 0, meta.height || 0);
  if (maxDim > 1080) {
    basePipeline = basePipeline.resize({
      width: 1080,
      height: 1080,
      fit: 'inside',
      withoutEnlargement: true
    });
  } else if (maxDim > 0 && maxDim < 480) {
    basePipeline = basePipeline.resize({
      width: 600,
      height: 600,
      fit: 'inside',
      withoutEnlargement: false
    });
  }

  const normalized = await basePipeline.png().toBuffer({ resolveWithObject: true });
  const imgWidth = normalized.info.width;
  const imgHeight = normalized.info.height;
  const centerX = Math.round(imgWidth / 2);
  const edgeMarginY = Math.max(12, Math.round(imgHeight * 0.032));

  const svgParts = [];

  if (cleanTop) {
    const topLayout = layoutImpactBlock(cleanTop, imgWidth, imgHeight);
    const topStartY = edgeMarginY + Math.round(topLayout.fontSize * 0.88);
    svgParts.push(
      buildImpactTextSvgNodes(topLayout.lines, {
        centerX,
        startBaselineY: topStartY,
        fontSize: topLayout.fontSize,
        strokeWidth: topLayout.strokeWidth,
        lineStep: topLayout.lineStep
      })
    );
  }

  if (cleanBottom) {
    const bottomLayout = layoutImpactBlock(cleanBottom, imgWidth, imgHeight);
    const totalLinesOffset = (bottomLayout.lines.length - 1) * bottomLayout.lineStep;
    const bottomLastBaselineY =
      imgHeight - edgeMarginY - Math.round(bottomLayout.strokeWidth * 0.45);
    const bottomStartY = Math.max(
      Math.round(imgHeight * 0.55),
      bottomLastBaselineY - totalLinesOffset
    );
    svgParts.push(
      buildImpactTextSvgNodes(bottomLayout.lines, {
        centerX,
        startBaselineY: bottomStartY,
        fontSize: bottomLayout.fontSize,
        strokeWidth: bottomLayout.strokeWidth,
        lineStep: bottomLayout.lineStep
      })
    );
  }

  const overlaySvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${imgWidth}" height="${imgHeight}" viewBox="0 0 ${imgWidth} ${imgHeight}" xmlns="http://www.w3.org/2000/svg">
  ${svgParts.join('\n  ')}
</svg>`;

  // =========================================================================
  // TAHAP 1: Tempelkan teks Impact ke foto terlebih dahulu sampai selesai.
  // Belum ada blur sama sekali pada foto maupun teks pada tahap ini.
  // =========================================================================
  const composedBuffer = await sharp(normalized.data)
    .composite([{ input: Buffer.from(overlaySvg, 'utf-8'), top: 0, left: 0 }])
    .png()
    .toBuffer();

  // =========================================================================
  // TAHAP 2: Setelah foto + teks menyatu sempurna, blur SELURUH gambar akhir
  // secara bersamaan (Gaussian blur ringan 2.0 - 4.0 piksel).
  // =========================================================================
  const safeSigma = clampNumber(Number(blurSigma), DEFAULT_CAP_BLUR_SIGMA, 2.0, 4.0);
  const finalBuffer = await sharp(composedBuffer)
    .blur(safeSigma)
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  if (returnStages) {
    return {
      composedBuffer,
      finalBuffer,
      width: imgWidth,
      height: imgHeight,
      blurSigma: safeSigma
    };
  }

  return finalBuffer;
}

module.exports = {
  MAX_MEDIA_BYTES,
  MAX_ANIMATED_STICKER_BYTES,
  MAX_VIDEO_INPUT_SECONDS,
  DEFAULT_VIDEO_STICKER_SECONDS,
  LIMIT_INPUT_PIXELS,
  DEFAULT_PACK_NAME,
  DEFAULT_PACK_AUTHOR,
  DEFAULT_TEXT_BLUR_SIGMA,
  DEFAULT_CAP_BLUR_SIGMA,
  MediaValidationError,
  escapeXml,
  wrapTextLines,
  layoutImpactBlock,
  detectAnimatedMediaKind,
  validateImageBuffer,
  convertImageToSticker,
  convertVideoOrGifToSticker,
  convertStickerToPng,
  convertAnimatedStickerToGif,
  convertStickerToMedia,
  rewriteStickerExif,
  renderTextBlurImage,
  renderCapMeme
};
