# Another Me - WhatsApp AI Auto-Reply & Digital Persona

**Another Me** adalah agen asisten pribadi dan kembaran digital berbasis WhatsApp menggunakan **Baileys** dan **Universal OpenAI-Compatible LLM Client** (Ollama Cloud, Ollama Local, Groq, OpenRouter, OpenAI, DeepSeek, dsb).

Bot ini mempelajari dan meniru gaya chatting WhatsApp kamu secara otentik berdasarkan segmentasi relasi kontak (Pacar, Teman Dekat, Formal/Dosen, Baru Kenal), dilengkapi basis pengetahuan faktual (Knowledge Base), kemampuan otonom (Agent Harness & Tools), deteksi dan pengiriman stiker WhatsApp, serta fitur simulasi mandiri (Training Room).

---

## Fitur Utama

- **Universal LLM & Dual-Model Vision:** Mendukung semua model OpenAI-compatible. Dapat menggunakan model teks cerdas untuk obrolan serta model vision terpisah untuk menganalisis stiker visual.
- **Agent Harness (Function Calling Tools):**
  - `get_current_time`: Mengetahui jam, tanggal, dan fase waktu (pagi/siang/sore/malam) di zona waktu lokal (WIB).
  - `get_weather`: Mengecek prakiraan cuaca, suhu, dan hujan real-time (Open-Meteo API).
  - `web_search`: Pencarian web dan fakta terbaru tanpa limit API key.
  - `send_sticker`: Memilih dan mengirimkan stiker WhatsApp dari koleksi lokal sesuai mood obrolan.
  - `query_knowledge`: Memeriksa informasi spesifik dari dokumen knowledge base.
- **Dukungan Stiker WhatsApp Dua Arah:**
  - Menerima & menginterpretasi ekspresi stiker masuk melalui model multimodal vision.
  - Mengirim stiker format `.webp` secara otonom saat percakapan relevan.
- **Pengiriman Multi-Chat Alami (Multi-Bubble Burst):** AI dapat memecah balasan menjadi 2–3 balon chat pendek beruntun dengan simulasi status "sedang mengetik..." realistis (1.5–2.8 detik).
- **Knowledge Base Multi-Format:** Ekstraksi dokumen `.pdf`, `.docx`, `.md`, `.txt`, `.json`, `.csv`, dan catatan teks faktual ke dalam memori AI.
- **Kustom Persona & Few-Shot Learning:** Aturan gaya ketik santai khas Indonesia (tanpa titik, huruf kecil wajar, kosakata khas relasi) dan contoh chat asli.
- **Training Room (Sandbox & Evaluasi Reflektif):**
  - Menguji percakapan secara simulasi tanpa terkirim ke WhatsApp.
  - Berikan jawaban sempurnamu, AI akan melakukan interpretasi reflektif (*"Ohhh, jadi jawabannya harusnya begitu!"*).
  - Serap hasil evaluasi langsung ke Knowledge Base atau Few-Shot Persona dalam 1 klik.
- **Web Dashboard Kontrol (Clean Light Mode):**
  - Master switch `Service: ON / OFF`.
  - Toggle Whitelist & Balas Pesan Grup.
  - Kelola kontak, izin AI per-nomor, dan ganti endpoint LLM secara live.
  - Inspeksi riwayat chat real-time, metadata sender, dan tombol hapus histori.
  - Pengaturan tersimpan permanen (`data/settings.json`).

---

## Struktur Proyek

```text
another-me/
├── index.js                  # Server utama Baileys + Express API & Dashboard
├── package.json
├── .env                      # Konfigurasi LLM, port, dan lokasi default
├── .env.example
├── .gitignore
├── public/
│   └── index.html            # Web Dashboard (Light Mode UI)
├── src/
│   ├── llmClient.js          # Universal OpenAI-compatible LLM & Agent Harness Loop
│   ├── contextManager.js     # Profil kontak, memory riwayat chat, dan perakit prompt
│   ├── knowledgeManager.js   # Parser & pengelola knowledge base multi-format
│   └── tools/
│       └── toolRegistry.js   # Registri & eksekutor tools (waktu, cuaca, web search, stiker)
├── data/
│   ├── contacts.json         # Buku kontak WhatsApp dan izin balas AI
│   ├── persona.json          # Definisi gaya bicara & few-shot pairs per kategori
│   ├── settings.json         # Persistensi status switch & filter bot
│   ├── stickers/             # Koleksi berkas stiker .webp
│   ├── knowledge/            # Teks hasil ekstraksi knowledge base
│   └── knowledge_registry.json
├── scripts/
│   ├── parse-chat.js         # Parser file ekspor chat WhatsApp (.txt)
│   ├── create-shortcut.ps1   # Generator shortcut Start di Desktop
│   └── create-restart-shortcut.ps1 # Generator shortcut Restart di Desktop
├── start-another-me.bat      # Script batch start service + auto open browser
└── restart-another-me.bat    # Script batch restart paksa service port 3000
```

---

## Panduan Instalasi & Menjalankan

### 1. Instal Dependensi
```bash
npm install
```

### 2. Konfigurasi Environment (`.env`)
Salin berkas `.env.example` menjadi `.env` dan sesuaikan nilainya:
```env
LLM_BASE_URL=https://ollama.com/v1
LLM_MODEL=gemma4
LLM_API_KEY=your_api_key_here

# Opsional: model vision khusus stiker (jika LLM_MODEL adalah text-only)
VISION_MODEL=

PORT=3000
DEFAULT_CITY=Tasikmalaya
DEFAULT_TIMEZONE=Asia/Jakarta
```

### 3. Menjalankan Service
Kamu bisa menggunakan salah satu cara berikut:
- **Via Terminal:**
  ```bash
  npm start
  ```
- **Via Shortcut Desktop (Windows):**
  Klik dua kali shortcut **`Another Me`** di Desktop (service berjalan dan dashboard web terbuka otomatis di browser).

### 4. Tautkan Akun WhatsApp
1. Buka browser di `http://localhost:3000`.
2. Jika sesi belum tertaut, QR Code akan muncul di layar dashboard (dan di terminal).
3. Buka WhatsApp di HP > **Perangkat Tertaut (Linked Devices) > Tautkan Perangkat**, lalu scan QR Code.
4. Sesi akan disimpan di folder `auth_info_baileys/` secara permanen.

---

## Deployment ke Cloud (Enzonic / VPS)

Proyek ini siap di-deploy ke platform container always-on 24/7 seperti **Enzonic Cloud** atau VPS:
1. Hubungkan repository GitHub privat ke Enzonic.
2. Atur Environment Variables (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, dsb) di panel startup Enzonic.
3. Buka console panel Enzonic untuk scan QR Code pertama kali.
4. Dashboard web dapat diakses via subdomain publik ber-SSL bawaan Enzonic.
