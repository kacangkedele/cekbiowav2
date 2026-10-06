import logging
import sqlite3
import asyncio
import aiohttp
import re
import csv
import os
from datetime import datetime, date, timedelta
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, InputFile
from telegram.ext import (
    Application, CommandHandler, MessageHandler, CallbackQueryHandler,
    filters, ContextTypes
)
import config

# ============ LOGGING ============
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO,
    handlers=[
        logging.FileHandler('bot.log', encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# ============ DATABASE ============
DB_PATH = 'cekbio.db'
conn = sqlite3.connect(DB_PATH, check_same_thread=False)
cursor = conn.cursor()

# Rate limit dict (in-memory untuk anti-spam)
USER_RATE_LIMIT = {}  # {user_id: [last_command_time, command_count]}

def init_db():
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            tier TEXT,
            usage INTEGER DEFAULT 0,
            last_reset TEXT,
            expire_date TEXT,
            referred_by INTEGER,
            join_date TEXT
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS stats (
            id INTEGER PRIMARY KEY,
            total_detections INTEGER DEFAULT 0,
            total_mass_checks INTEGER DEFAULT 0
        )
    ''')
    cursor.execute('INSERT OR IGNORE INTO stats (id, total_detections, total_mass_checks) VALUES (1, 4296, 0)')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS pending (
            user_id INTEGER PRIMARY KEY,
            tier TEXT,
            timestamp TEXT
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS cooldowns (
            phone TEXT PRIMARY KEY,
            status TEXT,
            last_check TEXT,
            cooldown_until TEXT
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT,
            detail TEXT,
            timestamp TEXT
        )
    ''')
    conn.commit()

init_db()

# ============ KONSTANTA ============
TIER_LIMITS = {"Free": 5, "VIP": 25, "XVIP": 50, "VVIP": 100}
TIER_PRICES = {"VIP": 3000, "XVIP": 7000, "VVIP": 10000}
COOLDOWN_DURATION = 300  # 5 menit dalam detik
RATE_LIMIT_WINDOW = 60  # 60 detik
RATE_LIMIT_MAX = 10  # max 10 command per menit

# ============ FUNGSI UTIL ============
def log_activity(user_id: int, action: str, detail: str = ""):
    """Log aktivitas user untuk audit."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute(
        "INSERT INTO activity_log (user_id, action, detail, timestamp) VALUES (?, ?, ?, ?)",
        (user_id, action, detail, now)
    )
    conn.commit()

def is_rate_limited(user_id: int) -> bool:
    """Cek apakah user terlalu banyak command dalam waktu singkat."""
    now = time.time()
    if user_id not in USER_RATE_LIMIT:
        USER_RATE_LIMIT[user_id] = [now, 1]
        return False
    last_time, count = USER_RATE_LIMIT[user_id]
    if now - last_time > RATE_LIMIT_WINDOW:
        USER_RATE_LIMIT[user_id] = [now, 1]
        return False
    if count >= RATE_LIMIT_MAX:
        return True
    USER_RATE_LIMIT[user_id][1] += 1
    return False

import time

def validate_phone(nomor: str) -> bool:
    """Validasi nomor internasional."""
    if not nomor.startswith('+'):
        return False
    phone = nomor[1:]
    return phone.isdigit() and 8 <= len(phone) <= 15

# ============ DATABASE USER ============
def get_user(user_id: int, username: str, referred_by=None):
    today = date.today().isoformat()
    cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
    user = cursor.fetchone()
    if not user:
        cursor.execute(
            "INSERT INTO users (user_id, username, tier, usage, last_reset, expire_date, referred_by, join_date) "
            "VALUES (?, ?, 'Free', 0, ?, NULL, ?, ?)",
            (user_id, username, today, referred_by, today)
        )
        conn.commit()
        cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
        user = cursor.fetchone()
    
    user_dict = {
        "user_id": user[0], "username": user[1], "tier": user[2],
        "usage": user[3], "last_reset": user[4], "expire_date": user[5],
        "referred_by": user[6], "join_date": user[7]
    }
    if user_dict["last_reset"] != today:
        cursor.execute("UPDATE users SET usage = 0, last_reset = ? WHERE user_id = ?", (today, user_id))
        conn.commit()
        user_dict["usage"] = 0
    if user_dict["tier"] != "Free" and user_dict["expire_date"]:
        try:
            expire_date = date.fromisoformat(user_dict["expire_date"])
            if date.today() > expire_date:
                cursor.execute("UPDATE users SET tier = 'Free', expire_date = NULL WHERE user_id = ?", (user_id,))
                conn.commit()
                user_dict["tier"] = "Free"
                user_dict["expire_date"] = None
        except ValueError:
            pass
    return user_dict

# ============ CEK BIO WA ============
async def cek_bio_wa(nomor: str):
    phone = nomor.lstrip('+')
    url = f"http://localhost:3000/cek?nomor={phone}"
    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as response:
                data = await response.json()
                return data.get("bio", "Bio tidak tersedia")
    except asyncio.TimeoutError:
        return "⚠️ Timeout: Server WA butuh waktu terlalu lama."
    except aiohttp.ClientConnectorError:
        return "⚠️ Server Sender (Node.js) offline. Hubungi admin."
    except Exception as e:
        logger.error(f"Error cek bio: {e}")
        return f"⚠️ Error: {str(e)}"

# ============ CEK MASSAL ============
async def mass_cek_wa(numbers: list):
    url = "http://localhost:3000/masscek"
    try:
        timeout = aiohttp.ClientTimeout(total=600)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json={"numbers": numbers}) as response:
                data = await response.json()
                if data.get("status"):
                    return data.get("stats", {})
                return None
    except Exception as e:
        logger.error(f"Error Mass API: {e}")
        return None

# ============ OTP COOLDOWN MONITOR ============
async def cek_cooldown_otp(nomor: str):
    """Cek status cooldown OTP untuk nomor tertentu."""
    phone = nomor.lstrip('+')
    url = f"http://localhost:3000/cek?nomor={phone}"
    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as response:
                data = await response.json()
                now = datetime.now().strftime("%H:%M:%S")
                
                # Simpan ke database cooldown
                status = "ready" if data.get("status") else "cooldown"
                cooldown_until = (datetime.now() + timedelta(seconds=COOLDOWN_DURATION)).isoformat()
                cursor.execute('''
                    INSERT OR REPLACE INTO cooldowns (phone, status, last_check, cooldown_until)
                    VALUES (?, ?, ?, ?)
                ''', (phone, status, now, cooldown_until))
                conn.commit()
                
                return {
                    "phone": phone,
                    "status": status,
                    "bio": data.get("bio", ""),
                    "time": now
                }
    except Exception as e:
        logger.error(f"Error cooldown cek: {e}")
        return None

async def cooldown_monitor(numbers: list):
    """Monitor cooldown untuk multiple nomor sekaligus."""
    results = []
    for nomor in numbers:
        result = await cek_cooldown_otp(nomor)
        if result:
            results.append(result)
        await asyncio.sleep(0.3)  # Hindari rate limit
    return results

# ============ COMMAND START ============
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    # Cek referral dari args
    referred_by = None
    if context.args and context.args[0].startswith('ref_'):
        try:
            referred_by = int(context.args[0][4:])
        except ValueError:
            referred_by = None
    
    if is_rate_limited(user.id):
        await update.message.reply_text("⚠️ Terlalu banyak command. Tunggu sebentar ya.")
        return
    
    user_data = get_user(user.id, user.username or "TidakAda", referred_by)
    now = datetime.now().strftime("%d-%m-%Y %H:%M:%S")
    limit = TIER_LIMITS.get(user_data["tier"], 5)
    sisa_limit = limit - user_data["usage"]
    
    cursor.execute("SELECT total_detections, total_mass_checks FROM stats WHERE id = 1")
    stats_row = cursor.fetchone()
    total_det = stats_row[0]
    total_mass = stats_row[1]
    cursor.execute("SELECT COUNT(*) FROM users")
    total_users = cursor.fetchone()[0]

    text = (
        f"🤖 *Bot By Angga Official* 🤖\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"📅 *Waktu:* {now}\n\n"
        f"👤 *INFO PENGGUNA*\n"
        f"├─ ID: `{user.id}`\n"
        f"├─ Username: @{user_data['username']}\n"
        f"├─ Tier: {user_data['tier']}\n"
        f"└─ Sisa Deteksi Hari ini: {sisa_limit} nomor\n\n"
        f"📊 *STATISTIK BOT*\n"
        f"├─ Total Users: {total_users}\n"
        f"├─ Total Deteksi: {total_det}x\n"
        f"└─ Total Mass Check: {total_mass}x\n\n"
        f"📌 *DAFTAR PERINTAH*\n"
        f"├─ /start - Menu utama\n"
        f"├─ /detek <nomor> - Cek 1 Bio WA\n"
        f"├─ /cooldown <nomor> - Cek OTP Cooldown\n"
        f"├─ /myaccount - Info akun\n"
        f"├─ /premium - Lihat paket premium\n"
        f"├─ /help - Bantuan lengkap\n"
        f"└─ Kirim file .txt - Cek Massal (admin)\n\n"
        f"📝 *CARA PENGGUNAAN CEKBIO*\n"
        f"Contoh: `/detek +628123456789`\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"_Deteksi nomor mata elang bersama Bot By Angga Official_"
    )

    keyboard = [
        [InlineKeyboardButton("💎 Lihat Paket Premium", callback_data="show_premium")],
        [InlineKeyboardButton("🆔 Akun Saya", callback_data="show_myaccount"),
         InlineKeyboardButton("❓ Bantuan", callback_data="show_help")],
        [InlineKeyboardButton("📢 Info Channel", url=config.CHANNEL_URL),
         InlineKeyboardButton("🐞 Laporkan Bug", url=f"https://t.me/{config.ADMIN_USERNAME}")]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.edit_message_text(text, parse_mode='Markdown', reply_markup=reply_markup)
    else:
        await update.message.reply_text(text, parse_mode='Markdown', reply_markup=reply_markup)
        log_activity(user.id, "start", "User membuka menu start")

# ============ COMMAND PREMIUM ============
async def premium(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    user_data = get_user(user.id, user.username or "TidakAda")
    
    text = (
        f"💎 *Paket Premium Bot By Angga Official* 💎\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"◇ Status kamu saat ini: *{user_data['tier']}* (maks {TIER_LIMITS[user_data['tier']]} nomor/sesi)\n\n"
        f"◇ *Paket VIP* ⭐\n├ /detek → maks 25 nomor\n└ Mulai Rp 3.000/hari\n\n"
        f"◇ *Paket XVIP* 🌟\n├ /detek → maks 50 nomor\n└ Mulai Rp 7.000/hari\n\n"
        f"◇ *Paket VVIP* 💎\n├ /detek → maks 100 nomor\n└ Mulai Rp 10.000/hari\n\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"_Klik tombol di bawah untuk melihat QRIS & melakukan pembayaran otomatis._"
    )
    
    keyboard = [
        [InlineKeyboardButton("💸 Beli VIP (3K/hari)", callback_data="buy_VIP")],
        [InlineKeyboardButton("💸 Beli XVIP (7K/hari)", callback_data="buy_XVIP")],
        [InlineKeyboardButton("💸 Beli VVIP (10K/hari)", callback_data="buy_VVIP")],
        [InlineKeyboardButton("⬅️ Kembali ke Menu", callback_data="back_to_start")]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.edit_message_text(text, parse_mode='Markdown', reply_markup=reply_markup)
    else:
        await update.message.reply_text(text, parse_mode='Markdown', reply_markup=reply_markup)

# ============ COMMAND DETEK ============
async def detek(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if is_rate_limited(user.id):
        await update.message.reply_text("⚠️ Terlalu banyak command. Tunggu sebentar ya.")
        return
    
    user_data = get_user(user.id, user.username or "TidakAda")
    limit = TIER_LIMITS.get(user_data["tier"], 5)
    if user_data["usage"] >= limit:
        await update.message.reply_text(
            "🚫 *LIMIT HARIAN HABIS!*\n\nGunakan /premium untuk meningkatkan limit.",
            parse_mode='Markdown'
        )
        return

    if not context.args:
        await update.message.reply_text(
            "❌ Format salah! Gunakan:\n`/detek +628123456789`",
            parse_mode='Markdown'
        )
        return

    nomor_asli = context.args[0]
    if not validate_phone(nomor_asli):
        await update.message.reply_text(
            "❌ Nomor harus format internasional!\nContoh: `+628123456789`\n"
            "• Diawali `+`\n• Panjang 8-15 digit\n• Hanya angka",
            parse_mode='Markdown'
        )
        return

    cursor.execute("UPDATE users SET usage = usage + 1 WHERE user_id = ?", (user.id,))
    cursor.execute("UPDATE stats SET total_detections = total_detections + 1 WHERE id = 1")
    conn.commit()
    sisa_limit = limit - (user_data["usage"] + 1)
    
    proses_msg = await update.message.reply_text(
        f"🔍 *Sedang mendeteksi Bio untuk nomor:* `{nomor_asli}`\n\n⏳ _Mohon tunggu..._",
        parse_mode='Markdown'
    )

    hasil_bio = await cek_bio_wa(nomor_asli)
    
    final_text = (
        f"✅ *Hasil Deteksi Bio WhatsApp*\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"📞 Nomor: `{nomor_asli}`\n"
        f"📝 Bio: {hasil_bio}\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"✅ Sisa deteksi hari ini: *{sisa_limit}* nomor\n"
        f"🕒 {datetime.now().strftime('%d-%m-%Y %H:%M:%S')}"
    )
    
    try:
        await proses_msg.edit_text(final_text, parse_mode='Markdown')
    except Exception:
        await proses_msg.edit_text(final_text)
    
    log_activity(user.id, "detek", f"Nomor: {nomor_asli}")

# ============ COMMAND COOLDOWN (OTP MONITOR) ============
async def cooldown(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Cek OTP cooldown untuk satu nomor."""
    user = update.effective_user
    if is_rate_limited(user.id):
        await update.message.reply_text("⚠️ Terlalu banyak command. Tunggu sebentar.")
        return
    
    user_data = get_user(user.id, user.username or "TidakAda")
    limit = TIER_LIMITS.get(user_data["tier"], 5)
    if user_data["usage"] >= limit:
        await update.message.reply_text("🚫 Limit harian habis! Gunakan /premium.", parse_mode='Markdown')
        return

    if not context.args:
        await update.message.reply_text(
            "❌ Format salah!\nGunakan: `/cooldown +628123456789`",
            parse_mode='Markdown'
        )
        return

    nomor_asli = context.args[0]
    if not validate_phone(nomor_asli):
        await update.message.reply_text(
            "❌ Nomor harus format internasional!\nContoh: `+628123456789`",
            parse_mode='Markdown'
        )
        return

    cursor.execute("UPDATE users SET usage = usage + 1 WHERE user_id = ?", (user.id,))
    cursor.execute("UPDATE stats SET total_detections = total_detections + 1 WHERE id = 1")
    conn.commit()
    sisa_limit = limit - (user_data["usage"] + 1)
    
    proses_msg = await update.message.reply_text(
        f"🔍 *OTP COOLDOWN MONITOR*\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"📞 Nomor: `{nomor_asli}`\n⏳ Mengecek status cooldown...\n",
        parse_mode='Markdown'
    )

    result = await cek_cooldown_otp(nomor_asli)
    
    if not result:
        await proses_msg.edit_text("❌ Gagal mengecek cooldown. Coba lagi nanti.")
        return
    
    if result["status"] == "ready":
        status_emoji = "✅"
        status_text = "Nomor siap OTP"
    else:
        status_emoji = "⏳"
        status_text = "Nomor sedang cooldown"
    
    final_text = (
        f"🔍 *OTP COOLDOWN MONITOR*\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"📞 Nomor: `{nomor_asli}`\n"
        f"{status_emoji} Status: *{status_text}*\n"
        f"🕒 Waktu Cek: {result['time']}\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"✅ Sisa deteksi hari ini: *{sisa_limit}* nomor\n"
        f"💡 Gunakan `/cooldownlist` untuk melihat semua nomor yang sudah di-cek"
    )
    
    try:
        await proses_msg.edit_text(final_text, parse_mode='Markdown')
    except Exception:
        await proses_msg.edit_text(final_text)
    
    log_activity(user.id, "cooldown", f"Nomor: {nomor_asli}")

# ============ COMMAND COOLDOWN LIST ============
async def cooldownlist(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Tampilkan list semua nomor yang sudah dicek cooldown."""
    user = update.effective_user
    cursor.execute("SELECT phone, status, last_check FROM cooldowns ORDER BY last_check DESC LIMIT 20")
    rows = cursor.fetchall()
    
    if not rows:
        await update.message.reply_text("📭 Belum ada nomor yang di-cek cooldown.", parse_mode='Markdown')
        return
    
    text = "📋 *DAFTAR COOLDOWN MONITOR* (20 terakhir)\n━━━━━━━━━━━━━━━━\n"
    for phone, status, last_check in rows:
        emoji = "✅" if status == "ready" else "⏳"
        text += f"{emoji} `+{phone}` - {last_check}\n"
    
    text += "\n━━━━━━━━━━━━━━━━\n"
    
    ready_count = sum(1 for r in rows if r[1] == "ready")
    cooldown_count = len(rows) - ready_count
    text += f"📊 *Total: {len(rows)}* nomor\n"
    text += f"✅ Siap OTP: *{ready_count}*\n"
    text += f"⏳ Cooldown: *{cooldown_count}*\n\n"
    
    if ready_count == len(rows):
        text += "🎉 *Semua nomor siap menerima OTP!*"
    else:
        text += "⚠️ Masih ada nomor dalam kondisi cooldown."
    
    await update.message.reply_text(text, parse_mode='Markdown')

# ============ COMMAND HELP ============
async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = (
        "❓ *BANTUAN - Bot By Angga Official*\n"
        "━━━━━━━━━━━━━━━━\n\n"
        "📋 *DAFTAR PERINTAH USER:*\n"
        "• `/start` - Menu utama & info akun\n"
        "• `/detek <nomor>` - Cek 1 Bio WA\n"
        "   Contoh: `/detek +628123456789`\n"
        "• `/cooldown <nomor>` - Cek OTP Cooldown\n"
        "• `/cooldownlist` - List semua cooldown\n"
        "• `/myaccount` - Detail akun & sisa limit\n"
        "• `/premium` - Lihat & beli paket premium\n"
        "• `/help` - Tampilkan pesan ini\n\n"
        "📤 *CEK MASSAL:*\n"
        "Kirim file `.txt` berisi daftar nomor (1 nomor per baris)\n\n"
        "💎 *TIER & LIMIT:*\n"
        f"• Free: {TIER_LIMITS['Free']} nomor/hari\n"
        f"• VIP: {TIER_LIMITS['VIP']} nomor/hari (Rp 3K/hari)\n"
        f"• XVIP: {TIER_LIMITS['XVIP']} nomor/hari (Rp 7K/hari)\n"
        f"• VVIP: {TIER_LIMITS['VVIP']} nomor/hari (Rp 10K/hari)\n\n"
        "⚠️ *CATATAN:*\n"
        "• Nomor harus format internasional (`+62xxx`)\n"
        "• Limit reset setiap hari 00:00 WIB\n"
        "• Premium berlaku otomatis expired sesuai durasi\n\n"
        "━━━━━━━━━━━━━━━━\n"
        f"🐞 Bug? Hubungi: @{config.ADMIN_USERNAME}\n"
        f"📢 Channel: {config.CHANNEL_URL}"
    )
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.edit_message_text(
            text, parse_mode='Markdown',
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("⬅️ Kembali", callback_data="back_to_start")]])
        )
    else:
        await update.message.reply_text(text, parse_mode='Markdown')

# ============ COMMAND MY ACCOUNT ============
async def myaccount(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    user_data = get_user(user.id, user.username or "TidakAda")
    limit = TIER_LIMITS.get(user_data["tier"], 5)
    sisa = limit - user_data["usage"]
    
    text = (
        "🆔 *INFO AKUN SAYA*\n"
        "━━━━━━━━━━━━━━━━\n"
        f"👤 User: @{user_data['username']}\n"
        f"🆔 ID: `{user_data['user_id']}`\n"
        f"💎 Tier: *{user_data['tier']}*\n"
        f"📊 Limit: {user_data['usage']}/{limit} (sisa *{sisa}*)\n"
        f"📅 Join: {user_data['join_date']}\n"
    )
    if user_data["expire_date"]:
        text += f"⏳ Expire: {user_data['expire_date']}\n"
    else:
        text += "⏳ Expire: - (Free)\n"
    
    if user_data["referred_by"]:
        text += f"👥 Referred by: `{user_data['referred_by']}`\n"
    
    text += "\n━━━━━━━━━━━━━━━━\n"
    text += f"💡 Link referral Anda:\n`https://t.me/{config.BOT_USERNAME}?start=ref_{user.id}`"
    
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.edit_message_text(
            text, parse_mode='Markdown',
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("⬅️ Kembali", callback_data="back_to_start")]])
        )
    else:
        await update.message.reply_text(text, parse_mode='Markdown')

# ============ HANDLER FILE MASSAL ============
async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_user.id != config.ADMIN_ID:
        await update.message.reply_text("❌ Maaf, fitur cek massal hanya tersedia untuk Admin.")
        return

    doc = update.message.document
    if not doc or not doc.file_name.endswith('.txt'):
        await update.message.reply_text("❌ File harus berformat `.txt` berisi daftar nomor!", parse_mode='Markdown')
        return

    proses_msg = await update.message.reply_text("📂 Menerima file, sedang membaca daftar nomor...")
    
    try:
        file = await doc.get_file()
        file_bytes = await file.download_as_bytearray()
        text = file_bytes.decode('utf-8', errors='ignore')
    except Exception as e:
        await proses_msg.edit_text(f"❌ Gagal membaca file: {e}")
        return
    
    numbers = []
    for line in text.split('\n'):
        clean_num = line.strip().replace('+', '').replace('-', '').replace(' ', '').replace('\t', '')
        if clean_num.isdigit() and 8 <= len(clean_num) <= 15:
            numbers.append(clean_num)
            
    if len(numbers) == 0:
        await proses_msg.edit_text("❌ Tidak ada nomor valid di dalam file!")
        return

    await proses_msg.edit_text(
        f"📊 Ditemukan *{len(numbers)} nomor*.\n\n⏳ Mulai mengecek massal...\n_(estimasi: {len(numbers)*0.3:.0f} detik)_",
        parse_mode='Markdown'
    )
    
    stats = await mass_cek_wa(numbers)
    cursor.execute("UPDATE stats SET total_mass_checks = total_mass_checks + 1 WHERE id = 1")
    conn.commit()
    
    if not stats:
        await proses_msg.edit_text("❌ Gagal cek massal. Pastikan sender.js aktif!")
        return

    total = stats.get("total", 0)
    reg = stats.get("registered", 0)
    not_reg = stats.get("notRegistered", 0)
    has_bio = stats.get("hasBio", 0)
    no_bio = stats.get("noBio", 0)
    business = stats.get("business", 0)
    
    reg_percent = (reg / total * 100) if total > 0 else 0
    not_reg_percent = (not_reg / total * 100) if total > 0 else 0
    
    result_text = (
        f"📊 *HASIL CEK MASSAL*\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"📁 Total File: {total} nomor\n\n"
        f"📈 *STATISTIK:*\n"
        f"  ✅ Terdaftar WA: {reg} ({reg_percent:.1f}%)\n"
        f"  🚫 Tidak Terdaftar: {not_reg} ({not_reg_percent:.1f}%)\n\n"
        f"  ── dari {reg} terdaftar ──\n"
        f"  📝 Memiliki Bio: {has_bio}\n"
        f"  🚫 Tanpa Bio: {no_bio}\n"
        f"  🏢 Business Meta: {business}\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"🕒 {datetime.now().strftime('%d-%m-%Y %H:%M:%S')}"
    )
    
    # Simpan CSV
    csv_filename = f"result_masscheck_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    try:
        with open(csv_filename, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(['Nomor', 'Status', 'Bio'])
            for num in numbers:
                writer.writerow([num, 'Checked', ''])
        
        with open(csv_filename, 'rb') as f:
            await update.message.reply_document(
                document=InputFile(f, filename=csv_filename),
                caption=result_text,
                parse_mode='Markdown'
            )
        os.remove(csv_filename)
    except Exception as e:
        logger.error(f"CSV export error: {e}")
        await proses_msg.edit_text(result_text, parse_mode='Markdown')

# ============ HANDLER PHOTO (BUKTI BAYAR) ============
async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    cursor.execute("SELECT tier FROM pending WHERE user_id = ?", (user.id,))
    pending = cursor.fetchone()
    
    if not pending:
        await update.message.reply_text(
            "❌ Anda tidak ada transaksi tertunda.\nSilakan pilih paket di /premium.",
            parse_mode='Markdown'
        )
        return

    tier = pending[0]
    price = TIER_PRICES[tier]
    photo_file = await update.message.photo[-1].get_file()
    
    caption = (
        f"🛒 *PEMBAYARAN BARU MASUK* 🛒\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"👤 User: @{user.username or 'TidakAda'}\n"
        f"🆔 ID: `{user.id}`\n"
        f"💎 Paket: *{tier}*\n"
        f"💰 Jumlah: Rp {price}\n"
        f"🕒 Waktu: {datetime.now().strftime('%d-%m-%Y %H:%M:%S')}\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"Jika uang sudah masuk, ketik:\n"
        f"`/upgrade {user.id} {tier} 1`"
    )
    
    await context.bot.send_photo(chat_id=config.ADMIN_ID, photo=photo_file.file_id, caption=caption, parse_mode='Markdown')
    cursor.execute("DELETE FROM pending WHERE user_id = ?", (user.id,))
    conn.commit()
    
    await update.message.reply_text(
        "✅ *Bukti pembayaran berhasil dikirim ke Admin!*\nMohon tunggu verifikasi (max 1x24 jam).",
        parse_mode='Markdown'
    )
    log_activity(user.id, "payment", f"Tier: {tier}, Rp {price}")

# ============ COMMAND UPGRADE (ADMIN) ============
async def upgrade_user(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_user.id != config.ADMIN_ID:
        return
    try:
        target_user_id = int(context.args[0])
        target_tier = context.args[1].upper()
        days = int(context.args[2])
        if target_tier not in TIER_LIMITS:
            await update.message.reply_text("❌ Tier tidak valid. Pilih: VIP, XVIP, atau VVIP", parse_mode='Markdown')
            return
        user = get_user(target_user_id, "Unknown")
        current_expire_str = user.get("expire_date")
        base_date = date.today()
        if current_expire_str:
            try:
                current_expire = date.fromisoformat(current_expire_str)
                if current_expire > base_date:
                    base_date = current_expire
            except ValueError:
                pass
        new_expire = base_date + timedelta(days=days)
        cursor.execute(
            "UPDATE users SET tier = ?, expire_date = ? WHERE user_id = ?",
            (target_tier, new_expire.isoformat(), target_user_id)
        )
        conn.commit()
        await update.message.reply_text(
            f"✅ Berhasil! User `{target_user_id}` di-upgrade ke *{target_tier}* selama {days} hari.",
            parse_mode='Markdown'
        )
        await context.bot.send_message(
            chat_id=target_user_id,
            text=f"🎉 *PEMBAYARAN DITERIMA* 🎉\n\nAkun Anda di-upgrade ke *{target_tier}*.\nDurasi: {days} hari.\nExpire: {new_expire.isoformat()}",
            parse_mode='Markdown'
        )
        log_activity(update.effective_user.id, "upgrade", f"Target: {target_user_id}, Tier: {target_tier}, {days} hari")
    except (IndexError, ValueError):
        await update.message.reply_text(
            "❌ Format salah! Gunakan:\n`/upgrade <user_id> <tier> <hari>`",
            parse_mode='Markdown'
        )

# ============ COMMAND RESET LIMIT (ADMIN) ============
async def resetlimit(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_user.id != config.ADMIN_ID:
        return
    try:
        if context.args and context.args[0] == 'all':
            cursor.execute("UPDATE users SET usage = 0, last_reset = ?", (date.today().isoformat(),))
            conn.commit()
            await update.message.reply_text("✅ Limit semua user berhasil di-reset!", parse_mode='Markdown')
            log_activity(update.effective_user.id, "resetlimit_all", "Reset semua user")
        else:
            target_id = int(context.args[0])
            cursor.execute("UPDATE users SET usage = 0 WHERE user_id = ?", (target_id,))
            conn.commit()
            await update.message.reply_text(f"✅ Limit user `{target_id}` di-reset!", parse_mode='Markdown')
            log_activity(update.effective_user.id, "resetlimit", f"Target: {target_id}")
    except (IndexError, ValueError):
        await update.message.reply_text(
            "❌ Format salah!\n`/resetlimit <user_id>` atau `/resetlimit all`",
            parse_mode='Markdown'
        )

# ============ COMMAND BROADCAST (ADMIN) ============
async def broadcast(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_user.id != config.ADMIN_ID:
        return
    if not context.args:
        await update.message.reply_text("❌ Format salah!\n`/broadcast <pesan>`", parse_mode='Markdown')
        return
    
    msg = ' '.join(context.args)
    cursor.execute("SELECT user_id FROM users")
    users = cursor.fetchall()
    
    sent = 0
    failed = 0
    progress_msg = await update.message.reply_text(f"📢 Mengirim broadcast ke {len(users)} user...")
    
    for (uid,) in users:
        try:
            await context.bot.send_message(chat_id=uid, text=f"📢 *PENGUMUMAN ADMIN*\n\n{msg}", parse_mode='Markdown')
            sent += 1
            await asyncio.sleep(0.05)
        except Exception as e:
            logger.error(f"Broadcast fail {uid}: {e}")
            failed += 1
    
    await progress_msg.edit_text(
        f"✅ Broadcast selesai!\n📊 Terkirim: {sent}\n❌ Gagal: {failed}",
        parse_mode='Markdown'
    )
    log_activity(update.effective_user.id, "broadcast", f"Sent: {sent}, Failed: {failed}")

# ============ COMMAND LISTUSER (ADMIN) ============
async def listuser(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_user.id != config.ADMIN_ID:
        return
    cursor.execute("SELECT user_id, username, tier, usage, expire_date FROM users ORDER BY user_id DESC LIMIT 50")
    users = cursor.fetchall()
    
    if not users:
        await update.message.reply_text("📭 Belum ada user terdaftar.")
        return
    
    text = f"📋 *DAFTAR USER (50 terakhir)*\n━━━━━━━━━━━━━━━━\n\n"
    for uid, uname, tier, usage, expire in users:
        text += f"• `{uid}` @{uname or 'NA'} | {tier} ({usage}) | {expire or '-'}\n"
    
    text += f"\n━━━━━━━━━━━━━━━━\nTotal: *{len(users)}* user"
    
    # Send as file jika terlalu panjang
    if len(text) > 4000:
        csv_name = f"listuser_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        with open(csv_name, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(['User ID', 'Username', 'Tier', 'Usage', 'Expire'])
            for row in users:
                writer.writerow(row)
        with open(csv_name, 'rb') as f:
            await update.message.reply_document(
                document=InputFile(f, filename=csv_name),
                caption=f"📋 Total: {len(users)} user (limit 50 terbaru)"
            )
        os.remove(csv_name)
    else:
        await update.message.reply_text(text, parse_mode='Markdown')

# ============ CALLBACK BUTTON ============
async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    data = query.data
    user = query.from_user
    
    try:
        if data == "show_premium":
            await premium(update, context)
        elif data == "show_help":
            await help_command(update, context)
        elif data == "show_myaccount":
            await myaccount(update, context)
        elif data == "back_to_start":
            await start(update, context)
        elif data.startswith("buy_"):
            tier_name = data.split("_")[1]
            price = TIER_PRICES[tier_name]
            cursor.execute("INSERT OR REPLACE INTO pending (user_id, tier, timestamp) VALUES (?, ?, ?)", 
                          (user.id, tier_name, datetime.now().isoformat()))
            conn.commit()
            text = (
                f"🛒 *PEMBAYARAN TIER {tier_name}* 🛒\n"
                f"━━━━━━━━━━━━━━━━\n"
                f"Silakan scan QRIS & bayar:\n"
                f"💵 *Rp {price}*\n\n"
                f"📸 *Kirim foto bukti pembayaran KE CHAT INI.*"
            )
            keyboard = [[InlineKeyboardButton("❌ Batalkan", callback_data="cancel_payment")]]
            await query.answer()
            await query.message.delete()
            await context.bot.send_photo(
                chat_id=user.id,
                photo=config.QRIS_IMAGE_URL,
                caption=text,
                parse_mode='Markdown',
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
        elif data == "cancel_payment":
            cursor.execute("DELETE FROM pending WHERE user_id = ?", (user.id,))
            conn.commit()
            await query.answer("Transaksi dibatalkan.")
            await start(update, context)
    except Exception as e:
        logger.error(f"Callback error: {e}")
        await query.answer("⚠️ Terjadi error. Coba lagi.")

# ============ ERROR HANDLER ============
async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.error(f"Exception: {context.error}", exc_info=context.error)
    if update and hasattr(update, 'effective_chat'):
        try:
            await context.bot.send_message(
                chat_id=update.effective_chat.id,
                text="⚠️ Terjadi error internal. Tim sudah diberi notifikasi."
            )
        except Exception:
            pass

# ============ DAILY CLEANUP JOB ============
async def daily_cleanup(context: ContextTypes.DEFAULT_TYPE):
    """Job harian untuk cleanup cooldown expired & user expired."""
    now = datetime.now().isoformat()
    cursor.execute("DELETE FROM cooldowns WHERE cooldown_until < ?", (now,))
    cursor.execute("UPDATE users SET tier='Free', expire_date=NULL WHERE tier!='Free' AND expire_date < ?", 
                   (date.today().isoformat(),))
    conn.commit()
    logger.info("Daily cleanup executed.")

# ============ MAIN ============
def main() -> None:
    app = Application.builder().token(config.BOT_TOKEN).build()
    
    # Command handlers
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("premium", premium))
    app.add_handler(CommandHandler("detek", detek))
    app.add_handler(CommandHandler("cooldown", cooldown))
    app.add_handler(CommandHandler("cooldownlist", cooldownlist))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("myaccount", myaccount))
    app.add_handler(CommandHandler("upgrade", upgrade_user))
    app.add_handler(CommandHandler("resetlimit", resetlimit))
    app.add_handler(CommandHandler("broadcast", broadcast))
    app.add_handler(CommandHandler("listuser", listuser))
    
    # Message handlers
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    app.add_handler(MessageHandler(filters.Document.TEXT, handle_document))
    
    # Callback
    app.add_handler(CallbackQueryHandler(button_callback))
    
    # Error
    app.add_error_handler(error_handler)
    
    # Job queue untuk cleanup harian
    job_queue = app.job_queue
    if job_queue:
        job_queue.run_daily(daily_cleanup, time=datetime.strptime("00:30", "%H:%M").time())
    
    print("🤖 Bot By Angga Official (Full Featured) sedang berjalan...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == '__main__':
    main()
