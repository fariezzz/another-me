# Another Me - WhatsApp AI Auto-Reply & Digital Persona

**Another Me** adalah bot balas otomatis WhatsApp dan persona digital pribadi berbasis Node.js, **Baileys**, Express 5, serta **Universal OpenAI-Compatible Large Language Model (LLM) Client** (termasuk jalur proksi lokal ke Google AI Studio dengan model `gemma-4-26b-a4b-it`).

Bot ini membalas pesan WhatsApp sesuai gaya ketik pemilik berdasarkan kategori relasi kontak (`pacar`, `teman_dekat`, `formal`, `baru_kenal`, `default`), dilengkapi basis pengetahuan (*Knowledge Base*) multi-format, enam alat (*tools*) otonom, dukungan stiker dua arah, antrean *burst* anti-spam, perintah instan `!acep` dan `!ask`, serta dasbor web *offline* yang responsif.

---

## Fitur Utama

- **Universal LLM & Dual-Model Vision**: Mendukung endpoint OpenAI-compatible (termasuk proksi lokal port 4000 tanpa menyimpan kunci Application Programming Interface (API) di proses bot), lengkap dengan *retry* galat sementara (`429/500/502/503/504`), dukungan header `Retry-After`, batas waktu `AbortSignal.timeout`, dan *cache* kesehatan endpoint.
- **Agent Harness (6 Function Calling Tools)**:
  - `get_current_time`: Jam, tanggal, dan fase waktu lokal (`Asia/Jakarta`).
  - `get_weather`: Prakiraan cuaca *real-time* via Open-Meteo.
  - `web_search`: Pencarian web multi-mesin (Wikipedia kalimat pembuka utuh + Google News RSS + DuckDuckGo).
  - `get_available_stickers` & `send_sticker`: Daftar dan kirim stiker `.webp` otomatis (termasuk penanganan *pseudo-call* teks Gemma).
  - `query_knowledge`: Pencarian berbobot kata kunci dari basis pengetahuan pribadi.
- **Aturan Perilaku Chat Alami**:
  - **Anti-Spam Burst**: Pesan beruntun dari satu pengirim ditampung selama `BURST_WINDOW_MS` (default 4.000 milidetik) dan dibalas sekali fokus pada pesan terakhir.
  - **Maksimal 2 Balon & Huruf Kapital Awal**: Balasan bot dibatasi maksimal 2 balon (kelebihan digabung ke balon kedua tanpa membuang isi) dan setiap balon diawali huruf kapital. Pengiriman manual pemilik lewat dasbor tidak dibatasi 2 balon.
  - **Centang Biru Cerdas**: Pesan ditandai terbaca (*read receipt*) hanya ketika balasan siap dikirim agar pesan gagal tidak tampak diabaikan.
- **Perintah Instan WhatsApp (Awalan `!` saja)**:
  - `!acep` / `!acep on` / `!acep off` / `!acep status` (khusus kontak terdaftar & pemilik di ruang chat kontak terdaftar): Menyalakan atau mematikan Artificial Intelligence (AI) khusus kontak pengirim (tidak mengubah sakelar layanan global).
  - `!ask [pertanyaan]` (alias `!tanya`, **khusus pemilik `fromMe: true`**, berlaku di semua ruang obrolan termasuk diri sendiri, obrolan pribadi siapa pun, dan grup): Menuliskan pertanyaan teks maupun lampiran media (foto, stiker, video/GIF dengan cuplikan bingkai gambar, dokumen PDF/DOCX/teks dengan ekstraksi teks, audio/pesan suara — kirim langsung atau balas media; menolak *View Once*) ke antrean berkas `data/ask-queue/<id>.json` + `data/ask-queue/media/` untuk ditangani hook asisten eksternal, disertai pemantau antrean tertahan di dasbor dan pembersihan otomatis berkas media lama. Non-pemilik yang mengetik `!ask` diabaikan diam-diam tanpa membalas dan tanpa masuk antrean.
- **Perintah Utilitas & Meme WhatsApp (Pemilik & Lawan Chat Pribadi / Grup)**:
  - Dapat dipakai oleh pemilik sendiri (`fromMe: true`, di chat pribadi, chat ke diri sendiri, maupun grup) serta lawan bicara di chat pribadi maupun grup dengan pelindung anti-spam WhatsApp berlapis (*jitter* alami, *cooldown* per pengirim & per grup, kuota jendela geser, *silent drop*, penalti *flood* 30 menit, dan *circuit breaker* global).
  - Seluruh perintah utilitas mendukung **dua awalan (`!` dan `.`)** beserta alias cadangan (misal `!sticker`, `!stiker`, `!s`, `.sticker`, `.stiker`, `.s`).
  - Bantuan & sistem: `!menu` (`help`, `bantuan`, `cmd`, `list`), `!ping` (`cek`, `status`, `uptime`).
  - Media & stiker berbasis Sharp & FFmpeg (batas 5 Megabyte, tolak berkas tidak didukung): `!sticker` (`stiker`, `s`, `stk` — mendukung foto, GIF, dan video pendek menjadi stiker bergerak, **video bersuara otomatis dikirim sebagai Stiker Suara WhatsApp** dengan audio Opus aslinya, opsi `crop` dan `mute`), `!toimg` (`toimage`, `togif`, `tovid`, `tovideo`, `img`, `gambar`, `foto` — stiker diam jadi gambar, stiker bergerak jadi GIF, dan **stiker bersuara jadi video MP4 bersuara**), `!wm <paket> | <pembuat>` (`steal`, `watermark`, `take`), `!crop` (`potong`, `square`, `kotak` — potong foto, video, atau GIF menjadi kotak 1:1 tepat di tengah).
  - Meme kustom: `!text <teks>` (`teks`, `txt` — latar putih polos, teks hitam sans-serif tebal rata kiri blur tipis), `!stext <teks>` (`steks`, `stxt`, `brat`, `sbrat`, `st` — langsung stiker), `!cap <atas> | <bawah>` (`caption`, `burem`, `blurcap` — font Impact kapital dengan emoji berwarna penuh dan efek burik shitpost *downscale-kompresi-upscale* pada foto, video `<= 45` detik dengan audio terjaga, GIF, maupun stiker diam/bergerak/bersuara tanpa menghilangkan suara aslinya, 1 teks otomatis di bawah, urutan diatur lewat `CAP_BLUR_MODE=after|before`, kadar burik lewat `CAP_BLUR_SIGMA`, penyatu teks mode `before` lewat `CAP_TEXT_BLUR_SIGMA`, kanvas keluaran lewat `CAP_MAX_DIM`, serta skala ukuran font lewat `CAP_FONT_SCALE`), dan `!caphd <atas> | <bawah>` (`capclean`, `capclear`, `hdcap`, `meme`, `memecap` — sama seperti `!cap`, tetapi jernih tanpa proses pemburikan pada foto, video, GIF, dan stiker termasuk stiker bersuara).
  - Utilitas harian gratis: `!cuaca [kota]` (`weather`, `suhu`), `!jam [zona]` (`waktu`, `time`, `tanggal`, `tgl`), `!pilih <opsi1 | opsi2 | ...>` (`pick`, `choose`, `acak`, `random`).
- **Dukungan Linked Identity (`@lid`)**: Merekam Jabber Identifier (JID) asli pengirim di `data/contact_jids.json` (termasuk pemetaan alias Baileys v7) dan mendukung pengiriman aman lewat `/api/send-to-contact`.
- **Knowledge Base Multi-Format**: Ekstraksi `.pdf`, `.docx`, `.md`, `.txt`, `.json`, `.csv`, catatan langsung (*snippet*), *cache* memori selektif hemat token, serta fitur lihat & edit isi dokumen dari dasbor.
- **Training Room (Sandbox & Evaluasi Reflektif)**: Menggunakan perakit prompt yang identik dengan WhatsApp sungguhan, tanpa pernah mengirim pesan ke WhatsApp, dilengkapi interpretasi koreksi otomatis dan simpan 1 klik ke *Few-Shot* atau *Knowledge Base*.
- **Dasbor Web Offline & Aman**: Antarmuka *Light Mode* tanpa Content Delivery Network (CDN) eksternal, kode Quick Response (QR) SVG lokal + dukungan Kode Pairing 8 digit, perlindungan *Cross-Site Scripting* (XSS), editor *Few-Shot* visual, dan tampilan kartu responsif di ponsel.

---

## Struktur Proyek

```text
another-me/
├── index.js                         # Titik masuk server Express, CORS ketat, & graceful shutdown
├── package.json
├── .env                             # Konfigurasi lokal (gitignored, jangan pernah di-commit)
├── .env.example
├── .gitignore
├── public/
│   ├── index.html                   # Dasbor web offline (XSS-safe & responsif ponsel)
│   └── styles.css                   # Stylesheet lokal tanpa CDN eksternal
├── src/
│   ├── llmClient.js                 # Klien LLM, agent loop, retry, timeout, pembersih respons
│   ├── contextManager.js            # Kontak, JID @lid, memori chat, & perakit prompt tunggal
│   ├── knowledgeManager.js          # Ekstraksi dokumen, cache memori, & pencarian relevansi
│   ├── settingsStore.js             # Persistensi atomik data/settings.json
│   ├── ollamaClient.js              # Klien Ollama legacy (tidak dipakai jalur utama)
│   ├── media/
│   │   └── imageProcessor.js        # Olah gambar Sharp (!sticker, !toimg, !wm, !text, !stext, !cap)
│   ├── utils/
│   │   ├── atomicFile.js            # Penulisan JSON atomik, validasi WebP, & render QR SVG lokal
│   │   └── webpExif.js              # Penyisip metadata EXIF stiker WhatsApp murni JavaScript
│   ├── whatsapp/
│   │   ├── askMediaHelper.js        # Pengolah lampiran media !ask (foto, stiker, bingkai video, teks dokumen)
│   │   ├── audioStickerCodec.js     # Pengode & pengurai Protobuf Stiker Suara WhatsApp (field 134)
│   │   ├── soundStickerStore.js     # Cache disk audio Stiker Suara persisten lintas restart (7 hari)
│   │   ├── baileysService.js        # Siklus hidup Baileys, backoff reconnect, burst, & loop guard
│   │   ├── commandAntiSpam.js       # Pelindung anti-spam berlapis & pembatas konkurensi media
│   │   ├── commandRouter.js         # Parser !acep, !ask, serta pemantau/pembersih ask-queue
│   │   └── utilityCommands.js       # Router perintah utilitas & meme WhatsApp
│   ├── routes/
│   │   └── apiRoutes.js             # Seluruh endpoint HTTP /api/*
│   └── tools/
│       └── toolRegistry.js          # 6 tools otonom (waktu, cuaca, Wiki+News+DDG, stiker, KB)
├── assets/
│   └── fonts/                       # Font cadangan Anton & Archivo Narrow (OFL 1.1) + fonts.conf khusus Linux
├── test/                            # Rangkaian uji otomatis berbasis node:test bawaan Node.js
├── data/
│   ├── persona.json                 # Identitas persona, aturan ketik, & few-shot per kategori
│   ├── contacts.example.json        # Templat daftar kontak
│   ├── settings.example.json        # Templat pengaturan layanan
│   ├── knowledge_registry.example.json
│   ├── stickers/                    # Koleksi berkas stiker .webp (gitignored)
│   ├── knowledge/                   # Teks hasil ekstraksi knowledge base (gitignored)
│   └── raw_chats/                   # Ekspor chat WhatsApp mentah (gitignored)
├── scripts/
│   ├── parse-chat.js                # Parser ekspor chat WhatsApp (.txt) ke persona.json
│   ├── create-shortcut.ps1          # Pembuat shortcut Start di Desktop Windows (path dinamis)
│   └── create-restart-shortcut.ps1  # Pembuat shortcut Restart di Desktop Windows (path dinamis)
├── start-another-me.bat             # Skrip start Windows portabel
└── restart-another-me.bat           # Skrip restart Windows portabel (berbasis PID port 3000)
```

---

## Panduan Instalasi & Menjalankan

### 1. Instal Dependensi
```bash
npm install
```

### 2. Konfigurasi Environment (`.env`)
Salin `.env.example` menjadi `.env` lalu sesuaikan nilainya (untuk jalur proksi lokal pada Muse Virtual Machine (VM), biarkan `LLM_API_KEY=` kosong karena kunci API disuntikkan oleh proksi):
```env
LLM_BASE_URL=http://127.0.0.1:4000/v1beta/openai
LLM_MODEL=gemma-4-26b-a4b-it
LLM_API_KEY=
VISION_MODEL=gemma-4-26b-a4b-it
HOST=127.0.0.1
PORT=3000
BURST_WINDOW_MS=4000
```

### 3. Menjalankan Pengujian & Verifikasi Sintaks
```bash
node --check index.js
npm test
```

### 4. Menjalankan Layanan
- **Terminal (Linux / Muse VM / Windows)**:
  ```bash
  npm start
  ```
- **Windows Desktop**: Jalankan `start-another-me.bat` atau buat shortcut dengan `scripts/create-shortcut.ps1`.
- **Verifikasi Kesehatan**:
  ```bash
  curl -s http://127.0.0.1:3000/api/status
  ```
  Pastikan `whatsapp.status` bernilai `"connected"` dan `llm.connected` bernilai `true`.

### 5. Menautkan Akun WhatsApp
1. Buka dasbor di `http://127.0.0.1:3000` (atau domain Cloudflare Access milikmu).
2. Pindai kode QR pada kartu **Koneksi WhatsApp**, atau gunakan opsi **Kode Pairing 8 Digit** langsung dari kartu yang sama.
3. Sesi tersimpan di `auth_info_baileys/` (jangan pernah dibagikan atau di-commit ke Git).
