# 📄  Bot Cek Bio WA By Angga Official

````markdown
<p align="center">
  <img src="https://readme-typing-svg.herokuapp.com?font=Fira+Code&size=28&pause=1000&color=00F700&center=true&vCenter=true&width=600&lines=🤖+Bot+Cek+Bio+WhatsApp;By+Angga+Official;Detect+Bio+%2B+OTP+Cooldown+Monitor" alt="Title" />
</p>

<p align="center">
  <a href="https://instagram.com/angga.is_back">
    <img src="https://img.shields.io/badge/Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white" alt="Instagram" />
  </a>
  <a href="https://youtube.com/@bacotamatpro03">
    <img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube" />
  </a>
  <a href="https://t.me/Botrekaduelbot?start=_tgr_tAseF8RjNDM9">
    <img src="https://img.shields.io/badge/Telegram-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram" />
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white" />
  <img src="https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/Baileys-Latest-success?style=flat-square&logo=whatsapp&logoColor=white" />
  <img src="https://img.shields.io/badge/Express.js-000000?style=flat-square&logo=express&logoColor=white" />
  <img src="https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/Version-2.0.0-brightgreen?style=flat-square" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/anggaofficial/cekbio-wa-bot?style=social" />
  <img src="https://img.shields.io/github/forks/anggaofficial/cekbio-wa-bot?style=social" />
  <img src="https://img.shields.io/github/issues/anggaofficial/cekbio-wa-bot" />
  <img src="https://img.shields.io/github/last-commit/anggaofficial/cekbio-wa-bot" />
</p>

---

## 📖 Deskripsi

**Bot Cek Bio WhatsApp By Angga Official** adalah bot Telegram canggih yang dapat mendeteksi **Bio WhatsApp** dari sebuah nomor, melakukan **Cek Massal** dari file `.txt`, serta memantau **OTP Cooldown** untuk nomor-nomor tertentu. Bot ini dibangun dengan arsitektur dual-stack:

- 🐍 **Python (Telegram Bot)** — Interface utama untuk user
- 🟢 **Node.js (WhatsApp Sender)** — Bridge ke WhatsApp menggunakan Baileys

Bot ini cocok untuk:
- 🕵️ Investigasi nomor
- 📊 Validasi database nomor WA
- 🔐 Monitor OTP cooldown untuk automation
- 📈 Statistik penggunaan WA

---

## ✨ Fitur Utama

### 🤖 Fitur Bot Telegram
| Fitur | Deskripsi |
|-------|----------|
| 📝 **Cek Bio Tunggal** | Deteksi bio dari 1 nomor WA |
| 📊 **Cek Massal** | Upload file `.txt` → cek ratusan nomor sekaligus |
| ⏳ **OTP Cooldown Monitor** | Pantau status cooldown OTP nomor |
| 💎 **Sistem Tier Premium** | Free / VIP / XVIP / VVIP dengan limit harian |
| 💳 **Pembayaran Otomatis** | QRIS + verifikasi admin otomatis |
| 👥 **Referral System** | Ajak teman dapat bonus |
| 📈 **Statistik Real-time** | Total deteksi & user |
| 🛡️ **Anti-Spam Rate Limiting** | 10 command/menit per user |

### 🟢 Fitur Sender (Node.js API)
| Fitur | Deskripsi |
|-------|----------|
| 📡 **REST API** | 9 endpoint tersedia |
| 💾 **Cache TTL** | Bio cache 5 menit, cooldown 10 menit |
| 🔄 **Auto-Reconnect** | Exponential backoff max 10 attempts |
| 📊 **Metrics Endpoint** | Monitor performa server |
| 🩺 **Health Check** | Status server & koneksi WA |
| ⚡ **Rate Limiting** | Anti-abuse API |
| 📝 **File Logging** | Rotasi log harian |
| 🛑 **Graceful Shutdown** | Logout WA saat server stop |

---

## 🏗️ Arsitektur

```
┌──────────────────────────────────────────────────────────┐
│                    USER TELEGRAM                          │
│                         │                                 │
│                         ▼                                 │
│            ┌────────────────────────┐                    │
│            │   Python Bot (PTB)     │                    │
│            │   - Command Handlers   │                    │
│            │   - SQLite Database    │                    │
│            │   - Inline Keyboard    │                    │
│            └────────────┬───────────┘                    │
│                         │ HTTP (aiohttp)                 │
│                         ▼                                 │
│            ┌────────────────────────┐                    │
│            │  Node.js Sender API   │                    │
│            │  - Express             │                    │
│            │  - Baileys WA Socket   │                    │
│            │  - Cache + Rate Limit  │                    │
│            └────────────┬───────────┘                    │
│                         │ WebSocket                       │
│                         ▼                                 │
│            ┌────────────────────────┐                    │
│            │   WhatsApp Servers     │                    │
│            │   (fetchStatus, etc)   │                    │
│            └────────────────────────┘                    │
└──────────────────────────────────────────────────────────┘
```

---

## 📋 Daftar Perintah Bot

### 👤 User Commands
| Command | Fungsi |
|---------|--------|
| `/start` | Menu utama & info akun |
| `/detek +628xxx` | Cek 1 Bio WhatsApp |
| `/cooldown +628xxx` | Cek OTP Cooldown Monitor |
| `/cooldownlist` | List semua nomor yang di-cek |
| `/myaccount` | Detail akun + link referral |
| `/premium` | Lihat & beli paket premium |
| `/help` | Bantuan lengkap |

### 👑 Admin Commands
| Command | Fungsi |
|---------|--------|
| `/upgrade <id> <tier> <hari>` | Upgrade user ke premium |
| `/resetlimit <id>` / `/resetlimit all` | Reset limit user |
| `/broadcast <pesan>` | Broadcast ke semua user |
| `/listuser` | List 50 user terakhir |
| Kirim file `.txt` | Cek massal (admin only) |

---

## 💎 Sistem Tier Premium

| Tier | Limit/Hari | Harga/Hari | Badge |
|------|------------|------------|-------|
| **Free** 🆓 | 5 nomor | Rp 0 | - |
| **VIP** ⭐ | 25 nomor | Rp 3.000 | Premium |
| **XVIP** 🌟 | 50 nomor | Rp 7.000 | Premium+ |
| **VVIP** 💎 | 100 nomor | Rp 10.000 | Elite |

---

## 📡 REST API Endpoints

| Endpoint | Method | Deskripsi |
|----------|--------|-----------|
| `/health` | GET | Cek status server & uptime |
| `/status` | GET | Status koneksi WhatsApp |
| `/metrics` | GET | Statistik penggunaan API |
| `/cek?nomor=62xxx` | GET | Cek bio 1 nomor |
| `/detail?nomor=62xxx` | GET | Info lengkap (bio, business, photo) |
| `/cooldown?nomor=62xxx` | GET | Cek OTP Cooldown |
| `/masscek` | POST | Cek massal nomor |
| `/clearcache` | POST | Bersihkan cache |
| `/restart` | POST | Restart server (admin only) |

### Contoh Response `/cooldown`
```json
{
    "status": true,
    "phone": "6281234567890",
    "exists": true,
    "status_text": "ready",
    "isOnCooldown": false,
    "cooldownEnds": null,
    "timestamp": "2026-10-06T19:44:46.000Z",
    "message": "Nomor siap OTP"
}
```

---

## 🚀 Instalasi & Setup

### 📦 Prasyarat
- **Node.js** v18+ ([download](https://nodejs.org))
- **Python** 3.9+ ([download](https://python.org))
- **WhatsApp Number** (untuk pairing)
- **Telegram Bot Token** (dari [@BotFather](https://t.me/BotFather))

### 1️⃣ Clone Repository
```bash
git clone https://github.com/anggaofficial/cekbio-wa-bot.git
cd cekbio-wa-bot
```

### 2️⃣ Setup Sender (Node.js)
```bash
cd sender
npm install
cp config.example.json config.json
# Edit config.json dengan WA number & admin key
npm start
```

Pairing code akan muncul di console:
```
========================================
🔑 KODE PAIRING ANDA: ABC-XYZ-123
========================================
```
Masukkan kode di WhatsApp → Settings → Linked Devices → Link with phone number

### 3️⃣ Setup Bot (Python)
```bash
cd bot
python -m venv venv
source venv/bin/activate  # Linux/Mac
# atau: venv\Scripts\activate  # Windows
pip install -r requirements.txt
cp config.example.py config.py
# Edit config.py dengan BOT_TOKEN, ADMIN_ID, dll.
python bot.py
```

### 4️⃣ Jalankan dengan PM2 (Recommended)
```bash
npm install -g pm2
pm2 start sender/sender.js --name wa-sender
pm2 start "python bot/bot.py" --name tg-bot
pm2 save
pm2 startup
```

---

## ⚙️ Konfigurasi

### `sender/config.json`
```json
{
    "WA_NUMBER": "6281234567890",
    "PORT": 3000,
    "ADMIN_KEY": "your-secret-admin-key-123",
    "BOT_TOKEN": "YOUR_TELEGRAM_BOT_TOKEN"
}
```

### `bot/config.py`
```python
BOT_TOKEN = "YOUR_BOT_TOKEN_HERE"
BOT_USERNAME = "YourBotUsername"
ADMIN_ID = 123456789
ADMIN_USERNAME = "AnggaOfficial"
CHANNEL_URL = "https://t.me/YourChannel"
QRIS_IMAGE_URL = "https://i.ibb.co/your-qris.jpg"
API_BASE_URL = "http://localhost:3000"
```

---


## 📊 Screenshot

<p align="center">
  <img src="https://via.placeholder.com/400x600/1a1a1a/00F700?text=Bot+Telegram+Screenshot" alt="Bot Screenshot" />
  <img src="https://via.placeholder.com/400x600/1a1a1a/00F700?text=OTP+Cooldown+Monitor" alt="Cooldown Screenshot" />
</p>

---

## 🔧 Troubleshooting

| Masalah | Solusi |
|---------|--------|
| ❌ `Sender WA offline` | Pastikan `sender.js` berjalan & WhatsApp terhubung |
| ❌ `Pairing gagal` | Hapus folder `auth_info_baileys/`, restart |
| ❌ `Limit habis` | Gunakan `/premium` untuk upgrade |
| ❌ `Bot tidak respond` | Cek log `bot.log` & `logs/sender_*.log` |
| ❌ `Mass check lambat` | Normal, 300ms/nomor untuk anti-ban |
| ❌ `Emoji rusak di console` | Set terminal UTF-8 (`chcp 65001` Windows) |

---

## 🤝 Contributing

Pull request selalu welcome! Untuk perubahan besar, buka issue dulu untuk diskusi.

1. Fork repo
2. Buat branch fitur (`git checkout -b feature/FiturBaru`)
3. Commit (`git commit -m 'Add FiturBaru'`)
4. Push (`git push origin feature/FiturBaru`)
5. Buka Pull Request

---

## 📝 License

Distributed under the MIT License. Lihat [`LICENSE`](LICENSE) untuk detail.

---

## ⚠️ Disclaimer

> Bot ini untuk tujuan **edukasi & validasi data**. Penyalahgunaan untuk spam, harassment, atau aktivitas ilegal **bukan tanggung jawab developer**. Gunakan dengan bijak & sesuai hukum yang berlaku.

---

## 👨‍💻 Author & Social Media

<p align="center">
  <table>
    <tr>
      <td align="center">
        <a href="https://instagram.com/angga.official__">
          <img src="https://img.shields.io/badge/Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white" alt="Instagram"/>
          <br>Instagram
        </a>
      </td>
      <td align="center">
        <a href="https://youtube.com/@bacotamatpro03">
          <img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"/>
          <br>YouTube
        </a>
      </td>
      <td align="center">
        <a href="https://t.me/anggaofficial">
          <img src="https://img.shields.io/badge/Telegram-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram"/>
          <br>Telegram
        </a>
      </td>
    </tr>
  </table>
</p>

---

<p align="center">
  <b>⭐ Jangan lupa kasih bintang kalau berguna! ⭐</b>
</p>

<p align="center">
  Made with ❤️ by <b>Angga Official</b>
  <br>
  © 2026 Angga Official. All rights reserved.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Powered%20By-Angga%20Official-00F700?style=flat-square" />
</p>
````

---
