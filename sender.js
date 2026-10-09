// ==========================================
// SENDER.JS - Bot Cek Bio WA By Angga Official
// Versi Stabil (Anti-Error, Minimal Dependency)
// Butuh: @whiskeysockets/baileys + express
// ==========================================

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');

// ============ LOGGER (Pakai console biasa, anti-error) ============
function log(...args) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${time}]`, ...args);
}

function logError(...args) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    console.error(`❌ [${time}]`, ...args);
}

function logWarn(...args) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    console.warn(`⚠️ [${time}]`, ...args);
}

function logSuccess(...args) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`✅ [${time}]`, ...args);
}

// ============ LOG TO FILE ============
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

function logToFile(msg) {
    try {
        const date = new Date().toISOString().split('T')[0];
        const file = path.join(LOG_DIR, `sender_${date}.log`);
        fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) {}
}

// ============ GLOBAL STATE ============
let sock = null;
let connectionState = 'disconnected';
let lastConnectionTime = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// ============ METRICS ============
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

// ============ CACHE SYSTEM (TTL) ============
class TTLCache {
    constructor(ttlMs) {
        this.cache = new Map();
        this.ttl = ttlMs || (5 * 60 * 1000);
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
            value: value,
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
const cooldownCache = new TTLCache(10 * 60 * 1000);

// ============ RATE LIMIT MANUAL ============
const rateLimitMap = new Map();

function manualRateLimit(max, windowMs) {
    max = max || 30;
    windowMs = windowMs || 60000;
    return function (req, res, next) {
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();
        if (!rateLimitMap.has(ip)) {
            rateLimitMap.set(ip, { count: 0, reset: now + windowMs });
        }
        const data = rateLimitMap.get(ip);
        if (now > data.reset) {
            data.count = 0;
            data.reset = now + windowMs;
        }
        data.count++;
        if (data.count > max) {
            return res.status(429).json({
                status: false,
                error: 'Too many requests. Try again later.'
            });
        }
        next();
    };
}

const apiLimiter = manualRateLimit(30, 60000);
const massLimiter = manualRateLimit(5, 60000);

// ============ HELPER: NOMOR ============
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
function delay(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

// ============ HELPER: RETRY ============
async function withRetry(fn, maxRetries, delayMs) {
    maxRetries = maxRetries || 2;
    delayMs = delayMs || 1000;
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

// ============ LOGGER BAILEYS (Safe) ============
function createBaileysLogger() {
    const noop = function () {};
    return {
        level: 'warn',
        info: noop,
        debug: noop,
        trace: noop,
        warn: function () {
            const args = Array.from(arguments);
            console.warn('[Baileys]', ...args);
        },
        error: function () {
            const args = Array.from(arguments);
            console.error('[Baileys ERROR]', ...args);
        },
        fatal: function () {
            const args = Array.from(arguments);
            console.error('[Baileys FATAL]', ...args);
        },
        child: function () {
            return createBaileysLogger();
        }
    };
}

// ============ WHATSAPP CONNECTION ============
async function startWhatsApp() {
    if (connectionState === 'connecting' || connectionState === 'connected') {
        logWarn('WhatsApp sudah terhubung atau sedang menghubungkan.');
        return;
    }

    connectionState = 'connecting';
    log('Menghubungkan ke WhatsApp...');

    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version, isLatest } = await fetchLatestBaileysVersion();
        log('Baileys versi:', version, '| Terbaru:', isLatest);

        sock = makeWASocket({
            version: version,
            auth: state,
            logger: createBaileysLogger(),
            printQRInTerminal: false,
            browser: ['Bot-Angga', 'Chrome', '1.0.0'],
            defaultQueryTimeoutMs: 30000,
            connectTimeoutMs: 20000,
            keepAliveIntervalMs: 30000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', function (update) {
            const connection = update.connection;
            const lastDisconnect = update.lastDisconnect;
            const qr = update.qr;

            if (qr) {
                log('QR Code tersedia. Gunakan pairing code untuk login.');
            }

            if (connection === 'open') {
                connectionState = 'connected';
                lastConnectionTime = new Date();
                reconnectAttempts = 0;
                logSuccess('WhatsApp Sender Berhasil Terhubung!');
                if (sock.user && sock.user.id) {
                    log('Logged in as:', sock.user.id);
                }
            } else if (connection === 'close') {
                connectionState = 'disconnected';
                const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
                logError('Koneksi WA terputus. Status Code:', statusCode || 'Tidak diketahui');

                if (statusCode !== 410 && statusCode !== 401) {
                    reconnectAttempts++;
                    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
                        logError('Max reconnect attempts (' + MAX_RECONNECT_ATTEMPTS + ') tercapai. Manual restart diperlukan.');
                        return;
                    }
                    const delayMs = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);
                    logWarn('Mencoba reconnect dalam', (delayMs / 1000), 'detik... (attempt ' + reconnectAttempts + '/' + MAX_RECONNECT_ATTEMPTS + ')');
                    setTimeout(function () {
                        startWhatsApp();
                    }, delayMs);
                } else {
                    logError('Akun keluar/blockir (401/410). Hapus folder auth_info_baileys dan coba lagi.');
                }
            }
        });

        // Pairing code
        if (!state.creds.registered && config.WA_NUMBER) {
            const phoneNumber = config.WA_NUMBER.replace(/\D/g, '');
            log('Nomor di config:', config.WA_NUMBER);
            log('Nomor setelah clean:', phoneNumber);
            log('Panjang nomor:', phoneNumber.length, 'digit');

            if (phoneNumber.length < 8 || phoneNumber.length > 15) {
                logError('Format nomor tidak valid! Harus 8-15 digit tanpa + atau spasi.');
                logError('Contoh benar: 6281234567890');
                return;
            }

            await delay(3000);
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                log('');
                log('========================================');
                log('🔑 KODE PAIRING ANDA:', code);
                log('========================================');
                log('Cara pakai:');
                log('1. Buka WhatsApp di HP');
                log('2. Settings > Linked Devices > Link a Device');
                log('3. Tap "Link with phone number instead"');
                log('4. Pilih negara + masukkan nomor (tanpa +62)');
                log('5. Masukkan kode di atas (60 detik!)');
                log('========================================');
                log('');
            } catch (err) {
                logError('Gagal meminta kode pairing:', err.message);
                logToFile('Pairing error: ' + err.message);
            }
        }
    } catch (err) {
        connectionState = 'disconnected';
        logError('Error startWhatsApp:', err.message);
        logToFile('startWhatsApp error: ' + err.stack);
        // Retry after 10s
        setTimeout(function () {
            startWhatsApp();
        }, 10000);
    }
}

// ============ EXPRESS APP ============
const app = express();

// CORS MANUAL (tanpa dependency cors)
app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============ HEALTH CHECK ============
app.get('/health', function (req, res) {
    res.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - metrics.startTime) / 1000),
        whatsapp: connectionState,
        lastConnection: lastConnectionTime,
        timestamp: new Date().toISOString(),
        cacheSize: bioCache.size()
    });
});

// ============ STATUS ============
app.get('/status', function (req, res) {
    res.json({
        connected: connectionState === 'connected',
        state: connectionState,
        user: (sock && sock.user) ? sock.user.id : null,
        lastConnection: lastConnectionTime,
        reconnectAttempts: reconnectAttempts
    });
});

// ============ METRICS ============
app.get('/metrics', function (req, res) {
    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    res.json({
        totalRequests: metrics.totalRequests,
        totalSingleChecks: metrics.totalSingleChecks,
        totalMassChecks: metrics.totalMassChecks,
        totalCooldownChecks: metrics.totalCooldownChecks,
        totalSuccess: metrics.totalSuccess,
        totalErrors: metrics.totalErrors,
        startTime: new Date(metrics.startTime).toISOString(),
        lastError: metrics.lastError,
        lastErrorTime: metrics.lastErrorTime,
        uptimeSeconds: uptime,
        uptimeFormatted: hours + 'h ' + minutes + 'm ' + seconds + 's',
        cacheSize: bioCache.size()
    });
});

// ============ CEK 1 NOMOR (BIO) ============
app.get('/cek', apiLimiter, async function (req, res) {
    const nomor = req.query.nomor;
    metrics.totalRequests++;
    metrics.totalSingleChecks++;

    if (!nomor) {
        return res.status(400).json({ status: false, bio: 'Nomor tidak ada' });
    }

    const jid = toJid(nomor);
    if (!jid) {
        return res.status(400).json({ status: false, bio: 'Format nomor tidak valid' });
    }

    try {
        if (!sock || !sock.user || connectionState !== 'connected') {
            return res.status(503).json({ status: false, bio: 'Sender WA offline!' });
        }

        // Cek cache dulu
        const cached = bioCache.get('bio_' + jid);
        if (cached) {
            log('Cache hit untuk', jid);
            return res.json({
                status: true,
                bio: cached.bio,
                exists: cached.exists,
                cached: true
            });
        }

        const result = await withRetry(async function () {
            const [exists] = await sock.onWhatsApp(jid);
            if (!exists || !exists.exists) {
                return { exists: false, bio: null };
            }
            const status = await sock.fetchStatus(jid);
            return {
                exists: true,
                bio: (status && status.status) ? status.status : 'Bio tidak tersedia'
            };
        });

        metrics.totalSuccess++;

        bioCache.set('bio_' + jid, result);

        res.json({
            status: true,
            bio: result.bio || 'Bio tidak tersedia',
            exists: result.exists
        });
    } catch (err) {
        metrics.totalErrors++;
        metrics.lastError = err.message;
        metrics.lastErrorTime = new Date().toISOString();
        logError('Error cek', nomor, ':', err.message);
        logToFile('ERROR /cek ' + nomor + ': ' + err.message);
        res.json({ status: false, bio: 'Nomor tidak terdaftar di WA / Private' });
    }
});

// ============ CEK DETAIL LENGKAP ============
app.get('/detail', apiLimiter, async function (req, res) {
    const nomor = req.query.nomor;
    metrics.totalRequests++;

    if (!nomor) {
        return res.status(400).json({ status: false, error: 'Nomor tidak ada' });
    }

    const jid = toJid(nomor);
    if (!jid) {
        return res.status(400).json({ status: false, error: 'Format nomor tidak valid' });
    }

    try {
        if (!sock || !sock.user || connectionState !== 'connected') {
            return res.status(503).json({ status: false, error: 'Sender WA offline!' });
        }

        const result = await withRetry(async function () {
            const [exists] = await sock.onWhatsApp(jid);
            if (!exists || !exists.exists) {
                return { exists: false };
            }

            const detail = {
                exists: true,
                jid: jid,
                bio: null,
                business: null,
                isBusiness: false,
                hasPhoto: false,
                photo: null
            };

            try {
                const status = await sock.fetchStatus(jid);
                detail.bio = (status && status.status) ? status.status : null;
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
                        address: biz.address || null
                    };
                }
            } catch (e) {}

            try {
                const photo = await sock.profilePictureUrl(jid, 'preview');
                detail.hasPhoto = !!photo;
                detail.photo = photo;
            } catch (e) {
                detail.hasPhoto = false;
            }

            return detail;
        });

        metrics.totalSuccess++;
        res.json({ status: true, data: result });
    } catch (err) {
        metrics.totalErrors++;
        metrics.lastError = err.message;
        metrics.lastErrorTime = new Date().toISOString();
        logError('Error detail', nomor, ':', err.message);
        logToFile('ERROR /detail ' + nomor + ': ' + err.message);
        res.json({ status: false, error: err.message });
    }
});

// ============ CEK COOLDOWN OTP ============
app.get('/cooldown', apiLimiter, async function (req, res) {
    const nomor = req.query.nomor;
    metrics.totalRequests++;
    metrics.totalCooldownChecks++;

    if (!nomor) {
        return res.status(400).json({ status: false, error: 'Nomor tidak ada' });
    }

    const jid = toJid(nomor);
    if (!jid) {
        return res.status(400).json({ status: false, error: 'Format nomor tidak valid' });
    }

    try {
        if (!sock || !sock.user || connectionState !== 'connected') {
            return res.status(503).json({ status: false, error: 'Sender WA offline!' });
        }

        const cachedCooldown = cooldownCache.get('cooldown_' + jid);
        const now = Date.now();
        const cooldownDuration = 5 * 60 * 1000; // 5 menit

        let status, isOnCooldown, cooldownEnds;

        if (cachedCooldown && (now - cachedCooldown.lastCheck < 60000)) {
            // Cache masih fresh (< 1 menit)
            status = cachedCooldown.status;
            isOnCooldown = cachedCooldown.isOnCooldown;
            cooldownEnds = cachedCooldown.cooldownEnds;
        } else {
            // Cek ke WhatsApp
            const [exists] = await sock.onWhatsApp(jid);

            if (!exists || !exists.exists) {
                return res.json({
                    status: false,
                    error: 'Nomor tidak terdaftar di WA',
                    phone: sanitizeNumber(nomor),
                    timestamp: new Date().toISOString()
                });
            }

            if (cachedCooldown) {
                const timeSinceLastCheck = now - cachedCooldown.lastCheck;
                if (timeSinceLastCheck < cooldownDuration) {
                    status = 'cooldown';
                    isOnCooldown = true;
                    cooldownEnds = cachedCooldown.lastCheck + cooldownDuration;
                } else {
                    status = 'ready';
                    isOnCooldown = false;
                    cooldownEnds = null;
                }
            } else {
                status = 'ready';
                isOnCooldown = false;
                cooldownEnds = null;
            }

            cooldownCache.set('cooldown_' + jid, {
                status: status,
                isOnCooldown: isOnCooldown,
                cooldownEnds: cooldownEnds,
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
            message: isOnCooldown ? 'Nomor sedang cooldown' : 'Nomor siap OTP'
        });
    } catch (err) {
        metrics.totalErrors++;
        metrics.lastError = err.message;
        metrics.lastErrorTime = new Date().toISOString();
        logError('Error cooldown', nomor, ':', err.message);
        logToFile('ERROR /cooldown ' + nomor + ': ' + err.message);
        res.json({
            status: false,
            error: err.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ============ CEK MASSAL ============
app.post('/masscek', massLimiter, async function (req, res) {
    const numbers = req.body && req.body.numbers;
    metrics.totalRequests++;
    metrics.totalMassChecks++;

    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ status: false, error: 'Format salah: numbers harus array' });
    }

    if (numbers.length > 1000) {
        return res.status(400).json({
            status: false,
            error: 'Maksimal 1000 nomor per request'
        });
    }

    if (!sock || !sock.user || connectionState !== 'connected') {
        return res.status(503).json({ status: false, error: 'Sender WA offline!' });
    }

    const stats = {
        total: numbers.length,
        registered: 0,
        notRegistered: 0,
        hasBio: 0,
        noBio: 0,
        business: 0,
        errors: 0
    };

    const results = [];
    log('Menerima request massal cek', numbers.length, 'nomor...');
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
                error: 'Format nomor tidak valid'
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
                    if (status && status.status && status.status.trim() !== '') {
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
                results.push({ number: num, exists: false });
            }
        } catch (err) {
            stats.notRegistered++;
            stats.errors++;
            results.push({
                number: num,
                exists: false,
                error: err.message
            });
            logError('Error cek', num, ':', err.message);
        }

        // Progress setiap 50 nomor
        if ((i + 1) % 50 === 0) {
            log('Progress:', (i + 1) + '/' + numbers.length, '(' + Math.floor((i + 1) / numbers.length * 100) + '%)');
        }

        await delay(300); // 300ms jeda anti-ban
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    logSuccess('Selesai cek massal', numbers.length, 'nomor dalam', duration, 'detik.');

    res.json({
        status: true,
        stats: stats,
        results: results,
        duration: duration + 's',
        timestamp: new Date().toISOString()
    });
});

// ============ CLEAR CACHE ============
app.post('/clearcache', function (req, res) {
    bioCache.clear();
    cooldownCache.clear();
    log('Cache dibersihkan');
    res.json({ status: true, message: 'Cache cleared' });
});

// ============ RESTART (ADMIN) ============
app.post('/restart', function (req, res) {
    const adminKey = req.headers['x-admin-key'];
    if (!config.ADMIN_KEY || adminKey !== config.ADMIN_KEY) {
        return res.status(403).json({ status: false, error: 'Unauthorized' });
    }
    logWarn('Restart diminta oleh admin...');
    res.json({ status: true, message: 'Restarting...' });
    setTimeout(function () {
        process.exit(0);
    }, 1000);
});

// ============ ERROR HANDLER ============
app.use(function (err, req, res, next) {
    metrics.totalErrors++;
    logError('Unhandled error:', err.message);
    logToFile('UNHANDLED ERROR: ' + (err.stack || err.message));
    res.status(500).json({
        status: false,
        error: 'Internal server error',
        message: err.message
    });
});

// ============ 404 ============
app.use(function (req, res) {
    res.status(404).json({
        status: false,
        error: 'Endpoint tidak ditemukan',
        available: ['/health', '/status', '/metrics', '/cek', '/detail', '/cooldown', '/masscek', '/clearcache', '/restart']
    });
});

// ============ GRACEFUL SHUTDOWN ============
process.on('SIGINT', async function () {
    log('\nSIGINT received. Shutting down gracefully...');
    if (sock) {
        try {
            await sock.logout();
            logSuccess('WhatsApp logged out');
        } catch (e) {
            logError('Error logout:', e.message);
        }
    }
    process.exit(0);
});

process.on('SIGTERM', async function () {
    log('SIGTERM received. Shutting down...');
    if (sock) {
        try { await sock.logout(); } catch (e) {}
    }
    process.exit(0);
});

process.on('uncaughtException', function (err) {
    logError('Uncaught Exception:', err.message);
    logToFile('UNCAUGHT EXCEPTION: ' + (err.stack || err.message));
});

process.on('unhandledRejection', function (reason, promise) {
    logError('Unhandled Rejection:', reason);
    logToFile('UNHANDLED REJECTION: ' + reason);
});

// ============ START SERVER ============
const PORT = config.PORT || 3000;

const server = app.listen(PORT, function () {
    log('========================================');
    log('🟢 API Sender jalan di port', PORT);
    log('📊 Health:  http://localhost:' + PORT + '/health');
    log('📈 Metrics: http://localhost:' + PORT + '/metrics');
    log('========================================');
});

server.on('error', function (err) {
    if (err.code === 'EADDRINUSE') {
        logError('Port', PORT, 'sudah dipakai! Ganti PORT di config.json.');
    } else {
        logError('Server error:', err.message);
    }
});

// Start WhatsApp connection
startWhatsApp();

// Cleanup info tiap 1 jam
setInterval(function () {
    log('Status:', connectionState, '| Cache:', bioCache.size(), 'bio,', cooldownCache.size(), 'cooldown');
}, 60 * 60 * 1000);
