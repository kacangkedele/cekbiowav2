const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason,
    makeInMemoryStore
} = require('@whiskeysockets/baileys');
const express = require('express');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config.json');

// ============ LOGGING SETUP ============
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

const logger = P({ 
    level: 'info',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'yyyy-mm-dd HH:MM:ss',
            destination: path.join(LOG_DIR, `sender_${new Date().toISOString().split('T')[0]}.log`),
            mkdir: true
        }
    }
});

// ============ GLOBAL STATE ============
let sock = null;
let connectionState = 'disconnected'; // disconnected | connecting | connected
let lastConnectionTime = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// ============ GLOBAL METRICS ============
const metrics = {
    totalRequests: 0,
    totalSingleChecks: 0,
    totalMassChecks: 0,
    totalCooldownChecks: 0,
    totalSuccess: 0,
    totalErrors: 0,
    startTime: Date.now(),
    lastError: null,
    lastErrorTime: null
};

// ============ CACHE SYSTEM ============
class TTLCache {
    constructor(ttlMs = 5 * 60 * 1000) {
        this.cache = new Map();
        this.ttl = ttlMs;
    }
    
    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return null;
        }
        return item.value;
    }
    
    set(key, value) {
        this.cache.set(key, {
            value,
            expiry: Date.now() + this.ttl
        });
    }
    
    clear() {
        this.cache.clear();
    }
    
    size() {
        return this.cache.size;
    }
}

const bioCache = new TTLCache(5 * 60 * 1000);
const cooldownCache = new TTLCache(10 * 60 * 1000); // 10 menit untuk cooldown

// ============ RATE LIMITER ============
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { status: false, error: 'Too many requests, try again later.' }
});

const massLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { status: false, error: 'Too many mass check requests.' }
});

// ============ HELPER: VALIDASI NOMOR ============
function sanitizeNumber(nomor) {
    if (!nomor || typeof nomor !== 'string') return null;
    const cleaned = nomor.replace(/\D/g, '');
    if (cleaned.length < 8 || cleaned.length > 15) return null;
    return cleaned;
}

function toJid(nomor) {
    const clean = sanitizeNumber(nomor);
    if (!clean) return null;
    return clean + '@s.whatsapp.net';
}

// ============ HELPER: DELAY ============
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============ HELPER: RETRY LOGIC ============
async function withRetry(fn, maxRetries = 2, delayMs = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                await delay(delayMs * attempt);
            }
        }
    }
    throw lastError;
}

// ============ STORE (untuk message handling) ============
const store = makeInMemoryStore({ logger: P().child({ level: 'silent' }) });

// ============ WHATSAPP CONNECTION ============
async function startWhatsApp() {
    if (connectionState === 'connecting' || connectionState === 'connected') {
        logger.warn('⚠️  WhatsApp sudah terhubung atau sedang menghubungkan.');
        return;
    }
    
    connectionState = 'connecting';
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`🟢 Menggunakan Baileys versi: ${version} | Terbaru: ${isLatest}`);
    
    sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: 'warn' }),
        printQRInTerminal: false,
        browser: ['Bot-Angga', 'Chrome', '1.0.0'],
        defaultQueryTimeoutMs: 30000,
        getMessage: async (key) => {
            return store.loadMessage(key.remoteJid, key.id) || { conversation: '' };
        }
    });

    store.bind(sock.ev);
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            logger.info('📱 QR Code diterima. Scan dengan WhatsApp.');
        }
        
        if (connection === 'open') {
            connectionState = 'connected';
            lastConnectionTime = new Date();
            reconnectAttempts = 0;
            logger.info('✅ WhatsApp Sender Berhasil Terhubung!');
            logger.info(`👤 Logged in as: ${sock.user?.id || 'unknown'}`);
        } else if (connection === 'close') {
            connectionState = 'disconnected';
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            logger.error(`❌ Koneksi WA terputus. Status Code: ${statusCode || 'Tidak diketahui'}`);
            
            if (statusCode !== 410 && statusCode !== 401) {
                reconnectAttempts++;
                if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
                    logger.error(`🚫 Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) tercapai. Manual restart diperlukan.`);
                    return;
                }
                const delayMs = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);
                logger.warn(`⏳ Mencoba reconnect dalam ${delayMs / 1000} detik... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
                setTimeout(() => startWhatsApp(), delayMs);
            } else {
                logger.error('🚫 Akun keluar/blockir. Hapus folder auth_info_baileys dan coba lagi.');
            }
        }
    });

    // Pairing code jika belum registered
    if (!state.creds.registered && config.WA_NUMBER) {
        const phoneNumber = config.WA_NUMBER.replace(/\D/g, '');
        await delay(3000);
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            logger.info('\n========================================');
            logger.info(`🔑 KODE PAIRING ANDA: ${code}`);
            logger.info('========================================');
        } catch (err) {
            logger.error('❌ Gagal meminta kode pairing.', err);
        }
    }
}

// ============ EXPRESS APP ============
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - metrics.startTime) / 1000),
        whatsapp: connectionState,
        lastConnection: lastConnectionTime,
        timestamp: new Date().toISOString(),
        cacheSize: bioCache.size()
    });
});

// ============ WHATSAPP STATUS ============
app.get('/status', (req, res) => {
    res.json({
        connected: connectionState === 'connected',
        state: connectionState,
        user: sock?.user?.id || null,
        lastConnection: lastConnectionTime,
        reconnectAttempts
    });
});

// ============ METRICS ============
app.get('/metrics', (req, res) => {
    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    res.json({
        ...metrics,
        uptimeSeconds: uptime,
        uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`,
        cacheSize: bioCache.size()
    });
});

// ============ CEK 1 NOMOR (BIO) ============
app.get('/cek', apiLimiter, async (req, res) => {
    const nomor = req.query.nomor;
    metrics.totalRequests++;
    metrics.totalSingleChecks++;
    
    if (!nomor) {
        return res.status(400).json({ status: false, bio: "Nomor tidak ada" });
    }
    
    const jid = toJid(nomor);
    if (!jid) {
        return res.status(400).json({ status: false, bio: "Format nomor tidak valid" });
    }
    
    try {
        if (!sock || !sock.user || connectionState !== 'connected') {
            return res.status(503).json({ status: false, bio: "Sender WA offline!" });
        }
        
        // Cek cache dulu
        const cached = bioCache.get(`bio_${jid}`);
        if (cached) {
            logger.info(`📦 Cache hit untuk ${jid}`);
            return res.json({ status: true, bio: cached.bio, exists: cached.exists, cached: true });
        }
        
        const result = await withRetry(async () => {
            const [exists] = await sock.onWhatsApp(jid);
            if (!exists || !exists.exists) {
                return { exists: false, bio: null };
            }
            const status = await sock.fetchStatus(jid);
            return { 
                exists: true, 
                bio: status?.status || "Bio tidak tersedia" 
            };
        });
        
        metrics.totalSuccess++;
        
        // Simpan ke cache
        bioCache.set(`bio_${jid}`, result);
        
        res.json({ 
            status: true, 
            bio: result.bio || "Bio tidak tersedia",
            exists: result.exists
        });
    } catch (err) {
        metrics.totalErrors++;
        metrics.lastError = err.message;
        metrics.lastErrorTime = new Date().toISOString();
        logger.error(`❌ Error cek ${nomor}:`, err.message);
        res.json({ status: false, bio: "Nomor tidak terdaftar di WA / Private" });
    }
});

// ============ CEK DETAIL LENGKAP ============
app.get('/detail', apiLimiter, async (req, res) => {
    const nomor = req.query.nomor;
    metrics.totalRequests++;
    
    if (!nomor) {
        return res.status(400).json({ status: false, error: "Nomor tidak ada" });
    }
    
    const jid = toJid(nomor);
    if (!jid) {
        return res.status(400).json({ status: false, error: "Format nomor tidak valid" });
    }
    
    try {
        if (!sock || !sock.user || connectionState !== 'connected') {
            return res.status(503).json({ status: false, error: "Sender WA offline!" });
        }
        
        const result = await withRetry(async () => {
            const [exists] = await sock.onWhatsApp(jid);
            if (!exists || !exists.exists) {
                return { exists: false };
            }
            
            const detail = {
                exists: true,
                jid: jid,
                bio: null,
                business: null,
                name: null,
                isBusiness: false
            };
            
            try {
                const status = await sock.fetchStatus(jid);
                detail.bio = status?.status || null;
            } catch (e) {}
            
            try {
                const biz = await sock.getBusinessProfile(jid);
                if (biz) {
                    detail.isBusiness = true;
                    detail.business = {
                        name: biz.name || null,
                        description: biz.description || null,
                        email: biz.email || null,
                        website: biz.website || null,
                        category: biz.categories?.[0]?.name || null,
                        address: biz.address || null
                    };
                }
            } catch (e) {}
            
            try {
                const profile = await sock.profilePictureUrl(jid, 'preview').catch(() => null);
                detail.hasPhoto = !!profile;
                detail.photo = profile;
            } catch (e) { detail.hasPhoto = false; }
            
            return detail;
        });
        
        metrics.totalSuccess++;
        res.json({ status: true, data: result });
    } catch (err) {
        metrics.totalErrors++;
        metrics.lastError = err.message;
        metrics.lastErrorTime = new Date().toISOString();
        logger.error(`❌ Error detail ${nomor}:`, err.message);
        res.json({ status: false, error: err.message });
    }
});

// ============ CEK COOLDOWN OTP ============
app.get('/cooldown', apiLimiter, async (req, res) => {
    const nomor = req.query.nomor;
    metrics.totalRequests++;
    metrics.totalCooldownChecks++;
    
    if (!nomor) {
        return res.status(400).json({ status: false, error: "Nomor tidak ada" });
    }
    
    const jid = toJid(nomor);
    if (!jid) {
        return res.status(400).json({ status: false, error: "Format nomor tidak valid" });
    }
    
    try {
        if (!sock || !sock.user || connectionState !== 'connected') {
            return res.status(503).json({ status: false, error: "Sender WA offline!" });
        }
        
        // Cek cooldown cache (status 10 menit TTL)
        const cachedCooldown = cooldownCache.get(`cooldown_${jid}`);
        const now = Date.now();
        const cooldownDuration = 5 * 60 * 1000; // 5 menit
        
        let status, isOnCooldown, cooldownEnds;
        
        if (cachedCooldown && (now - cachedCooldown.lastCheck < 60000)) {
            // Cache masih fresh (< 1 menit)
            status = cachedCooldown.status;
            isOnCooldown = cachedCooldown.isOnCooldown;
            cooldownEnds = cachedCooldown.cooldownEnds;
        } else {
            // Cek apakah nomor terdaftar
            const [exists] = await sock.onWhatsApp(jid);
            
            if (!exists || !exists.exists) {
                return res.json({ 
                    status: false, 
                    error: "Nomor tidak terdaftar di WA",
                    phone: sanitizeNumber(nomor),
                    timestamp: new Date().toISOString()
                });
            }
            
            // Logika cooldown sederhana: 
            // Jika baru saja dicek (< 5 menit) → cooldown
            // Jika sudah lama tidak dicek → ready
            if (cachedCooldown) {
                const timeSinceLastCheck = now - cachedCooldown.lastCheck;
                if (timeSinceLastCheck < cooldownDuration) {
                    status = "cooldown";
                    isOnCooldown = true;
                    cooldownEnds = cachedCooldown.lastCheck + cooldownDuration;
                } else {
                    status = "ready";
                    isOnCooldown = false;
                    cooldownEnds = null;
                }
            } else {
                status = "ready";
                isOnCooldown = false;
                cooldownEnds = null;
            }
            
            // Simpan ke cache
            cooldownCache.set(`cooldown_${jid}`, {
                status,
                isOnCooldown,
                cooldownEnds,
                lastCheck: now
            });
        }
        
        metrics.totalSuccess++;
        
        res.json({
            status: true,
            phone: sanitizeNumber(nomor),
            exists: true,
            status_text: status,
            isOnCooldown: isOnCooldown,
            cooldownEnds: cooldownEnds ? new Date(cooldownEnds).toISOString() : null,
            timestamp: new Date().toISOString(),
            message: isOnCooldown ? "Nomor sedang cooldown" : "Nomor siap OTP"
        });
    } catch (err) {
        metrics.totalErrors++;
        metrics.lastError = err.message;
        metrics.lastErrorTime = new Date().toISOString();
        logger.error(`❌ Error cooldown ${nomor}:`, err.message);
        res.json({ 
            status: false, 
            error: err.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ============ CEK MASSAL ============
app.post('/masscek', massLimiter, async (req, res) => {
    const numbers = req.body?.numbers;
    metrics.totalRequests++;
    metrics.totalMassChecks++;
    
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ status: false, error: "Format salah: numbers harus array" });
    }
    
    if (numbers.length > 1000) {
        return res.status(400).json({ 
            status: false, 
            error: "Maksimal 1000 nomor per request" 
        });
    }
    
    if (!sock || !sock.user || connectionState !== 'connected') {
        return res.status(503).json({ status: false, error: "Sender WA offline!" });
    }
    
    const stats = {
        total: numbers.length,
        registered: 0,
        notRegistered: 0,
        hasBio: 0,
        noBio: 0,
        business: 0,
        errors: 0,
        byYear: {}
    };
    
    const results = [];
    logger.info(`📥 Menerima request massal cek ${numbers.length} nomor...`);
    const startTime = Date.now();
    
    for (let i = 0; i < numbers.length; i++) {
        const num = numbers[i];
        const jid = toJid(num);
        
        if (!jid) {
            stats.notRegistered++;
            stats.errors++;
            results.push({
                number: num,
                exists: false,
                error: "Format nomor tidak valid"
            });
            continue;
        }
        
        try {
            const [result] = await sock.onWhatsApp(jid);
            
            if (result && result.exists) {
                stats.registered++;
                const numResult = {
                    number: num,
                    exists: true,
                    jid: jid,
                    bio: null,
                    isBusiness: false,
                    business: null
                };
                
                // Cek Bio
                try {
                    const status = await sock.fetchStatus(jid);
                    if (status?.status && status.status.trim() !== "") {
                        stats.hasBio++;
                        numResult.bio = status.status;
                    } else {
                        stats.noBio++;
                    }
                } catch (e) {
                    stats.noBio++;
                }
                
                // Cek Business
                try {
                    const biz = await sock.getBusinessProfile(jid);
                    if (biz) {
                        stats.business++;
                        numResult.isBusiness = true;
                        numResult.business = {
                            name: biz.name || null,
                            description: biz.description || null
                        };
                    }
                } catch (e) {}
                
                results.push(numResult);
            } else {
                stats.notRegistered++;
                results.push({
                    number: num,
                    exists: false
                });
            }
        } catch (err) {
            stats.notRegistered++;
            stats.errors++;
            results.push({
                number: num,
                exists: false,
                error: err.message
            });
            logger.error(`❌ Error cek ${num}: ${err.message}`);
        }
        
        // Progress logging setiap 50 nomor
        if ((i + 1) % 50 === 0) {
            logger.info(`📊 Progress: ${i + 1}/${numbers.length} (${Math.floor((i + 1) / numbers.length * 100)}%)`);
        }
        
        await delay(300); // Jeda 300ms agar tidak banned
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info(`✅ Selesai cek massal ${numbers.length} nomor dalam ${duration} detik.`);
    
    res.json({ 
        status: true, 
        stats: stats,
        results: results,
        duration: `${duration}s`,
        timestamp: new Date().toISOString()
    });
});

// ============ CLEAR CACHE ============
app.post('/clearcache', (req, res) => {
    bioCache.clear();
    cooldownCache.clear();
    logger.info('🧹 Cache dibersihkan');
    res.json({ status: true, message: 'Cache cleared' });
});

// ============ RESTART (ADMIN) ============
app.post('/restart', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== config.ADMIN_KEY) {
        return res.status(403).json({ status: false, error: 'Unauthorized' });
    }
    logger.warn('🔄 Restart diminta oleh admin...');
    res.json({ status: true, message: 'Restarting...' });
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

// ============ ERROR HANDLER MIDDLEWARE ============
app.use((err, req, res, next) => {
    metrics.totalErrors++;
    logger.error('💥 Unhandled error:', err);
    res.status(500).json({ 
        status: false, 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ============ 404 HANDLER ============
app.use((req, res) => {
    res.status(404).json({ 
        status: false, 
        error: 'Endpoint tidak ditemukan',
        available: ['/health', '/status', '/metrics', '/cek', '/detail', '/cooldown', '/masscek', '/clearcache']
    });
});

// ============ GRACEFUL SHUTDOWN ============
process.on('SIGINT', async () => {
    logger.info('\n🛑 SIGINT received. Shutting down gracefully...');
    if (sock) {
        try {
            await sock.logout();
            logger.info('✅ WhatsApp logged out');
        } catch (e) {
            logger.error('Error logout:', e.message);
        }
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('\n🛑 SIGTERM received. Shutting down...');
    if (sock) {
        try {
            await sock.logout();
        } catch (e) {}
    }
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    logger.error('💥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// ============ START SERVER ============
const PORT = config.PORT || 3000;

app.listen(PORT, () => {
    logger.info('========================================');
    logger.info(`🟢 API Sender jalan di port ${PORT}`);
    logger.info(`📊 Health: http://localhost:${PORT}/health`);
    logger.info(`📈 Metrics: http://localhost:${PORT}/metrics`);
    logger.info('========================================');
});

// Start WhatsApp connection
startWhatsApp();

// ============ CLEANUP INTERVAL (tiap 1 jam) ============
setInterval(() => {
    logger.info(`🧹 Auto cleanup | Cache: ${bioCache.size()} bio, ${cooldownCache.size()} cooldown`);
    // TTLCache auto-clean saat get(), tapi kita tetap log
}, 60 * 60 * 1000);
