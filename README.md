# UGC Flow Studio

Aplikasi web self-hosted (jalan di PC kamu sendiri) untuk:

1. **Video UGC otomatis dari foto produk**: foto -> skrip -> klip dari Google Flow -> voice over + subtitle -> video siap upload.
2. **Podcast AI** 2 host (suara bisa beda) + visual waveform + subtitle.
3. **Voice Studio**: text-to-speech natural (Fish Audio / Google gratis) + ubah rekaman jadi lebih natural.
4. **Live 24 jam ke YouTube**: playlist video + stream key, auto-reconnect, lanjut sendiri setelah PC restart.
5. **Flow otomatis**: watch folder, jadwal harian, interval, dan webhook (n8n / Zapier / Make).

Dibuat dengan Node.js murni (tanpa `npm install`) + ffmpeg. Semua data tersimpan lokal di folder proyek.

---

## 1. Cara menjalankan

### Windows (paling mudah)

Klik 2x salah satu file ini:

| File | Keterangan |
| --- | --- |
| `KLIK-DISINI-UNTUK-MULAI.bat` | jendela server kelihatan (bisa lihat log) |
| `Jalankan.vbs` | sama, tapi jendela server langsung diperkecil ke taskbar |

Launcher otomatis:

- membuat file `.env` dari `.env.example` (kalau belum ada),
- mengunduh **Node.js** dan **FFmpeg portable** ke folder `tools\` kalau belum terpasang (atau Node.js di PC terlalu lama, < v18),
- menutup server lama yang masih jalan di port yang sama,
- membuka browser ke **http://localhost:8787**.

Tutup jendela server (atau Ctrl+C) untuk berhenti.

### macOS / Linux

```bash
cp .env.example .env
npm run doctor     # cek node, ffmpeg, folder, konfigurasi
npm start          # buka http://localhost:8787
```

Butuh Node.js 18+ dan ffmpeg (`brew install ffmpeg` / `sudo apt install ffmpeg fonts-dejavu`).

### Cek kesehatan (doctor)

`npm run doctor` (Windows tanpa Node terpasang: `tools\node\node.exe scripts\doctor.js`) mengecek Node, ffmpeg + encoder, font, folder, port, database, API key yang aktif, voice Fish Audio, LLM, stream key (tersamar), dan setelan keamanan. Aman dijalankan walau server sedang jalan (tidak mengubah database).

---

## 2. Yang perlu kamu isi sendiri (API key)

Isi di file `.env` **atau** dari menu **Settings** di web (klik tombol **Tes** di tiap bagian). Kalau nilai di `.env` diubah, nilai baru otomatis dipakai saat server dinyalakan ulang.

| Kebutuhan | Variabel `.env` | Catatan |
| --- | --- | --- |
| **Fish Audio** (suara utama) | `FISHAUDIO_API_KEY`, `FISHAUDIO_VOICE_ID` | API key dari https://fish.audio (menu API Keys). Voice ID = `reference_id` 32 karakter dari halaman voice/model |
| Voice kedua (opsional) | `FISHAUDIO_VOICE_ID_2` | dipakai Host B di Podcast AI supaya 2 host beda suara (juga bisa diisi di Settings > "Voice ID Host B") |
| **Flow API** (opsional) | `FLOW_PROVIDER=flow`, `FLOW_BASE_URL`, `FLOW_API_KEY` | hanya kalau punya endpoint API Flow. Tanpa API tetap bisa pakai **Google Flow di browser + ekstensi** (lihat bagian 4A) |
| **LLM** penulis skrip (opsional) | `LLM_PROVIDER=remote`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | API apa saja yang kompatibel OpenAI (OpenAI, OpenRouter, Groq, DeepSeek, Ollama lokal). Tanpa ini pakai template lokal gratis |
| **YouTube stream key** | `YT_STREAM_KEY` | dari YouTube Studio > Go Live > Stream. Bisa juga diisi per channel di menu Live 24 Jam |

Tanpa API key apa pun aplikasi tetap jalan penuh:

- **Suara**: kalau key Fish Audio kosong / ditolak / saldo habis, otomatis pindah ke **Google TTS gratis** (butuh internet), lalu suara placeholder kalau offline. Render tidak pernah gagal gara-gara suara; alasannya dicatat di log job dan terlihat di status **TTS** pada sidebar.
- **Visual**: mode `simulate` membuat video dari foto kamu sendiri (gerak kamera Ken Burns).
- **Skrip**: template bawaan (8 angle jualan, beberapa persona). Kalau LLM remote gagal / habis kuota, otomatis kembali ke template lokal.

Semua key disimpan lokal (`.env` / `data/db.json`), ditampilkan tersamar di UI, dan **tidak ikut ter-upload ke GitHub** (keduanya ada di `.gitignore`).

---

## 3. Keamanan (baru di v1.1.0)

- **Website lain diblokir**: halaman web lain yang kamu buka di browser tidak bisa mengontrol studio lewat `localhost` (proteksi CSRF, CORS, dan DNS rebinding). Yang selalu boleh: localhost, alamat IP, nama PC, domain `.local` / `.lan`, Google Flow (`flow.google.com`, `labs.google`) dan ekstensi browser.
- **Pakai tunnel / domain sendiri** (ngrok, cloudflared, dll.)? Tambahkan domainnya ke `ALLOWED_HOSTS` di `.env` (pisahkan dengan koma). Website lain yang memang perlu memanggil API: isi `CORS_ORIGINS`, contoh `CORS_ORIGINS=https://studio.domainkamu.com`.
- **Dibuka dari internet / jaringan lain?** Aktifkan login: `AUTH_ENABLED=true` + `AUTH_PASSWORD=...`.
- **Import dari Downloads** hanya boleh untuk file video yang benar-benar ada di folder Downloads (tidak bisa mengambil file sembarang di komputer). Folder Downloads dideteksi otomatis (termasuk kalau dipindah ke drive lain); bisa diganti lewat `DOWNLOADS_DIR`.

---

## 4. Alur pemakaian

### A. Video UGC dari foto produk + Google Flow

1. Menu **UGC Studio** -> upload foto produk (bisa banyak sekaligus), isi brief produk.
2. Klik **Buat skrip** -> skrip per scene muncul dan **bisa diedit**.
3. Klik **Buka di Flow** pada scene: prompt disalin dan Google Flow terbuka. Tempel (Ctrl+V), klik Generate, lalu **Download** hasilnya.
4. Studio memantau folder **Downloads**: klip yang di-download berurutan (dalam `FLOW_INGEST_SETTLE_SECONDS`, default 20 detik) **digabung jadi 1 video**, diberi voice over + subtitle, lalu masuk **Library**.
   - Tombol **Cek & Ambil Video dari Downloads** = ambil manual.
   - **Pilih File Video Manual** bisa pilih sampai 20 klip sekaligus (diurutkan sesuai nama file).
5. Tanpa Flow: pilih sumber visual **Lokal saja**, klik **Render video sekarang**.

Opsi render: rasio 9:16 / 1:1 / 16:9, resolusi **480p sampai 2160p (4K)** termasuk **1440p (2K)**, 5 gaya subtitle, musik latar, watermark, **variasi** (1 brief jadi sampai 10 versi berbeda: hook, urutan gambar dan gerak kamera lain), dan **1 video per foto** (batch).

### B. Ekstensi Chrome "UGC Flow Connector"

Panel kecil di Google Flow yang menampilkan prompt scene aktif dari studio + tombol **Masukkan & Generate** / **Salin**.

Pasang: `chrome://extensions` -> aktifkan **Developer mode** -> **Load unpacked** -> pilih folder `extension` di proyek ini. Panduan lengkap: `extension/PANDUAN-PASANG.txt`.

- Ganti `PORT` / server di komputer lain? Klik ikon ekstensi, isi **Alamat server UGC Studio** (mis. `http://localhost:9000`), klik **Simpan alamat**. Popup juga menampilkan status koneksi + versi server.
- **Setelah update proyek**, buka `chrome://extensions` lalu klik **Reload** di kartu ekstensi.

### C. Podcast AI

Menu **Podcast AI** -> topik, jumlah host, durasi, tone -> buat skrip -> edit dialog -> render. Host A memakai `FISHAUDIO_VOICE_ID`, Host B memakai `FISHAUDIO_VOICE_ID_2` (kalau kosong: voice yang sama dengan pitch sedikit berbeda). Output MP4 (waveform + subtitle) dan MP3.

### D. Voice Studio

- **Text to Speech**: teks panjang otomatis dipotong dan disambung, pilih voice + preset natural (`podcast-warm`, `ugc-bright`, `radio-clean`, `asmr-soft`, `voice-over-tv`).
- **Ubah suara natural**: upload rekaman (audio / video), atur pitch, speed, room, denoise.
- Hasil TTS disimpan di cache (`TTS_CACHE=1`) supaya teks yang sama tidak menghabiskan kredit lagi.

### E. Live 24 Jam YouTube

1. Menu **Live 24 Jam** -> **Buat channel live** -> pilih video (bisa beberapa, jadi playlist).
2. Stream key: tempel di form, atau **kosongkan** untuk memakai key default (`YT_STREAM_KEY` / Settings > Live). Channel dengan key kosong selalu memakai key default terbaru, jadi cukup ganti di satu tempat. URL lengkap `rtmp://server/app/KEY` juga diterima.
3. Mode: `auto` (copy / hemat CPU hanya kalau semua video H.264 dan ukurannya sudah sama dengan resolusi + rasio yang dipilih; selain itu encode ulang), `copy`, atau `encode`. Tombol **Inspect** menampilkan mode yang akan dipakai beserta alasannya.
4. Pilih resolusi (480p - 4K) dan rasio (16:9 horizontal / 9:16 vertikal). 4K butuh bitrate +-20000k dan upload kencang.
5. Centang **Auto start** supaya live nyala lagi otomatis setelah server / PC restart.

Penjaga live: loop tanpa putus, auto-reconnect dengan backoff, health check, log ffmpeg per channel, statistik uptime/fps/bitrate, dan **Inspect** (durasi playlist, loop per hari, estimasi kuota bandwidth).

### F. Flow Otomatis (automation)

Aksi: `ugc.render`, `podcast.render`, `voice.render`, `images.generate`, `stream.start`, `stream.restart`.

| Pemicu | Cara kerja |
| --- | --- |
| `watch-folder` | taruh file ke folder pantauan (default `storage/inbox`, bisa folder lain). Beberapa foto 1 produk: masukkan ke **1 subfolder** (nama subfolder = nama produk) atau beri nama `serum-1.jpg`, `serum-2.jpg`. File `.txt` dipakai sebagai naskah (Voice / Podcast / Gambar). File yang masih disalin ditunggu sampai selesai |
| `schedule` | jam tertentu + hari (`0,1,2...6` atau `sen,rab,jum`). Zona waktu dari `TIMEZONE` di `.env`. Jadwal yang terlewat karena PC mati masih dijalankan kalau telatnya < 3 jam |
| `interval` | tiap N menit |
| `webhook` | POST JSON ke `/api/hooks/<token>` dari n8n / Zapier / Make / cron |
| `manual` | tombol **Run sekarang** (untuk watch folder = cek folder saat itu juga) |

---

## 5. Fitur lain

- **Dashboard**: statistik render, job aktif, status live, grafik pemakaian 14 hari. Sidebar menampilkan status Flow, TTS, dan koneksi realtime.
- **Job queue**: render paralel (`QUEUE_CONCURRENCY`), retry otomatis, pause, **cancel yang benar-benar menghentikan ffmpeg**, log per job, dan job yang terputus saat PC mati **dilanjutkan otomatis** saat server nyala.
- **Library & Aset**: preview, salin caption + hashtag, download, hapus.
- **Brand kit**: warna, watermark, CTA, hashtag, tone, audience -> otomatis dipakai skrip dan render.
- **Real-time**: progres job, log, dan status live update sendiri (SSE), otomatis sinkron lagi setelah koneksi putus.
- **Notifikasi webhook** (`NOTIFY_WEBHOOK_URL`): Discord / Slack / n8n saat job selesai, gagal, atau live putus.
- **Bersih-bersih** (Settings): hapus file temporary, cache TTS lama, dan aset yatim; file yang masih dipakai live / job aktif tidak disentuh. Log lama dihapus otomatis.
- **Buka dari HP** (Wi-Fi sama): alamat LAN ditampilkan di jendela server. Aktifkan login kalau dipakai bersama.

---

## 6. Data, backup & update

- Database: `data/db.json` (**tidak** disimpan di GitHub). Backup harian otomatis di `data/backups/` (7 hari terakhir).
- Kalau `db.json` rusak **atau hilang**, server otomatis memulihkan dari backup terbaru (file rusak disalin dulu sebagai `db.json.corrupt-...`).
- Hasil render, upload, audio: folder `storage/`. Konfigurasi: `.env`.

### Update aplikasi

**Kalau folder ini hasil `git clone`**: klik 2x `UPDATE-APLIKASI.bat` (server ditutup dulu, `data/db.json` diamankan, lalu `git pull`).

**Update pertama ke v1.1.0** (sebelum `UPDATE-APLIKASI.bat` ada): `data/db.json` sekarang tidak lagi disimpan di git, jadi `git pull` biasa akan menghapus file itu atau gagal. Amankan dulu (Command Prompt di folder proyek):

```bat
copy data\db.json data\db-backup.json
git checkout -- data/db.json
git pull
move /y data\db-backup.json data\db.json
```

Setelah itu `db.json` aman dan tidak akan ikut ter-commit lagi.

**Kalau download ZIP dari GitHub**: ekstrak lalu timpa isi folder lama. Folder `data`, `storage`, `tools` dan file `.env` tidak ada di ZIP, jadi tidak tertimpa.

Setelah update: jalankan lagi launcher, dan **Reload** ekstensi Chrome.

---

## 7. Struktur folder

```
server/
  index.js              # HTTP server + REST API + SSE
  lib/                  # config, store (db json), queue, jobctx, events, ffmpeg, httpx, downloads
  providers/            # flow (video/gambar), tts (suara), llm (skrip)
  services/             # studio (render), stream (live), automation
public/                 # UI (HTML, CSS, JS tanpa framework)
extension/              # ekstensi Chrome untuk Google Flow
scripts/                # doctor.js (cek kesehatan), reset.js
data/                   # db.json, backups/, logs/ (dibuat otomatis)
storage/                # uploads, renders, audio, inbox, tmp (dibuat otomatis)
tools/                  # Node.js & FFmpeg portable (diunduh launcher)
```

---

## 8. Troubleshooting

| Masalah | Solusi |
| --- | --- |
| `ffmpeg tidak ditemukan` | jalankan `KLIK-DISINI-UNTUK-MULAI.bat` (download otomatis) atau isi `FFMPEG_PATH` / `FFPROBE_PATH` di `.env` |
| Status TTS "Voice Google (gratis)" padahal sudah isi Fish Audio | cek `FISHAUDIO_API_KEY` + saldo, klik **Tes suara** di Settings. Alasan fallback terlihat saat kursor diarahkan ke status TTS di sidebar dan di log job |
| Voice Fish Audio tidak berubah | pastikan `FISHAUDIO_VOICE_ID` berisi 32 karakter hex (reference_id), lalu restart server |
| Video Flow tidak terambil otomatis | pastikan file ter-download ke folder Downloads (cek `DOWNLOADS_DIR`), klik **Cek & Ambil Video dari Downloads** |
| Panel ekstensi tidak muncul / "server offline" | server harus jalan; izinkan akses jaringan lokal di Chrome; cek alamat server di popup ekstensi; Reload ekstensi |
| `Host ... tidak diizinkan` (403) | buka lewat `localhost` / IP, atau tambahkan domain ke `ALLOWED_HOSTS` |
| `Permintaan dari website lain ... ditolak` (403) | tambahkan origin website itu ke `CORS_ORIGINS` kalau memang perlu |
| Live gagal start | cek stream key dan playlist; lihat **Log streaming** di menu Live |
| YouTube: bitrate tidak stabil | turunkan bitrate (mis. 3000k) atau pakai mode `copy` |
| Port dipakai aplikasi lain | ganti `PORT` di `.env` (lalu isi alamat baru di popup ekstensi) |
| Jadwal jalan di jam yang salah | cek `TIMEZONE` di `.env` (mis. `Asia/Jakarta`, `Asia/Makassar`, `Asia/Jayapura`) |

---

## 9. Changelog

### v1.1.0

**Perbaikan**

- Launcher Windows: cek versi Node.js (min. 18, otomatis pakai Node portable kalau terlalu lama), line ending `.bat` konsisten (CRLF), server lama ditutup dulu sebelum start; kalau port masih dipakai studio yang sama, cukup buka browser (tidak error).
- Pilihan resolusi 1440p / 4K dan rasio live benar-benar dipakai; subtitle tidak lagi gepeng; teks berisi `%` (mis. "diskon 50%") tampil apa adanya.
- Cancel job menghentikan proses ffmpeg; job yang terputus saat PC mati dilanjutkan otomatis.
- TTS: fallback Fish Audio -> Google gratis -> placeholder dengan alasan yang jelas; `FISHAUDIO_VOICE_ID` yang diganti di `.env` langsung dipakai; tidak ada retry berulang saat key ditolak.
- Nilai `.env` yang diubah otomatis dipakai setelah restart (dulu tertimpa nilai lama di database).
- Live: mode `auto` default, cek format sebelum `copy`, tidak ada 2 ffmpeg ke stream key yang sama, hitungan restart direset setelah stabil.
- Automation: zona waktu, jadwal terlewat (maks 3 jam), watch folder menunggu file selesai disalin.
- Database: tulis atomik (tahan antivirus Windows), backup harian + pemulihan otomatis kalau rusak / hilang.
- UI: sinkron ulang otomatis setelah koneksi putus, notifikasi berwarna, beberapa tombol dan form yang sebelumnya tidak bekerja.
- Ekstensi: aman dari XSS, tidak berkedip, tombol Generate yang dipilih tepat, dukung `labs.google`.

**Fitur baru**

- Proteksi keamanan (blokir website lain / DNS rebinding) + `ALLOWED_HOSTS`, `CORS_ORIGINS`.
- Voice kedua Fish Audio untuk Host B podcast (`FISHAUDIO_VOICE_ID_2`).
- Beberapa klip Flow sekaligus digabung jadi 1 video (auto dari Downloads atau pilih manual).
- Variasi video yang benar-benar berbeda (hook, urutan gambar, gerak kamera).
- Watch folder: grup per subfolder / nama file, `.txt` sebagai naskah, folder pantauan bisa diganti.
- Popup ekstensi: status koneksi + pengaturan alamat server.
- `UPDATE-APLIKASI.bat` untuk update 1 klik.
- Doctor lebih lengkap dan aman dijalankan saat server hidup.
- Bersih-bersih cache TTS lama & aset yatim, log lama dihapus otomatis.
