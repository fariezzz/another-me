/**
 * Knowledge Manager
 * Mengelola basis pengetahuan (knowledge base) dalam berbagai format:
 * .txt, .md, .pdf, .docx, .json, .csv
 * Mengekstrak teks dokumen dan merangkumnya untuk di-inject ke System Prompt LLM.
 */

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

class KnowledgeManager {
  constructor(options = {}) {
    this.dataPath = options.dataPath || path.resolve(__dirname, '../data');
    this.knowledgeDir = path.join(this.dataPath, 'knowledge');
    this.registryFile = path.join(this.dataPath, 'knowledge_registry.json');

    if (!fs.existsSync(this.knowledgeDir)) {
      fs.mkdirSync(this.knowledgeDir, { recursive: true });
    }

    this.registry = [];
    this.loadRegistry();
  }

  loadRegistry() {
    try {
      if (!fs.existsSync(this.registryFile)) {
        const exampleFile = path.join(this.dataPath, 'knowledge_registry.example.json');
        if (fs.existsSync(exampleFile)) {
          fs.copyFileSync(exampleFile, this.registryFile);
        }
      }
      if (fs.existsSync(this.registryFile)) {
        this.registry = JSON.parse(fs.readFileSync(this.registryFile, 'utf-8'));
      } else {
        this.registry = [];
        this.saveRegistry();
      }
    } catch (err) {
      console.warn('[KnowledgeManager] Gagal membaca registry, reset:', err.message);
      this.registry = [];
    }
  }

  saveRegistry() {
    try {
      fs.writeFileSync(this.registryFile, JSON.stringify(this.registry, null, 2), 'utf-8');
    } catch (err) {
      console.error('[KnowledgeManager] Gagal menyimpan registry:', err.message);
    }
  }

  /**
   * Parse berbagai tipe file menjadi teks bersih
   * @param {string} filePath
   * @param {string} originalName
   * @returns {Promise<string>}
   */
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

  /**
   * Menambahkan dokumen knowledge baru
   */
  async addDocument({ title, originalName, tempFilePath, category = 'all' }) {
    const textContent = await this.extractTextFromFile(tempFilePath, originalName);
    const cleanedText = textContent.replace(/\r\n/g, '\n').trim();

    if (!cleanedText) {
      throw new Error('Dokumen tidak memiliki konten teks yang dapat diekstrak.');
    }

    const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    const storageFileName = `${id}_${path.basename(originalName)}`;
    const destination = path.join(this.knowledgeDir, storageFileName);

    // Simpan file teks hasil ekstraksi
    fs.writeFileSync(destination, cleanedText, 'utf-8');

    const entry = {
      id,
      title: title || originalName,
      originalName,
      fileType: path.extname(originalName).toLowerCase(),
      fileName: storageFileName,
      category, // 'all' atau kategori persona tertentu misal 'formal', 'pacar'
      enabled: true,
      charCount: cleanedText.length,
      createdAt: new Date().toISOString()
    };

    this.registry.unshift(entry);
    this.saveRegistry();
    return entry;
  }

  /**
   * Menambahkan knowledge berbasis teks langsung (manual input)
   */
  addTextSnippet({ title, content, category = 'all' }) {
    const cleanedText = content.trim();
    if (!cleanedText) throw new Error('Konten teks tidak boleh kosong.');

    const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    const storageFileName = `${id}_snippet.txt`;
    const destination = path.join(this.knowledgeDir, storageFileName);

    fs.writeFileSync(destination, cleanedText, 'utf-8');

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
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }

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

  /**
   * Mengumpulkan seluruh knowledge yang relevan untuk disuntikkan ke prompt LLM
   * @param {string} targetCategory (misal: 'pacar', 'formal', 'teman_dekat')
   * @returns {string}
   */
  getInjectedKnowledge(targetCategory = 'default') {
    const activeDocs = this.registry.filter((d) => {
      if (!d.enabled) return false;
      if (d.category === 'all' || d.category === targetCategory) return true;
      return false;
    });

    if (activeDocs.length === 0) return '';

    const sections = [];
    for (const doc of activeDocs) {
      const docPath = path.join(this.knowledgeDir, doc.fileName);
      if (fs.existsSync(docPath)) {
        try {
          const content = fs.readFileSync(docPath, 'utf-8');
          // Batasi panjang konten per dokumen agar prompt tidak overload
          const trimmedContent = content.length > 3000 ? content.slice(0, 3000) + '\n...[konten dipotong]' : content;
          sections.push(`[DOKUMEN PENGETAHUAN: ${doc.title} (${doc.category})]\n${trimmedContent}`);
        } catch {}
      }
    }

    return sections.join('\n\n');
  }
}

module.exports = KnowledgeManager;
