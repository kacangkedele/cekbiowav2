# ==========================================
# CONFIG.PY - Bot Cek Bio WA By Angga Official
# ==========================================
# JANGAN SHARE FILE INI KE SIAPAPUN!
# JANGAN COMMIT KE GITHUB (tambahkan ke .gitignore)
# ==========================================

# === TOKEN BOT TELEGRAM ===
# Dapatkan dari @BotFather di Telegram (t.me/BotFather)
# Command: /newbot → ikuti instruksi
BOT_TOKEN = "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

# === USERNAME BOT (tanpa @) ===
# Contoh: jika bot username @CekBioAngga_bot, isi "CekBioAngga_bot"
BOT_USERNAME = "CekBioAnggaBot"

# === INFO ADMIN ===
# ID Telegram kamu (numeric). Dapatkan dari @userinfobot
ADMIN_ID = 123456789

# Username Telegram kamu (tanpa @)
ADMIN_USERNAME = "AnggaOfficial"

# === CHANNEL & GRUP ===
# URL channel info/gabut kamu (untuk tombol di menu)
CHANNEL_URL = "https://t.me/AnggaOfficialChannel"

# === QRIS PEMBAYARAN ===
# Upload gambar QRIS ke imgur/ibb, copy direct link
QRIS_IMAGE_URL = "https://i.ibb.co/abc12345/qris-angga.jpg"

# === API SERVER (Node.js sender.js) ===
# Default: http://localhost:3000 (port dari sender/config.json)
API_BASE_URL = "http://localhost:3000"

# === TIER CONFIG (opsional, sudah ada default di bot.py) ===
TIER_LIMITS = {
    "Free": 5,
    "VIP": 25,
    "XVIP": 50,
    "VVIP": 100
}

TIER_PRICES = {
    "VIP": 3000,
    "XVIP": 7000,
    "VVIP": 10000
}

# === DATABASE ===
DB_PATH = "cekbio.db"

# === LOGGING ===
LOG_FILE = "bot.log"
LOG_LEVEL = "INFO"  # DEBUG | INFO | WARNING | ERROR

# === RATE LIMITING ===
RATE_LIMIT_WINDOW = 10        # detik
RATE_LIMIT_MAX = 10           # max command per window

# === OTP COOLDOWN ===
COOLDOWN_DURATION = 300        # 5 menit (detik)

# === AUTO BACKUP DATABASE ===
# Backup otomatis setiap X jam (0 = disabled)
BACKUP_INTERVAL_HOURS = 6
BACKUP_DIR = "backups"

# ==========================================
# AKHIR DARI CONFIG - JANGAN EDIT BAWAH INI
# ==========================================
