/**
 * Knowledge Manager
 * Mengelola basis pengetahuan (knowledge base) dalam berbagai format:
 * .txt, .md, .pdf, .docx, .json, .csv
 * Dilengkapi penulisan atomik, cache memori, edit dokumen, dan seleksi relevansi kata kunci.
 */

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { atomicWriteJsonSync, atomicWriteTextSync, readJsonSafeSync } = require('./utils/atomicFile');

const STOPWORDS = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'ini', 'itu', 'ada', 'aku', 'kamu', 'dia',
  'kita', 'kami', 'sama', 'buat', 'untuk', 'atau', 'kalau', 'kalo', 'bisa', 'udah',
  'sudah', 'belum', 'lagi', 'aja', 'saja', 'kok', 'sih', 'nih', 'dong', 'yaa', 'iya',
  'gak', 'ga', 'ngga', 'enggak', 'tidak', 'apa', 'siapa', 'kapan', 'dimana', 'gimana',
  'kenapa', 'the', 'and', 'for', 'with', 'that', 'this', 'are', 'you', 'from'
]);

function tokenizeQuery(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

class KnowledgeManager {
  constructor(options = {}) {
    this.dataPath = options.dataPath || path.resolve(__dirname, '../data');
    this.knowledgeDir = path.join(this.dataPath, 'knowledge');
    this.registryFile = path.join(this.dataPath, 'knowledge_registry.json');

    if (!fs.existsSync(this.knowledgeDir)) {
      fs.mkdirSync(this.knowledgeDir, { recursive: true });
    }

    this.registry = [];
    this.contentCache = new Map();
    this.registryMtimeMs = 0;
    this.loadRegistry(true);
  }

  getRegistryMtime() {
    try {
      return fs.existsSync(this.registryFile) ? fs.statSync(this.registryFile).mtimeMs : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Menyinkronkan registry dan membersihkan cache bila berkas knowledge_registry.json
   * berubah di disk oleh proses eksternal (MEM-01).
   */
  syncFromDiskIfChanged() {
    const mtime = this.getRegistryMtime();
    if (mtime && mtime !== this.registryMtimeMs) {
      const res = readJsonSafeSync(this.registryFile);
      if (res.ok && Array.isArray(res.data)) {
        this.registry = res.data;
        this.registryMtimeMs = res.mtimeMs;
        this.contentCache.clear();
      }
    }
  }

  loadRegistry(initial = false) {
    if (!fs.existsSync(this.registryFile)) {
      const exampleFile = path.join(this.dataPath, 'knowledge_registry.example.json');
      if (fs.existsSync(exampleFile)) {
        try { fs.copyFileSync(exampleFile, this.registryFile); } catch {}
      }
    }

    const res = readJsonSafeSync(this.registryFile);
    if (res.ok && Array.isArray(res.data)) {
      this.registry = res.data;
      this.registryMtimeMs = res.mtimeMs;
    } else if (res.missing) {
      this.registry = [];
      this.saveRegistry();
    } else if (res.error) {
      console.warn('[KnowledgeManager] Gagal membaca registry (mempertahankan state memori):', res.error.message);
      if (initial) this.registry = [];
    }
  }

  saveRegistry() {
    try {
      atomicWriteJsonSync(this.registryFile, this.registry);
      this.registryMtimeMs = this.getRegistryMtime();
    } catch (err) {
      console.error('[KnowledgeManager] Gagal menyimpan registry:', err.message);
    }
  }

  /**
   * Membaca isi teks dokumen dengan cache memori.
   * @param {Object} doc
   * @returns {string}
   */
  readDocContentCached(doc) {
    if (!doc || !doc.id) return '';
    if (this.contentCache.has(doc.id)) {
      return this.contentCache.get(doc.id);
    }
    const docPath = path.join(this.knowledgeDir, doc.fileName);
    if (!fs.existsSync(docPath)) return '';
    try {
      const content = fs.readFileSync(docPath, 'utf-8');
      this.contentCache.set(doc.id, content);
      return content;
    } catch {
      return '';
    }
  }

  getDocumentById(id) {
    const entry = this.registry.find((d) => d.id === id);
    if (!entry) return null;
    return {
      ...entry,
      content: this.readDocContentCached(entry)
    };
  }

  /**
   * Memperbarui judul, kategori, atau isi dokumen/snippet yang sudah ada.
   */
  updateDocument(id, { title, content, category }) {
    const entry = this.registry.find((d) => d.id === id);
    if (!entry) return null;

    if (title !== undefined && String(title).trim()) {
      entry.title = String(title).trim();
    }
    if (category !== undefined && String(category).trim()) {
      entry.category = String(category).trim();
    }
    if (content !== undefined) {
      const cleanedText = String(content).replace(/\r\n/g, '\n').trim();
      if (!cleanedText) {
        throw new Error('Konten dokumen tidak boleh kosong.');
      }
      const docPath = path.join(this.knowledgeDir, entry.fileName);
      atomicWriteTextSync(docPath, cleanedText);
      this.contentCache.set(entry.id, cleanedText);
      entry.charCount = cleanedText.length;
    }
    entry.updatedAt = new Date().toISOString();
    this.saveRegistry();
    return {
      ...entry,
      content: this.readDocContentCached(entry)
    };
  }

  async extractTextFromFile(filePath, originalName) {
    const ext = path.extname(originalName).toLowerCase();

    if (ext === '.txt' || ext === '.md' || ext === '.csv') {
      return fs.readFileSync(filePath, 'utf-8');
    }

    if (ext === '.json') {
      const raw = fs.readFileSync(filePath, 'utf-8');
      try {
        const parsed = JSON.parse(raw);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return raw;
      }
    }

    if (ext === '.pdf') {
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return data.text || '';
    }

    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value || '';
    }

    throw new Error(`Format file '${ext}' belum didukung. Gunakan .txt, .md, .pdf, .docx, .json, atau .csv.`);
  }

  async addDocument({ title, originalName, tempFilePath, category = 'all' }) {
    const textContent = await this.extractTextFromFile(tempFilePath, originalName);
    const cleanedText = textContent.replace(/\r\n/g, '\n').trim();

    if (!cleanedText) {
      throw new Error('Dokumen tidak memiliki konten teks yang dapat diekstrak.');
    }

    const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    const safeBase = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageFileName = `${id}_${safeBase}`;
    const destination = path.join(this.knowledgeDir, storageFileName);

    atomicWriteTextSync(destination, cleanedText);
    this.contentCache.set(id, cleanedText);

    const entry = {
      id,
      title: title || originalName,
      originalName,
      fileType: path.extname(originalName).toLowerCase(),
      fileName: storageFileName,
      category,
      enabled: true,
      charCount: cleanedText.length,
      createdAt: new Date().toISOString()
    };

    this.registry.unshift(entry);
    this.saveRegistry();
    return entry;
  }

  addTextSnippet({ title, content, category = 'all' }) {
    const cleanedText = String(content || '').replace(/\r\n/g, '\n').trim();
    if (!cleanedText) throw new Error('Konten teks tidak boleh kosong.');

    const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    const storageFileName = `${id}_snippet.txt`;
    const destination = path.join(this.knowledgeDir, storageFileName);

    atomicWriteTextSync(destination, cleanedText);
    this.contentCache.set(id, cleanedText);

    const entry = {
      id,
      title: title || 'Catatan Pengetahuan',
      originalName: 'snippet.txt',
      fileType: '.txt',
      fileName: storageFileName,
      category,
      enabled: true,
      charCount: cleanedText.length,
      createdAt: new Date().toISOString()
    };

    this.registry.unshift(entry);
    this.saveRegistry();
    return entry;
  }

  deleteDocument(id) {
    const idx = this.registry.findIndex((d) => d.id === id);
    if (idx === -1) return false;

    const entry = this.registry[idx];
    const filePath = path.join(this.knowledgeDir, entry.fileName);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }

    this.contentCache.delete(id);
    this.registry.splice(idx, 1);
    this.saveRegistry();
    return true;
  }

  toggleDocument(id) {
    const entry = this.registry.find((d) => d.id === id);
    if (!entry) return null;
    entry.enabled = !entry.enabled;
    this.saveRegistry();
    return entry.enabled;
  }

  getActiveDocs(targetCategory = 'default', { allowUniversal = true } = {}) {
    this.syncFromDiskIfChanged();
    return this.registry.filter((d) => {
      if (!d.enabled) return false;
      if (d.category === 'all') return allowUniversal;
      return d.category === targetCategory;
    });
  }

  /**
   * Pencarian relevan berbobot kata kunci untuk tool query_knowledge.
   * Mengembalikan string kosong bila tidak ada kecocokan agar tidak membocorkan dokumen tak terkait (DATA-02).
   */
  searchKnowledge(query, targetCategory = 'default', maxMatches = 3, options = {}) {
    const allowUniversal = options.allowUniversal !== false;
    const activeDocs = this.getActiveDocs(targetCategory, { allowUniversal });
    if (activeDocs.length === 0) return '';

    const rawQuery = String(query || '').toLowerCase().trim();
    const tokens = tokenizeQuery(rawQuery);
    const scored = [];

    for (const doc of activeDocs) {
      const content = this.readDocContentCached(doc);
      if (!content) continue;
      const titleLower = String(doc.title || '').toLowerCase();
      const paragraphs = content.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

      for (const para of paragraphs) {
        const lower = para.toLowerCase();
        let score = 0;
        if (rawQuery && lower.includes(rawQuery)) score += 5;
        if (rawQuery && titleLower.includes(rawQuery)) score += 4;
        for (const tok of tokens) {
          if (lower.includes(tok)) score += 2;
          if (titleLower.includes(tok)) score += 2;
        }
        if (score > 0) {
          scored.push({ score, text: `[DOKUMEN: ${doc.title} (${doc.category})]\n${para.slice(0, 1500)}` });
        }
      }
    }

    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, maxMatches).map((s) => s.text).join('\n\n');
    }

    return '';
  }

  /**
   * Mengumpulkan knowledge relevan untuk disuntikkan ke System Prompt dengan cache memori
   * dan anggaran karakter (hemat token saat koleksi dokumen besar).
   * @param {string} targetCategory
   * @param {string} [queryText]
   * @param {{ maxTotalChars?: number, maxPerDocChars?: number, allowUniversal?: boolean }} [options]
   * @returns {string}
   */
  getInjectedKnowledge(targetCategory = 'default', queryText = '', options = {}) {
    const allowUniversal = options.allowUniversal !== false;
    const activeDocs = this.getActiveDocs(targetCategory, { allowUniversal });
    if (activeDocs.length === 0) return '';

    const maxPerDocChars = options.maxPerDocChars ?? 3000;
    const maxTotalChars = options.maxTotalChars ?? 6000;

    const loadedDocs = activeDocs
      .map((doc) => {
        const content = this.readDocContentCached(doc);
        if (!content) return null;
        const trimmed = content.length > maxPerDocChars ? content.slice(0, maxPerDocChars) + '\n...[konten dipotong]' : content;
        return { doc, content, trimmed };
      })
      .filter(Boolean);

    if (loadedDocs.length === 0) return '';

    const totalRawChars = loadedDocs.reduce((acc, item) => acc + item.trimmed.length, 0);

    // Jika total ukuran masih dalam anggaran, suntikkan semuanya langsung
    if (totalRawChars <= maxTotalChars) {
      return loadedDocs
        .map(({ doc, trimmed }) => `[DOKUMEN PENGETAHUAN: ${doc.title} (${doc.category})]\n${trimmed}`)
        .join('\n\n');
    }

    // Jika total melebihi anggaran, prioritaskan dokumen yang paling relevan dengan pesan masuk
    const tokens = tokenizeQuery(queryText);
    const ranked = loadedDocs.map((item, idx) => {
      const titleLower = String(item.doc.title || '').toLowerCase();
      const bodyLower = item.content.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (titleLower.includes(tok)) score += 4;
        if (bodyLower.includes(tok)) score += 2;
      }
      // Dokumen spesifik kategori diberi sedikit bonus di atas universal saat relevan
      if (item.doc.category === targetCategory) score += 1;
      return { ...item, score, idx };
    });

    ranked.sort((a, b) => b.score - a.score || a.idx - b.idx);

    const sections = [];
    const omittedTitles = [];
    let usedChars = 0;

    for (const item of ranked) {
      const remaining = maxTotalChars - usedChars;
      if (remaining >= 300) {
        const chunk = item.trimmed.length > remaining
          ? item.trimmed.slice(0, remaining - 25) + '\n...[pakai query_knowledge]'
          : item.trimmed;
        sections.push(`[DOKUMEN PENGETAHUAN: ${item.doc.title} (${item.doc.category})]\n${chunk}`);
        usedChars += chunk.length;
      } else {
        omittedTitles.push(item.doc.title);
      }
    }

    if (omittedTitles.length > 0) {
      sections.push(
        `[DOKUMEN PENGETAHUAN LAINNYA (panggil tool query_knowledge jika ditanya tentang topik ini): ${omittedTitles.join(', ')}]`
      );
    }

    return sections.join('\n\n');
  }
}

module.exports = KnowledgeManager;
