/**
 * Utilitas I/O berkas yang aman dan atomik.
 * Mencegah korupsi berkas JSON akibat penulisan parsial atau tabrakan baca/tulis.
 */

const fs = require('fs');
const path = require('path');

/**
 * Menulis teks secara atomik menggunakan berkas sementara lalu rename.
 * @param {string} targetPath
 * @param {string} content
 */
function atomicWriteTextSync(targetPath, content) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    // Fallback untuk kondisi penguncian berkas sementara di Windows
    try {
      fs.copyFileSync(tmpPath, targetPath);
      fs.unlinkSync(tmpPath);
    } catch (fallbackErr) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw fallbackErr;
    }
  }
}

/**
 * Menulis objek JavaScript sebagai JSON terformat secara atomik.
 * @param {string} targetPath
 * @param {any} data
 */
function atomicWriteJsonSync(targetPath, data) {
  atomicWriteTextSync(targetPath, JSON.stringify(data, null, 2));
}

/**
 * Membaca berkas JSON dengan aman tanpa melempar galat.
 * Mengembalikan { ok: true, data, mtimeMs } jika berhasil, atau { ok: false, error }.
 * @param {string} targetPath
 */
function readJsonSafeSync(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) {
      return { ok: false, missing: true, error: null, mtimeMs: 0 };
    }
    const stat = fs.statSync(targetPath);
    const raw = fs.readFileSync(targetPath, 'utf-8');
    const data = JSON.parse(raw);
    return { ok: true, missing: false, data, mtimeMs: stat.mtimeMs };
  } catch (error) {
    return { ok: false, missing: false, error, mtimeMs: 0 };
  }
}

/**
 * Memindahkan berkas secara aman lintas perangkat (menangani galat EXDEV).
 * @param {string} srcPath
 * @param {string} destPath
 */
function moveFileSafeSync(srcPath, destPath) {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.renameSync(srcPath, destPath);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      fs.copyFileSync(srcPath, destPath);
      fs.unlinkSync(srcPath);
    } else {
      throw err;
    }
  }
}

/**
 * Membersihkan berkas sementara yatim di direktori uploads saat startup.
 * @param {string} uploadsDir
 */
function cleanupOrphanedUploads(uploadsDir) {
  try {
    if (!fs.existsSync(uploadsDir)) return 0;
    const entries = fs.readdirSync(uploadsDir);
    let removed = 0;
    for (const name of entries) {
      if (name === '.gitkeep') continue;
      const fullPath = path.join(uploadsDir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          fs.unlinkSync(fullPath);
          removed++;
        }
      } catch {}
    }
    return removed;
  } catch {
    return 0;
  }
}

/**
 * Memeriksa apakah buffer memiliki header RIFF....WEBP yang valid.
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isValidWebpBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  return (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

/**
 * Merender string QR menjadi SVG vektor murni sisi server menggunakan vendor qrcode-terminal.
 * Tidak memerlukan CDN atau pustaka eksternal tambahan.
 * @param {string} text
 * @returns {string|null}
 */
function renderQrToSvg(text) {
  if (!text) return null;
  try {
    const QRCode = require('qrcode-terminal/vendor/QRCode');
    const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
    const qr = new QRCode(-1, QRErrorCorrectLevel.L);
    qr.addData(String(text));
    qr.make();
    const count = qr.getModuleCount();
    const margin = 2;
    const size = count + margin * 2;
    const rects = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) {
          rects.push(`M${col + margin},${row + margin}h1v1h-1z`);
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR Code WhatsApp"><rect width="100%" height="100%" fill="#ffffff"/><path d="${rects.join('')}" fill="#0f172a"/></svg>`;
  } catch {
    return null;
  }
}

module.exports = {
  atomicWriteTextSync,
  atomicWriteJsonSync,
  readJsonSafeSync,
  moveFileSafeSync,
  cleanupOrphanedUploads,
  isValidWebpBuffer,
  renderQrToSvg
};
