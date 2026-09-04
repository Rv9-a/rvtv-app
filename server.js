const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = 'rvtv-super-secret-key-2026';
const USERS_FILE = path.join(__dirname, 'users.json');
const CHANNELS_FILE = path.join(__dirname, 'channels.json');

// 1. تهيئة ملف الحسابات
if (!fs.existsSync(USERS_FILE)) {
    const initialUsers = [
        { username: 'admin', password: '123', role: 'admin' },
        { username: 'user1', password: '123', role: 'user' }
    ];
    fs.writeFileSync(USERS_FILE, JSON.stringify(initialUsers, null, 2));
}

// 2. تهيئة ملف القنوات متعددة التقسيم
if (!fs.existsSync(CHANNELS_FILE)) {
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify([], null, 2));
}

const getUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const saveUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

const getChannels = () => JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
const saveChannels = (channels) => fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2));

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware للتحقق من التوكن وصلاحيات الأدمن
const authenticateToken = (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'غير مصرح' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'جلسة منتهية' });
        req.user = user;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'مرفوض - صلاحية أدمن مطلوبة' });
    next();
};

// --- مصادقة الحسابات ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    const user = users.find(u => u.username === username && u.password === password);
    if (!user) return res.status(400).json({ error: 'بيانات الدخول غير صحيحة' });

    const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.cookie('token', token, { httpOnly: true });
    res.json({ username: user.username, role: user.role });
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'تم الخروج' });
});

app.get('/api/me', authenticateToken, (req, res) => {
    res.json({ username: req.user.username, role: req.user.role });
});

// --- إدارة المستخدمين ---
app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
    res.json(getUsers().map(u => ({ username: u.username, role: u.role })));
});

app.post('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });

    const users = getUsers();
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'اسم المستخدم موجود بالفعل' });

    users.push({ username, password, role: role || 'user' });
    saveUsers(users);
    res.json({ message: 'تمت إضافة المستخدم' });
});

app.delete('/api/admin/users/:username', authenticateToken, requireAdmin, (req, res) => {
    if (req.params.username === 'admin') return res.status(400).json({ error: 'لا يمكن حذف الحساب الرئيسي' });

    saveUsers(getUsers().filter(u => u.username !== req.params.username));
    res.json({ message: 'تم الحذف' });
});

// ==========================================
// القسم الأول: نظام Restream الرئيسي (Systemd / Systemctl)
// ==========================================

// 1. جلب حالة البث الرئيسي
app.get('/api/admin/stream-status', authenticateToken, requireAdmin, (req, res) => {
    exec('systemctl is-active iptv-stream.service', (err, stdout) => {
        const isActive = stdout.trim() === 'active';
        res.json({ active: isActive });
    });
});

// 2. إيقاف البث الرئيسي وحذف ملفاته المؤقتة
app.post('/api/admin/stop-stream', authenticateToken, requireAdmin, (req, res) => {
    exec('sudo systemctl stop iptv-stream.service && sudo rm -f /var/www/html/live*', (err) => {
        if (err) return res.status(500).json({ error: 'فشل إيقاف البث الرئيسي' });
        res.json({ message: 'تم إيقاف Restream وقطع الاتصال مع المزود بنجاح' });
    });
});

// 3. تشغيل البث الرئيسي
app.post('/api/admin/start-stream', authenticateToken, requireAdmin, (req, res) => {
    exec('sudo systemctl start iptv-stream.service', (err) => {
        if (err) return res.status(500).json({ error: 'فشل تشغيل البث الرئيسي' });
        res.json({ message: 'تم تشغيل خدمة Restream بنجاح' });
    });
});

// 4. تغيير رابط Restream وإعادة بناء الخدمة
app.post('/api/admin/change-stream', authenticateToken, requireAdmin, (req, res) => {
    const { streamUrl } = req.body;
    if (!streamUrl) return res.status(400).json({ error: 'الرابط مطلوب' });

    const serviceContent = `[Unit]
Description=IPTV Stream Relay Service
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/ffmpeg -loglevel error -user_agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -referer "http://cf.og-cdn.site/" -re -i "${streamUrl}" -c copy -f hls -hls_time 2 -hls_list_size 3 -hls_flags delete_segments /var/www/html/live/index.m3u8
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target`;

    fs.writeFileSync('/etc/systemd/system/iptv-stream.service', serviceContent);

    exec('sudo systemctl daemon-reload && sudo systemctl restart iptv-stream.service', (err) => {
        if (err) return res.status(500).json({ error: 'فشل تحديث رابط Restream' });
        res.json({ message: 'تم تحديث رابط Restream وتشغيل الخدمة بنجاح!' });
    });
});


// ==========================================
// القسم الثاني: نظام التقسيمات والقنوات (PM2 / FFmpeg)
// ==========================================

app.get('/api/channels', authenticateToken, (req, res) => {
    res.json(getChannels().map(c => ({ id: c.id, name: c.name, active: c.active })));
});

app.get('/api/admin/channels', authenticateToken, requireAdmin, (req, res) => {
    res.json(getChannels());
});

app.post('/api/admin/channels', authenticateToken, requireAdmin, (req, res) => {
    const { id, name, url } = req.body;
    if (!id || !name || !url) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });

    const channels = getChannels();
    if (channels.some(c => c.id === id)) return res.status(400).json({ error: 'المعرف مستخدم بالفعل' });

    channels.push({ id, name, url, active: false });
    saveChannels(channels);
    res.json({ message: 'تمت إضافة القناة الفرعية بنجاح' });
});

app.post('/api/admin/channels/:id/start', authenticateToken, requireAdmin, (req, res) => {
    const channels = getChannels();
    const ch = channels.find(c => c.id === req.params.id);
    if (!ch) return res.status(404).json({ error: 'القناة غير موجودة' });

    const cmd = `pm2 start ffmpeg --name "${ch.id}_buffer" -- -user_agent "Mozilla/5.0" -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 1 -rw_timeout 15000000 -re -i "${ch.url}" -c copy -tag:v hvc1 -bsf:v dump_extra -f hls -hls_time 3 -hls_list_size 7 -hls_flags delete_segments+append_list+discont_start+omit_endlist "/var/www/html/channels/${ch.id}.m3u8"`;

    exec(cmd, (err) => {
        if (err) return res.status(500).json({ error: 'فشل تشغيل العملية عبر PM2' });
        ch.active = true;
        saveChannels(channels);
        res.json({ message: `تم تشغيل القناة ${ch.name} عبر PM2` });
    });
});

app.post('/api/admin/channels/:id/stop', authenticateToken, requireAdmin, (req, res) => {
    const channels = getChannels();
    const ch = channels.find(c => c.id === req.params.id);
    if (!ch) return res.status(404).json({ error: 'القناة غير موجودة' });

    exec(`pm2 delete ${ch.id}_buffer && rm -f /var/www/html/channels/${ch.id}*`, () => {
        ch.active = false;
        saveChannels(channels);
        res.json({ message: `تم إيقاف القناة ${ch.name}` });
    });
});

app.delete('/api/admin/channels/:id', authenticateToken, requireAdmin, (req, res) => {
    let channels = getChannels();
    const ch = channels.find(c => c.id === req.params.id);
    if (!ch) return res.status(404).json({ error: 'القناة غير موجودة' });

    exec(`pm2 delete ${ch.id}_buffer && rm -f /var/www/html/channels/${ch.id}*`, () => {
        channels = channels.filter(c => c.id !== req.params.id);
        saveChannels(channels);
        res.json({ message: 'تم حذف القناة بنجاح' });
    });
});

// تحديث عدد المشاهدين عبر Websocket
setInterval(() => {
    exec("netstat -anp | grep :443 | grep ESTABLISHED | wc -l", (err, stdout) => {
        const viewers = parseInt(stdout.trim()) || 0;
        io.emit('stats', { viewers });
    });
}, 3000);

server.listen(3000, () => console.log('RVTV Dual-Engine App running on port 3000'));
