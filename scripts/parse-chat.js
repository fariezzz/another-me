#!/usr/bin/env node

/**
 * Script Parser Riwayat Obrolan WhatsApp (.txt)
 * Digunakan untuk mengekstrak contoh pasangan chat nyata (user -> reply kamu)
 * dan memasukkannya ke data/persona.json pada kategori yang diinginkan.
 *
 * Cara pakai:
 *   node scripts/parse-chat.js --file=data/raw_chats/chat_pacar.txt --me="Fariez" --category=pacar --limit=10
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('../src/utils/atomicFile');

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      args[key] = value || true;
    }
  }
  return args;
}

const args = parseArgs();
const filePath = args.file;
const myName = args.me;
const targetCategory = args.category;
const limit = parseInt(args.limit, 10) || 5;

if (!filePath || !myName || !targetCategory) {
  console.log(`
PENGGUNAAN:
  node scripts/parse-chat.js --file=<path_file_txt> --me="<NamaKamuDiWA>" --category=<kategori> [--limit=5]

CONTOH:
  node scripts/parse-chat.js --file=data/raw_chats/chat_pacar.txt --me="Fariez" --category=pacar --limit=5

Kategori yang tersedia: pacar, teman_dekat, formal, baru_kenal, default
`);
  process.exit(1);
}

const resolvedFile = path.resolve(process.cwd(), filePath);
if (!fs.existsSync(resolvedFile)) {
  console.error(`[Error] File tidak ditemukan: ${resolvedFile}`);
  process.exit(1);
}

console.log(`Membaca file: ${resolvedFile}`);
const rawContent = fs.readFileSync(resolvedFile, 'utf-8');
const lines = rawContent.split(/\r?\n/);

// Regex untuk pola format ekspor WhatsApp (Android / iOS / Indo / English):
// Contoh: 12/10/24 20.15 - Nama Pengirim: Isi Pesan
// Atau: [12/10/24 20:15:30] Nama Pengirim: Isi Pesan
const waLineRegex = /^(?:\[?(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}),?\s+(\d{1,2}[:.]\d{1,2}(?:[:.]\d{1,2})?(?:\s?[APMapm]{2})?)\]?\s*(?:-|:)\s*)([^:]+):\s*(.*)$/;

const parsedMessages = [];

for (const line of lines) {
  const match = line.match(waLineRegex);
  if (match) {
    const sender = match[3].trim();
    const content = match[4].trim();

    // Lewati pesan sistem / media
    if (content.includes('<Media omitted>') || content.includes('pesan telah dihapus') || content.includes('panggilan tidak terjawab')) {
      continue;
    }

    parsedMessages.push({
      sender,
      isMe: sender.toLowerCase() === myName.toLowerCase(),
      content
    });
  } else if (parsedMessages.length > 0) {
    // Baris kelanjutan pesan sebelumnya
    parsedMessages[parsedMessages.length - 1].content += '\n' + line;
  }
}

console.log(`Berhasil mengekstrak ${parsedMessages.length} baris pesan.`);

function capitalizeFirstLetter(text) {
  if (!text) return text;
  return text.replace(/[\p{L}]/u, (ch) => ch.toUpperCase());
}

// Cari pasangan [Pesan Lawan Bicara] -> [Pesan Kamu]
const pairs = [];
for (let i = 0; i < parsedMessages.length - 1; i++) {
  const current = parsedMessages[i];
  const next = parsedMessages[i + 1];

  if (!current.isMe && next.isMe) {
    // Filter pesan yang terlalu panjang atau berupa tautan saja
    if (current.content.length > 3 && current.content.length < 150 && next.content.length > 1 && next.content.length < 200) {
      pairs.push({
        user: current.content.replace(/\n/g, ' ').trim(),
        reply: capitalizeFirstLetter(next.content.replace(/\n/g, ' ').trim())
      });
    }
  }
}

console.log(`Ditemukan ${pairs.length} pasangan dialog tanya-jawab.`);

// Ambil sampel hingga batas limit
const selectedPairs = pairs.slice(-limit);

// Update ke persona.json
const personaPath = path.resolve(__dirname, '../data/persona.json');
let personaData = { general_persona: {}, categories: {} };

if (fs.existsSync(personaPath)) {
  personaData = JSON.parse(fs.readFileSync(personaPath, 'utf-8'));
}

if (!personaData.categories[targetCategory]) {
  personaData.categories[targetCategory] = {
    tone: 'Disesuaikan dari data ekspor riil',
    few_shots: []
  };
}

if (!Array.isArray(personaData.categories[targetCategory].few_shots)) {
  personaData.categories[targetCategory].few_shots = [];
}

// Tambahkan tanpa duplikasi
let addedCount = 0;
for (const p of selectedPairs) {
  const exists = personaData.categories[targetCategory].few_shots.some((s) => s.user === p.user && s.reply === p.reply);
  if (!exists) {
    personaData.categories[targetCategory].few_shots.push(p);
    addedCount++;
  }
}

atomicWriteJsonSync(personaPath, personaData);
console.log(`✅ Berhasil menambahkan ${addedCount} contoh chat baru ke kategori '${targetCategory}' di data/persona.json`);
