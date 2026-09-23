# UGC Flow Studio

Web app self-hosted untuk:

1. **Generate video UGC otomatis dari foto produk** (upload foto -> skrip -> voice over -> video jadi).
2. **Podcast AI** multi-host dengan suara natural + visual waveform.
3. **Voice studio**: text-to-speech natural + ubah suara rekaman jadi lebih natural.
4. **Live 24 jam ke YouTube**: masukkan file video + stream key, streaming jalan sendiri dan auto-reconnect.
5. **Flow otomatis**: watch folder, jadwal harian, interval, dan webhook.

Dibuat dengan Node.js murni (tanpa dependency npm) + ffmpeg. Semua data disimpan lokal di folder proyek.

---

## 1. Kebutuhan

| Kebutuhan | Keterangan |
| --- | --- |
| Node.js 18+ | `node -v` |
| ffmpeg + ffprobe | wajib, harus bisa dipanggil dari terminal (`ffmpeg -version`) |
| Akun Flow Ultra | opsional, tapi ini yang bikin visual video benar-benar AI |
| API TTS | opsional (ElevenLabs / OpenAI / custom). Tanpa ini suara pakai mode simulasi |

Install ffmpeg:

- Windows: `winget install Gyan.FFmpeg` atau download dari ffmpeg.org, lalu tambahkan ke PATH
- macOS: `brew install ffmpeg`
- Ubuntu/Debian: `sudo apt install ffmpeg`

---

## 2. Cara Jalan (3 langkah)

```bash
cp .env.example .env      # Windows: copy .env.example .env
npm run doctor            # cek node, ffmpeg, folder, konfigurasi
npm start
```

Buka **http://localhost:8787**

Tidak ada `npm install` karena proyek ini nol dependency.

---

## 3. Isi API Key (bisa dari UI, tanpa edit file)

Buka menu **Settings** di web, isi lalu klik **Test** di setiap provider:

### Flow Ultra (video + gambar)

| Field | Isi |
| --- | --- |
| Provider | `flow` |
| Base URL | endpoint API Flow kamu |
| API Key | API key Flow Ultra |
| Default lane | `low` = **lower priority / unlimited** |
| Auto fallback ke low | `on` (kalau kuota standard habis, otomatis pindah ke lower priority) |
| Lower priority concurrency | 2 (boleh dinaikkan karena unlimited) |
| Standard daily limit | batas harian lane standard |

Lane `low` dipakai default supaya semua render masuk mode **lower priority yang unlimited**. Lane `standard` hanya dipakai kalau kamu pilih sendiri di form render, dan pemakaiannya dihitung di menu Analytics.

### Voice (TTS)

| Provider | Catatan |
| --- | --- |
| `elevenlabs` | paling natural, isi API key + voice id |
| `openai` | model `gpt-4o-mini-tts` |
| `custom` | endpoint sendiri yang mengembalikan audio |
| `simulate` | tanpa API, suara placeholder, dipakai untuk tes alur |

Semua hasil TTS lewat **naturalizer** ffmpeg: EQ, kompresi, de-esser, room reverb, dan denoise. Preset: `podcast-warm`, `ugc-bright`, `radio-clean`, `asmr-soft`, `voice-over-tv`.

### Penulis skrip (opsional)

Provider `local` memakai template bawaan (8 angle jualan, 6 persona) tanpa API. Provider `remote` memakai API OpenAI-compatible untuk skrip yang lebih variatif.

### YouTube Live

| Field | Isi |
| --- | --- |
| RTMP URL | `rtmp://a.rtmp.youtube.com/live2` |
| Stream key | ambil di YouTube Studio > Go Live > Stream key |

---

## 4. Alur Pemakaian

### A. Video UGC dari foto produk

1. Menu **UGC Studio** -> drag & drop foto produk (bisa banyak sekaligus).
2. Isi nama produk, benefit, masalah yang dipecahkan, angle, dan persona.
3. Klik **Buat skrip** -> skrip per scene muncul dan **masih bisa diedit**.
4. Atur mode render:
   - `flow-video`: tiap scene jadi video AI dari Flow Ultra (paling bagus)
   - `flow-image`: Flow generate gambar, lalu dianimasikan (lebih cepat & hemat)
   - `local`: animasi Ken Burns dari foto kamu sendiri (paling cepat, tanpa API)
5. Klik **Render**. Progres jalan real-time. Hasil masuk **Library**.

Opsi berguna: aspect 9:16 / 1:1 / 16:9, resolusi sampai 4K, subtitle otomatis (5 gaya), music bed (lofi/upbeat/cinematic/calm), watermark, **variants** (1 brief jadi sampai 10 versi berbeda untuk A/B test), dan **per asset** (tiap foto jadi video sendiri, sekali klik).

### B. Podcast AI

Menu **Podcast** -> isi topik, jumlah host + suara masing-masing, durasi, tone. Klik buat skrip, edit dialog kalau perlu, lalu render. Output: MP4 (visual waveform + subtitle) dan MP3 siap upload.

### C. Voice Studio

- Tab **Text to Speech**: tempel teks (panjang otomatis dipotong dan disambung), pilih voice + preset natural.
- Tab **Ubah suara natural**: upload rekaman lama (audio atau video), atur pitch/speed/room/denoise, hasilnya jadi lebih natural.

### D. Live 24 Jam YouTube

1. Menu **Live 24/7** -> **Buat stream**.
2. Pilih video dari Library / Assets (bisa beberapa, jadi playlist berurutan).
3. Paste RTMP URL + stream key YouTube.
4. Mode:
   - `copy`: tanpa re-encode, CPU nyaris nol (pakai ini kalau video sudah H.264/AAC)
   - `auto`: sistem cek file lalu pilih sendiri
   - `encode`: re-encode ke resolusi/bitrate target
5. Audio: pakai audio asli, ganti musik loop, atau silent.
6. Klik **Start**. Centang **Auto start** supaya stream nyala lagi otomatis setiap server restart.

Fitur penjaga live: loop playlist tanpa putus, **auto-reconnect dengan backoff**, health check tiap 30 detik, log ffmpeg per stream, statistik uptime/fps/bitrate/speed, dan **Inspect** yang menghitung total durasi playlist, berapa kali loop per hari, serta estimasi kuota bandwidth per hari.

### E. Flow Otomatis

Menu **Automation**, pilih aksi (`ugc.render`, `podcast.render`, `voice.render`, `images.generate`, `stream.start`, `stream.restart`) dan trigger:

| Trigger | Cara kerja |
| --- | --- |
| `watch-folder` | taruh foto produk ke `storage/inbox` -> video langsung dibuat sendiri |
| `schedule` | jam tertentu + pilihan hari (zona waktu Asia/Jakarta) |
| `interval` | tiap N menit |
| `webhook` | POST ke `/api/hooks/<token>` dari n8n, Zapier, Make, atau cron |
| `manual` | tombol Run |

---

## 5. Fitur Tambahan

- **Dashboard**: statistik render, job aktif, status live, grafik pemakaian 14 hari.
- **Job queue**: concurrency, retry otomatis, pause/resume, cancel, log per job, dan recovery job yang tergantung saat server mati.
- **Library**: video, audio, skrip, podcast. Preview, copy caption + hashtag, download, hapus.
- **Assets**: semua foto/video/audio, upload manual atau dari inbox.
- **Brand kit**: warna, watermark, CTA, hashtag, tone, audience. Otomatis dipakai skrip dan render.
- **Real-time SSE**: progres job, log, dan status live update sendiri tanpa refresh.
- **Analytics**: render per hari, pemakaian lane low vs standard, jumlah gambar dan karakter TTS.
- **Logs**: log sistem terpusat.
- **Notifikasi webhook**: kirim ke Discord/Slack/n8n saat job selesai, job gagal, atau live putus.
- **Basic auth**: isi `AUTH_USER` + `AUTH_PASSWORD` kalau di-host online.
- **Cleanup & reset**: hapus file temporary atau reset database dari menu Settings.

---

## 6. Struktur Folder

```
ugc-flow-studio/
  server/
    index.js            # HTTP server + semua REST API
    lib/                # config, store (json db), queue, events, ffmpeg, http, multipart
    providers/          # flow (video/gambar), tts (suara), llm (skrip)
    services/           # studio (render), stream (live), automation (flow otomatis)
  public/               # UI (HTML, CSS, JS vanilla)
  scripts/doctor.js     # health check
  storage/              # uploads, renders, audio, music, thumbs, tmp, inbox
  data/db.json          # database JSON
```

---

## 7. Troubleshooting

| Masalah | Solusi |
| --- | --- |
| `ffmpeg not found` | install ffmpeg atau set `FFMPEG_PATH` di `.env` |
| Video jadi tapi visual placeholder | Flow masih mode `simulate`. Isi provider `flow` + API key di Settings |
| Suara robotik | provider TTS masih `simulate`. Pakai ElevenLabs/OpenAI dan preset natural |
| Teks/subtitle tidak muncul | font sistem tidak ada. Install `fonts-dejavu` (Linux) lalu render ulang |
| Live gagal start | cek stream key, dan pastikan playlist tidak kosong. Lihat log di menu Live |
| Live boros CPU | pakai mode `copy` dan siapkan video H.264/AAC dengan resolusi yang sama |
| YouTube bilang bitrate tidak stabil | turunkan `videoBitrate` (misal 3000k) atau gunakan mode `copy` |
| Port dipakai aplikasi lain | ubah `PORT` di `.env` |

---

## 8. Catatan

- Render berat itu ffmpeg, jadi makin banyak core CPU makin cepat.
- Untuk live 24 jam, jalankan di VPS dan pakai `pm2 start server/index.js --name ugc-flow` supaya tetap hidup.
- Semua key disimpan di `data/db.json` lokal (ditampilkan tersamar di UI) dan tidak pernah dikirim ke pihak lain selain provider yang kamu isi sendiri.
