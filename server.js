/**
 * Telegram Bot Server v3.0
 *
 * Tính năng mới:
 *   - Dynamic group management: thêm/sửa/xoá group không cần sửa code
 *   - Groups lưu trong groups.json, quản lý qua REST API /admin/groups
 *   - Buttons assign tự động sinh từ danh sách team groups
 *   - Hot-reload: thay đổi group có hiệu lực ngay, không cần restart
 *
 * Flow:
 *   Website → Group Tổng → admin assign → Group Team (bất kỳ)
 *   Team Done/Cancel/Invalid → bot tự update WP + edit cả 2 message
 */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());

// ── Core config ───────────────────────────────────────────────
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '37b7ca3bc73c053149a6a79c6486313f70c5882b519723aa43ae84863558881c';
const ADMIN_SECRET   = process.env.ADMIN_SECRET   || WEBHOOK_SECRET; // để bảo vệ API /admin
const PORT           = process.env.PORT || 8000;
const WORDPRESS_URL  = process.env.WORDPRESS_URL || 'https://buffupnow.com';

// ── Media group buffer (gom ảnh album trước khi xử lý) ───────
// Key: media_group_id, Value: { timer, photos: [], caption, chatId, fromName, teamEntry }
const mediaGroupBuffer = new Map();
const MEDIA_GROUP_DELAY = 1500; // ms chờ sau ảnh cuối cùng

// ── Groups manager ────────────────────────────────────────────
const GROUPS_FILE = path.join(__dirname, 'groups.json');

/**
 * Cấu trúc groups.json:
 * {
 *   "total": { "id": "-100xxx", "label": "Vận đơn Tổng", "type": "total" },
 *   "team_a": { "id": "-100xxx", "label": "Team A", "type": "team" },
 *   "team_vip": { "id": "-100xxx", "label": "Team VIP", "type": "team" }
 * }
 */
function loadGroups() {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('⚠️  Lỗi đọc groups.json:', e.message);
    }

    // Fallback: tạo từ env nếu chưa có file
    const defaults = {};
    if (process.env.TELEGRAM_GROUP_TOTAL_ID) {
        defaults['total'] = {
            id: process.env.TELEGRAM_GROUP_TOTAL_ID,
            label: 'Vận đơn Tổng',
            type: 'total',
        };
    }
    const teamEnvs = [
        ['team_a', process.env.TELEGRAM_GROUP_TEAM_A_ID, 'Team A'],
        ['team_b', process.env.TELEGRAM_GROUP_TEAM_B_ID, 'Team B'],
        ['team_c', process.env.TELEGRAM_GROUP_TEAM_C_ID, 'Team C'],
    ];
    for (const [key, id, label] of teamEnvs) {
        if (id) defaults[key] = { id, label, type: 'team' };
    }

    if (Object.keys(defaults).length > 0) {
        saveGroups(defaults);
        console.log('📝 Đã tạo groups.json từ .env');
    }
    return defaults;
}

function saveGroups(groups) {
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
}

// Hot-reload: luôn đọc file mới nhất khi cần
function getGroups()     { return loadGroups(); }
function getTotalGroup()   { return Object.values(getGroups()).find(g => g.type === 'total'); }
function getPaymentGroup() { return Object.values(getGroups()).find(g => g.type === 'payment'); }
function getTeamGroups() { return Object.entries(getGroups()).filter(([, g]) => g.type === 'team'); }

function getGroupByKey(key)   { return getGroups()[key]; }
function getGroupByChatId(id) {
    return Object.entries(getGroups()).find(([, g]) => String(g.id) === String(id));
}

// ── Order tracker ─────────────────────────────────────────────
const ORDER_FILE = path.join(__dirname, 'order_tracking.json');

function loadOrders() {
    try {
        if (fs.existsSync(ORDER_FILE)) return JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8'));
    } catch (e) { /* ignore */ }
    return {};
}

function saveOrders(data) {
    try { fs.writeFileSync(ORDER_FILE, JSON.stringify(data, null, 2)); } catch (e) { /* ignore */ }
}

const orderTracker = loadOrders();

function trackOrder(orderNumber, data) {
    orderTracker[orderNumber] = { ...(orderTracker[orderNumber] || {}), ...data };
    saveOrders(orderTracker);
}

function getTracked(orderNumber) { return orderTracker[orderNumber] || null; }

// ── Telegram user registry (username → chat_id) ───────────────
const TG_USERS_FILE = path.join(__dirname, 'telegram_users.json');

function loadTgUsers() {
    try {
        if (fs.existsSync(TG_USERS_FILE)) return JSON.parse(fs.readFileSync(TG_USERS_FILE, 'utf8'));
    } catch (e) { /* ignore */ }
    return {};
}

function saveTgUsers(data) {
    try { fs.writeFileSync(TG_USERS_FILE, JSON.stringify(data, null, 2)); } catch (e) { /* ignore */ }
}

const tgUsers = loadTgUsers();

function registerTgUser(username, chatId) {
    if (!username) return;
    const key = username.replace(/^@/, '').toLowerCase();
    tgUsers[key] = String(chatId);
    saveTgUsers(tgUsers);
}

function getTgChatId(username) {
    if (!username) return null;
    const key = username.replace(/^@/, '').toLowerCase();
    return tgUsers[key] || null;
}

// ── Telegram helpers ──────────────────────────────────────────

async function tgPost(method, body) {
    try {
        const res = await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
            body,
            { timeout: 10000 }
        );
        return res.data;
    } catch (e) {
        const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error(`❌ tgPost ${method} [${e.response?.status}]: ${detail}`);
        throw e;
    }
}

async function sendMessage(chatId, text, keyboard = null) {
    const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };
    if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
    const res = await tgPost('sendMessage', payload);
    return res.result.message_id;
}

async function sendPhoto(chatId, photoUrl) {
    return tgPost('sendPhoto', { chat_id: chatId, photo: photoUrl });
}

async function sendMediaGroup(chatId, photoUrls) {
    if (!photoUrls?.length) return;
    const media = photoUrls.slice(0, 10).map((url, idx) => ({
        type: 'photo', media: url,
        ...(idx === 0 ? { caption: '🖼 Hình ảnh đính kèm', parse_mode: 'Markdown' } : {}),
    }));
    return tgPost('sendMediaGroup', { chat_id: chatId, media });
}

async function editMessage(chatId, messageId, text, keyboard = null) {
    const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' };
    if (keyboard !== undefined) {
        payload.reply_markup = keyboard ? { inline_keyboard: keyboard } : { inline_keyboard: [] };
    }
    try { await tgPost('editMessageText', payload); } catch (e) { /* ignore "not modified" */ }
}

async function answerCallback(callbackId, text, showAlert = false) {
    try {
        await tgPost('answerCallbackQuery', {
            callback_query_id: callbackId, text, show_alert: showAlert,
        });
    } catch (e) { /* ignore */ }
}

// ── Report helper ────────────────────────────────────────────

async function queryReport(date, teamLabel = '') {
    const params = new URLSearchParams({ date });
    if (teamLabel) params.append('team_label', teamLabel);
    const res = await axios.get(
        `${WORDPRESS_URL}/wp-json/telegram-orders/v1/report?${params}`,
        {
            headers: { 'Authorization': `Bearer ${WEBHOOK_SECRET}` },
            timeout: 15000,
        }
    );
    return res.data;
}

function formatReport(data, title) {
    const d      = data.date;
    const groups = data.groups;

    // Chuyển YYYY-MM-DD → DD/MM/YYYY
    const [y, m, day] = d.split('-');
    const dateStr = `${day}/${m}/${y}`;

    const statusMap = {
        processing: { icon: '🔄', label: 'Processing' },
        completed:  { icon: '✅', label: 'Hoàn thành' },
        cancelled:  { icon: '🚫', label: 'Đã hủy' },
        failed:     { icon: '❌', label: 'Thất bại' },
        'on-hold':  { icon: '⏳', label: 'Chờ xác nhận' },
        pending:    { icon: '🕐', label: 'Chờ thanh toán' },
    };

    let text = `📊 *Tra soát ${title}*\nNgày: *${dateStr}*\n━━━━━━━━━━━━━━━━━━━━\n`;

    let hasData = false;
    for (const [status, info] of Object.entries(statusMap)) {
        const list = groups[status] || [];
        if (list.length === 0) continue;
        hasData = true;

        text += `\n${info.icon} *${info.label}: ${list.length} đơn*\n`;
        list.forEach((o, idx) => {
            const updater = o.updated_by ? ` — ${o.updated_by}` : '';
            const team    = o.team       ? ` [${o.team}]`       : '';
            text += `  ${idx + 1}. #${o.order_number} ${o.time}${team}${updater}\n`;
            if (o.items) text += `     📦 ${o.items}\n`;
        });
    }

    if (!hasData) text += '\n_Không có đơn nào trong ngày này._';
    return text;
}

// ── Telegram file helpers ────────────────────────────────────

/**
 * Lấy URL download của file từ Telegram (dùng để upload lên WP)
 */
async function getTelegramFileUrl(fileId) {
    const res  = await tgPost('getFile', { file_id: fileId });
    const path = res.result?.file_path;
    if (!path) throw new Error('Không lấy được file_path');
    return `https://api.telegram.org/file/bot${BOT_TOKEN}/${path}`;
}

/**
 * Gửi tin nhắn Telegram cho khách.
 * Ưu tiên dùng numeric chat_id từ registry (khi khách đã /start bot).
 * Fallback về @username nếu chưa có.
 */
async function notifyCustomerTelegram(tgUsername, message) {
    const numericId = getTgChatId(tgUsername);
    const chatId    = numericId || (tgUsername.startsWith('@') ? tgUsername : '@' + tgUsername);
    console.log(`📨 DM khách: username="${tgUsername}" → chat_id="${chatId}" (${numericId ? 'numeric' : 'username fallback'})`);
    return tgPost('sendMessage', {
        chat_id:    chatId,
        text:       message,
        parse_mode: 'Markdown',
    });
}

/**
 * Lưu thông tin đăng nhập mới từ khách lên WP
 */
async function updateCredentialsWP(orderNumber, credentials, fromName) {
    return axios.post(
        `${WORDPRESS_URL}/wp-json/telegram-orders/v1/update-credentials`,
        { order_id: orderNumber, credentials, from_name: fromName },
        { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WEBHOOK_SECRET}` }, timeout: 10000 }
    );
}

/**
 * Upload ảnh xác nhận lên WordPress (_wot_receipts)
 */
async function uploadReceiptToWP(orderNumber, imageUrl, fileName, uploadedBy) {
    const res = await axios.post(
        `${WORDPRESS_URL}/wp-json/telegram-orders/v1/upload-receipt`,
        { order_id: orderNumber, image_url: imageUrl, file_name: fileName, uploaded_by: uploadedBy },
        {
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${WEBHOOK_SECRET}`,
            },
            timeout: 30000,
        }
    );
    return res.data;
}

// ── Format & keyboards ────────────────────────────────────────

function formatPaymentMessage(order) {
    const num     = order.order_number_raw || 'N/A';
    const display = order.order_id || num;
    const method  = order.payment_method || 'Bank Transfer';
    const total   = order.total || '';

    return (
        `💳 *[DUYỆT THANH TOÁN]*
` +
        `━━━━━━━━━━━━━━━━━━━━

` +
        `📋 *Mã đơn:* #${display}
` +
        `💰 *Phương thức:* ${method}
` +
        `💵 *Tổng tiền:* ${total}

` +
        `_Vui lòng kiểm tra biên lai và xác nhận._`
    );
}

function formatOrderMessage(order, groupLabel = 'VẬN ĐƠN TỔNG') {
    const orderNumber = order.order_id || 'N/A';
    const itemsText = (order.items?.length > 0)
        ? order.items.map((item, idx) => `  ${idx + 1}. ${item.product_name} × ${item.quantity}`).join('\n')
        : '  N/A';
    const credentials = order.line_credentials?.trim() || 'Không có thông tin tài khoản';
    const notes       = order.customer_note || 'Không có ghi chú';

    return (
        `📦 *[${groupLabel}] Mã đơn:* #${orderNumber}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🛍️ *Sản phẩm:*\n${itemsText}\n\n` +
        `👤 *Thông tin tài khoản:*\n\`\`\`\n${credentials}\n\`\`\`\n\n` +
        `📝 *Ghi chú:* ${notes}\n` +
        `\n_Xin cảm ơn!_ 🙏`
    );
}

/**
 * Keyboard cho Group Tổng — assign buttons sinh động từ groups.json
 * Nếu có nhiều team, tự động chia hàng (tối đa 3 button/hàng)
 */
function keyboardPayment(orderNumber) {
    return [[
        { text: '✅ Approve',    callback_data: `pay_approve_${orderNumber}`    },
        { text: '❌ Disapprove', callback_data: `pay_disapprove_${orderNumber}` },
    ]];
}

function keyboardTotal(orderNumber) {
    const teams      = getTeamGroups(); // [ [key, {id, label, type}], ... ]
    const assignBtns = teams.map(([key, g]) => ({
        text:          `➡️ ${g.label}`,
        callback_data: `assign_${key}_${orderNumber}`,
    }));

    // Chia thành hàng 3 button
    const rows = [];
    for (let i = 0; i < assignBtns.length; i += 3) {
        rows.push(assignBtns.slice(i, i + 3));
    }

    // Hàng cuối: Done / Invalid / Cancel
    rows.push([
        { text: '✅ Done',          callback_data: `done_${orderNumber}`    },
        { text: '❌ Invalid Login', callback_data: `invalid_${orderNumber}` },
        { text: '🚫 Cancel',        callback_data: `cancel_${orderNumber}`  },
    ]);

    return rows;
}

function keyboardTeam(orderNumber) {
    return [[
        { text: '✅ Done',          callback_data: `team_done_${orderNumber}`    },
        { text: '❌ Invalid Login', callback_data: `team_invalid_${orderNumber}` },
        { text: '🚫 Cancel',        callback_data: `team_cancel_${orderNumber}`  },
    ]];
}

// ── Status helpers ────────────────────────────────────────────

function resolveStatus(action) {
    return {
        done:    { wpStatus: 'completed', text: '✅ Hoàn thành' },
        invalid: { wpStatus: null,        text: '❌ Thông tin đăng nhập sai' }, // không đổi status
        cancel:  { wpStatus: 'cancelled', text: '🚫 Đã hủy' },
    }[action] || null;
}

async function approvePaymentWP(orderNumber, action, updatedBy) {
    const res = await axios.post(
        `${WORDPRESS_URL}/wp-json/telegram-orders/v1/approve-payment`,
        { order_id: orderNumber, action, updated_by: updatedBy },
        {
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${WEBHOOK_SECRET}`,
            },
            timeout: 10000,
        }
    );
    return res.data;
}

async function updateWordPressStatus(orderNumber, wpStatus, updatedBy, teamLabel = '') {
    console.log(`🔄 WP update: order="${orderNumber}" status="${wpStatus}" by="${updatedBy}"`);
    try {
        const res = await axios.post(
            `${WORDPRESS_URL}/wp-json/telegram-orders/v1/update-status`,
            { order_id: orderNumber, status: wpStatus, updated_by: updatedBy, team_label: teamLabel },
            {
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${WEBHOOK_SECRET}`,
                },
                timeout: 10000,
            }
        );
        console.log(`✅ WP response: ${JSON.stringify(res.data)}`);
    } catch (e) {
        const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error(`❌ WP update failed [${e.response?.status}]: ${detail}`);
        console.error(`   orderNumber sent: "${orderNumber}"`);
        throw e;
    }
}

/**
 * Bot xử lý khi Team bấm button hoặc gõ lệnh:
 * 1. Update WP
 * 2. Edit message tại Group nguồn — dùng text GỐC từ tracker
 * 3. Edit message ở Group Tổng — dùng text GỐC từ tracker
 * 4. Gửi notify ngắn về Group Tổng
 */
async function botProcessStatus(orderNumber, action, fromName, source, sourceChatId, sourceMsgId) {
    const resolved = resolveStatus(action);
    if (!resolved) return;

    const { wpStatus, text: statusText } = resolved;
    const tracked = getTracked(orderNumber);
    const total   = getTotalGroup();

    // 1. Update WordPress (invalid không đổi status)
    if (wpStatus) {
        await updateWordPressStatus(orderNumber, wpStatus, `${fromName} (${source})`, source !== 'Tổng' ? source : '');
        console.log(`✅ WP: #${orderNumber} → ${wpStatus}`);
    }

    // Nếu invalid → thông báo cho khách qua Telegram DM + email
    if (action === 'invalid') {
        const invalidMsg =
            `⚠️ *Thông báo từ ${process.env.STORE_NAME || 'Store'}*\n\n` +
            `Đơn hàng *#${orderNumber}* của bạn gặp vấn đề:\n` +
            `_Thông tin đăng nhập không chính xác._\n\n` +
            `Vui lòng reply tin nhắn này với thông tin đúng để chúng tôi xử lý tiếp.\n` +
            `Format: \`Username: xxx | Password: xxx\``;

        // Lấy customer_telegram từ tracker (đã lưu lúc nhận đơn mới)
        let tgUser = tracked?.customerTelegram || '';
        console.log(`🔍 Invalid #${orderNumber} — tracker customerTelegram="${tgUser}"`);

        // Bước 1: Gọi WP gửi email + lấy customer_telegram (nếu tracker chưa có)
        try {
            const wpRes = await axios.post(
                `${WORDPRESS_URL}/wp-json/telegram-orders/v1/notify-customer`,
                { order_id: orderNumber, message: invalidMsg },
                { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WEBHOOK_SECRET}` }, timeout: 10000 }
            );
            console.log(`📧 Email gửi tới khách: ${wpRes.data?.email} — success=${wpRes.data?.success} — customer_telegram="${wpRes.data?.customer_telegram}"`);
            // Lấy customer_telegram từ WP nếu tracker chưa có hoặc rỗng
            if (!tgUser && wpRes.data?.customer_telegram) {
                tgUser = wpRes.data.customer_telegram;
                trackOrder(orderNumber, { customerTelegram: tgUser });
                console.log(`💾 Lấy customer_telegram từ WP: ${tgUser}`);
            }
        } catch (e) {
            const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
            console.error(`❌ WP notify-customer thất bại [${e.response?.status}]: ${detail}`);
            console.error(`   order_id gửi đi: "${orderNumber}"`);
        }

        // Bước 2: DM Telegram cho khách (dùng tgUser đã được cập nhật từ WP nếu cần)
        if (tgUser) {
            try {
                const sentMsg = await notifyCustomerTelegram(tgUser, invalidMsg);
                trackOrder(orderNumber, {
                    customerNotifyMsgId: sentMsg?.result?.message_id,
                    pendingCredentials:  true,
                    invalidSource:       source,
                    invalidSourceChatId: sourceChatId,
                });
                console.log(`📩 Đã DM Telegram khách ${tgUser} về đơn #${orderNumber}`);
            } catch (e) {
                const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
                console.error(`❌ Không nhắn được Telegram khách ${tgUser}: [${e.response?.status}] ${detail}`);
            }
        } else {
            console.warn(`⚠️  Đơn #${orderNumber} không có customer_telegram (cả tracker lẫn WP) — bỏ qua DM`);
        }
    }

    // 2. Edit message tại Group nguồn (luôn dùng text gốc từ tracker)
    const sourceOriginal = source === 'Tổng'
        ? (tracked?.orderText || '')
        : (tracked?.teamMsgText || tracked?.orderText || '');
    await editMessage(sourceChatId, sourceMsgId, sourceOriginal + `\n\n${statusText} bởi ${fromName}`, []);

    // 3. Nếu từ Team → edit message gốc ở Group Tổng
    if (source !== 'Tổng' && tracked?.totalMsgId && total?.id) {
        const totalOriginal = tracked.orderText || '';
        await editMessage(total.id, tracked.totalMsgId,
            totalOriginal + `\n\n${statusText} bởi ${fromName} (${source})`, []
        );
    }
}

// ── Middleware xác thực Admin API ─────────────────────────────

function adminAuth(req, res, next) {
    const auth = req.headers['x-admin-secret'] || req.headers.authorization?.replace('Bearer ', '');
    if (auth !== ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ── API ENDPOINTS ─────────────────────────────────────────────

app.get('/',       (req, res) => res.json({ status: 'ok', version: '3.0.0' }));
app.get('/health', (req, res) => {
    const groups = getGroups();
    const total  = getTotalGroup();
    const teams  = getTeamGroups();
    res.json({
        status:        'healthy',
        bot_token:     BOT_TOKEN ? '✅' : '❌ MISSING',
        total_group:   total ? `✅ ${total.label} (${total.id})` : '❌ MISSING',
        team_groups:   teams.map(([k, g]) => `${k}: ${g.label} (${g.id})`),
        total_groups:  Object.keys(groups).length,
        tracked_orders: Object.keys(orderTracker).length,
    });
});

// ── ADMIN: Quản lý groups ─────────────────────────────────────

/**
 * GET /admin/groups
 * Xem tất cả groups
 */
app.get('/admin/groups', adminAuth, (req, res) => {
    res.json({ success: true, groups: getGroups() });
});

/**
 * POST /admin/groups
 * Thêm group mới
 * Body: { key, id, label, type }   type = "total" | "team"
 */
app.post('/admin/groups', adminAuth, (req, res) => {
    const { key, id, label, type } = req.body;
    if (!key || !id || !label || !type) {
        return res.status(400).json({ error: 'Cần: key, id, label, type' });
    }
    if (!['total', 'team'].includes(type)) {
        return res.status(400).json({ error: 'type phải là "total" hoặc "team"' });
    }

    const groups   = getGroups();
    groups[key]    = { id, label, type };
    saveGroups(groups);

    console.log(`➕ Group added: ${key} = ${label} (${id})`);
    res.json({ success: true, key, group: groups[key] });
});

/**
 * PUT /admin/groups/:key
 * Sửa group
 * Body: { id?, label?, type? }
 */
app.put('/admin/groups/:key', adminAuth, (req, res) => {
    const { key } = req.params;
    const groups  = getGroups();

    if (!groups[key]) {
        return res.status(404).json({ error: `Group "${key}" không tồn tại` });
    }

    const { id, label, type } = req.body;
    if (id)    groups[key].id    = id;
    if (label) groups[key].label = label;
    if (type)  groups[key].type  = type;
    saveGroups(groups);

    console.log(`✏️  Group updated: ${key}`);
    res.json({ success: true, key, group: groups[key] });
});

/**
 * DELETE /admin/groups/:key
 * Xoá group
 */
app.delete('/admin/groups/:key', adminAuth, (req, res) => {
    const { key } = req.params;
    const groups  = getGroups();

    if (!groups[key]) {
        return res.status(404).json({ error: `Group "${key}" không tồn tại` });
    }
    if (groups[key].type === 'total') {
        return res.status(400).json({ error: 'Không thể xoá Group Tổng' });
    }

    const deleted = groups[key];
    delete groups[key];
    saveGroups(groups);

    console.log(`🗑️  Group deleted: ${key}`);
    res.json({ success: true, key, deleted });
});

// ── POST /webhook/payment-review ─────────────────────────────

app.post('/webhook/payment-review', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${WEBHOOK_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const order = req.body;
        if (!order.order_number_raw) return res.status(400).json({ error: 'Missing order_number_raw' });

        const orderNumber  = order.order_number_raw;
        const paymentGroup = getPaymentGroup();

        if (!paymentGroup?.id) {
            console.warn('⚠️  Group Duyệt Thanh Toán chưa cấu hình');
            return res.status(500).json({ error: 'Payment group not configured' });
        }

        console.log(`💳 Duyệt thanh toán đơn #${orderNumber}`);

        const message   = formatPaymentMessage(order);
        const keyboard  = keyboardPayment(orderNumber);
        const messageId = await sendMessage(paymentGroup.id, message, keyboard);

        // Gửi biên lai nếu có
        const images = order.receipt_images || [];
        if (images.length > 0) {
            console.log(`🖼 ${images.length} biên lai`);
            images.length === 1
                ? await sendPhoto(paymentGroup.id, images[0])
                : await sendMediaGroup(paymentGroup.id, images);
        }

        // Lưu tracking payment
        trackOrder(orderNumber, {
            paymentMsgId:   messageId,
            paymentChatId:  paymentGroup.id,
            paymentMsgText: message,
        });

        console.log(`✅ Payment review sent — msg_id: ${messageId}`);
        res.json({ success: true, order_id: orderNumber, telegram_message_id: messageId });

    } catch (err) {
        console.error('❌ /webhook/payment-review:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── POST /webhook/new-order ───────────────────────────────────

app.post('/webhook/new-order', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${WEBHOOK_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const order = req.body;
        if (!order.order_id) return res.status(400).json({ error: 'Missing order_id' });

        // Bỏ qua đơn chưa thanh toán (on-hold hoặc pending)
        if (order.status === 'on-hold' || order.status === 'pending') {
            console.log(`⏭️  Bỏ qua đơn #${order.order_number_raw || order.order_id} — status ${order.status} (chưa thanh toán)`);
            return res.json({ success: true, skipped: true, reason: order.status });
        }

        const orderNumber = order.order_number_raw || order.order_id;
        const total       = getTotalGroup();

        if (!total?.id) {
            return res.status(500).json({ error: 'Group Tổng chưa được cấu hình' });
        }

        console.log(`📥 Đơn mới: #${orderNumber}`);

        const message   = formatOrderMessage(order, total.label);
        const keyboard  = keyboardTotal(orderNumber);
        const messageId = await sendMessage(total.id, message, keyboard);

        // Gửi hình ảnh kèm theo (nếu có)
        if (order.customer_images?.length > 0) {
            console.log(`🖼 ${order.customer_images.length} hình ảnh`);
            order.customer_images.length === 1
                ? await sendPhoto(total.id, order.customer_images[0])
                : await sendMediaGroup(total.id, order.customer_images);
        }

        // Lưu tracking (kèm customer_images để forward sang Team sau)
        trackOrder(orderNumber, {
            totalMsgId:        messageId,
            orderText:         message,
            customerImages:    order.customer_images || [],
            customerTelegram:  order.customer_telegram || '',
            customerEmail:     order.customer_email || order.customer?.email || '',
        });

        console.log(`✅ Group Tổng OK — msg_id: ${messageId} | customerTelegram="${order.customer_telegram || ''}" | customerEmail="${order.customer_email || ''}"`);
        res.json({ success: true, order_id: orderNumber, telegram_message_id: messageId });

    } catch (err) {
        console.error('❌ /webhook/new-order:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Xử lý nhóm ảnh (1 hoặc nhiều) từ Team → forward + upload WP ──
async function processPhotoGroup(fileIds, caption, fromName, teamEntry) {
    const teamLabel = teamEntry[1].label;
    const total     = getTotalGroup();
    if (!total?.id) return;

    const orderMatch  = caption.match(/#?(\d+)/);
    const orderNumber = orderMatch ? orderMatch[1] : null;

    const forwardCaption = orderNumber
        ? `🖼 *Ảnh xác nhận từ ${teamLabel}*\nĐơn #${orderNumber} — bởi ${fromName}`
        : `🖼 *Ảnh xác nhận từ ${teamLabel}* — bởi ${fromName}`;

    try {
        if (fileIds.length === 1) {
            await tgPost('sendPhoto', {
                chat_id:    total.id,
                photo:      fileIds[0],
                caption:    forwardCaption,
                parse_mode: 'Markdown',
            });
        } else {
            const media = fileIds.slice(0, 10).map((fid, idx) => ({
                type:  'photo',
                media: fid,
                ...(idx === 0 ? { caption: forwardCaption, parse_mode: 'Markdown' } : {}),
            }));
            await tgPost('sendMediaGroup', { chat_id: total.id, media });
        }
        console.log(`📸 Forward ${fileIds.length} ảnh từ ${teamLabel} → Tổng (order: ${orderNumber || 'unknown'})`);

        if (orderNumber) {
            const uploadResults = [];
            for (let i = 0; i < fileIds.length; i++) {
                try {
                    const fileUrl  = await getTelegramFileUrl(fileIds[i]);
                    const fileName = `receipt_${orderNumber}_${Date.now()}_${i + 1}.jpg`;
                    const result   = await uploadReceiptToWP(orderNumber, fileUrl, fileName, `${fromName} (${teamLabel})`);
                    uploadResults.push(result.attachment_id);
                    console.log(`✅ Auto-uploaded receipt: order #${orderNumber}, attachment #${result.attachment_id}`);
                } catch (uploadErr) {
                    console.error(`❌ Upload ảnh ${i + 1} thất bại: ${uploadErr.message}`);
                }
            }

            if (uploadResults.length > 0) {
                await sendMessage(total.id,
                    `✅ ${uploadResults.length} ảnh đơn *#${orderNumber}* đã tự động lưu vào WP`
                );
            }
            if (uploadResults.length < fileIds.length) {
                await sendMessage(total.id,
                    `⚠️ ${fileIds.length - uploadResults.length}/${fileIds.length} ảnh lưu WP thất bại cho đơn *#${orderNumber}*`
                );
            }
        }
    } catch (e) {
        console.error('❌ Forward ảnh failed:', e.message);
    }
}

// ── POST /telegram-callback ───────────────────────────────────

app.post('/telegram-callback', async (req, res) => {
    res.json({ ok: true });

    const update = req.body;

    // ── Lệnh text ─────────────────────────────────────────────
    if (update.message?.text) {
        const msg      = update.message;
        const text     = msg.text.trim();
        const fromName = msg.from?.first_name || 'Admin';
        const chatId   = String(msg.chat?.id);

        // ── /start — đăng ký chat_id của khách ───────────────
        if (text === '/start' || text.startsWith('/start ')) {
            const username = msg.from?.username;
            if (username) {
                registerTgUser(username, chatId);
                console.log(`✅ Registered tg user: @${username} → chat_id=${chatId}`);
            }
            await tgPost('sendMessage', {
                chat_id:    chatId,
                text:       '✅ Bot đã ghi nhận tài khoản của bạn. Bạn sẽ nhận được thông báo đơn hàng tại đây.',
                parse_mode: 'Markdown',
            });
            return res.json({ ok: true });
        }

        // ── /trasoat [dd/mm/yyyy] ─────────────────────────────
        const trasoatMatch = text.match(/^\/trasoat(?:\s+(\S+))?/i);
        if (trasoatMatch) {
            const teamEntry = getGroupByChatId(chatId);
            const isTeam    = teamEntry?.[1]?.type === 'team';
            const teamLabel = isTeam ? teamEntry[1].label : '';
            const title     = isTeam ? teamEntry[1].label : 'Tổng';

            let dateStr = trasoatMatch[1]; // dd/mm/yyyy hoặc undefined

            if (!dateStr) {
                // Không có ngày → hỏi lại
                await sendMessage(chatId,
                    `📅 Vui lòng nhập ngày cần tra soát:\n` +
                    `Cú pháp: \`/trasoat dd/mm/yyyy\`\n` +
                    `Ví dụ: \`/trasoat 27/02/2026\``,
                    [[
                        { text: '📅 Hôm nay',   callback_data: `rpt_today_${isTeam ? teamLabel : 'TOTAL'}` },
                        { text: '📅 Hôm qua',   callback_data: `rpt_yesterday_${isTeam ? teamLabel : 'TOTAL'}` },
                    ]]
                );
                return;
            }

            // Parse dd/mm/yyyy → YYYY-MM-DD
            const parts = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
            if (!parts) {
                await sendMessage(chatId, '❌ Định dạng ngày không hợp lệ. Dùng: `dd/mm/yyyy`');
                return;
            }
            const dd   = parts[1].padStart(2,'0');
            const mm   = parts[2].padStart(2,'0');
            const yyyy = parts[3].length === 2 ? '20' + parts[3] : parts[3];
            const isoDate = `${yyyy}-${mm}-${dd}`;

            await sendMessage(chatId, '⏳ Đang tra soát...');
            try {
                const data = await queryReport(isoDate, teamLabel);
                const report = formatReport(data, title);
                await sendMessage(chatId, report);
            } catch(e) {
                await sendMessage(chatId, `❌ Lỗi tra soát: ${e.message}`);
            }
            return;
        }

        // ── /done, /cancel, /invalid ──────────────────────────
        const cmdMatch = text.match(/^\/(done|cancel|invalid)\s+(\S+)/i);
        if (!cmdMatch) {
            return;
        }

        const action      = cmdMatch[1].toLowerCase();
        const orderNumber = cmdMatch[2];

        // Xác định nguồn
        const teamEntry = getGroupByChatId(chatId);
        const isTeam    = teamEntry?.[1]?.type === 'team';
        const source    = isTeam ? (teamEntry[1].label) : 'Tổng';

        console.log(`📝 CMD /${action} #${orderNumber} từ ${fromName} (${source})`);

        try {
            const tracked  = getTracked(orderNumber);
            const srcMsgId = isTeam ? tracked?.teamMsgId : tracked?.totalMsgId;
            await botProcessStatus(orderNumber, action, fromName, source, chatId, srcMsgId);
            await sendMessage(chatId, `✅ Bot đã cập nhật đơn *#${orderNumber}*`);
        } catch (e) {
            console.error('❌ CMD error:', e.message);
            await sendMessage(chatId, `❌ Lỗi: ${e.message}`);
        }
        return;
    }

    // ── Reply từ khách: thông tin đăng nhập mới ─────────────
    // Khi khách reply vào tin nhắn bot báo Invalid
    if (update.message?.reply_to_message && update.message?.text) {
        const msg       = update.message;
        const text      = msg.text.trim();
        const fromName  = msg.from?.first_name || 'Khách';
        const chatId    = String(msg.chat?.id);
        const replyToId = msg.reply_to_message?.message_id;

        // Tìm order có customerNotifyMsgId khớp
        const matchedEntry = Object.entries(orderTracker).find(([, t]) =>
            t.pendingCredentials && String(t.customerNotifyMsgId) === String(replyToId)
        );

        if (matchedEntry) {
            const [orderNumber, tracked] = matchedEntry;
            const total = getTotalGroup();

            console.log(`💬 Nhận credentials mới từ khách cho đơn #${orderNumber}`);

            try {
                // Lưu lên WP
                await updateCredentialsWP(orderNumber, text, fromName);

                // Xác nhận cho khách
                await tgPost('sendMessage', {
                    chat_id:             chatId,
                    text:                `✅ Đã nhận thông tin. Chúng tôi sẽ xử lý đơn *#${orderNumber}* ngay!`,
                    parse_mode:          'Markdown',
                    reply_to_message_id: msg.message_id,
                });

                // Forward về Group Tổng kèm thông tin mới
                if (total?.id) {
                    await sendMessage(total.id,
                        `🔄 *Thông tin mới từ khách*\nĐơn *#${orderNumber}* — bởi ${fromName}\n\n` +
                        `\`\`\`\n${text}\n\`\`\``,
                        [[
                            { text: `➡️ Assign lại Team`, callback_data: `reassign_${orderNumber}` }
                        ]]
                    );
                }

                // Mark không còn pending
                trackOrder(orderNumber, { pendingCredentials: false });
                console.log(`✅ Credentials updated for #${orderNumber}`);
            } catch (e) {
                console.error(`❌ Credentials update failed: ${e.message}`);
            }
            return;
        }
    }

    // ── Ảnh xác nhận từ Team: forward về Group Tổng ─────────
    // Khi thành viên Team gửi ảnh kèm caption "#ORDER_NUMBER"
    // Bot tự forward ảnh đó về Group Tổng kèm thông báo
    if (update.message?.photo) {
        const msg      = update.message;
        const fromName = msg.from?.first_name || 'Team member';
        const chatId   = String(msg.chat?.id);
        const caption  = msg.caption || '';

        // Chỉ xử lý nếu từ Group Team
        const teamEntry = getGroupByChatId(chatId);
        console.log(`📸 Photo from chatId=${chatId}, teamEntry=${JSON.stringify(teamEntry?.[1])}`);
        if (!teamEntry || teamEntry[1]?.type !== 'team') {
            console.log(`⚠️  Bỏ qua ảnh — chatId ${chatId} không phải Group Team`);
            return;
        }

        // Lấy file_id ảnh chất lượng cao nhất
        const photoArr  = msg.photo;
        const bestPhoto = photoArr[photoArr.length - 1].file_id;
        const mediaGroupId = msg.media_group_id;

        if (mediaGroupId) {
            // Nhiều ảnh album — gom vào buffer, xử lý sau khi hết ảnh
            if (!mediaGroupBuffer.has(mediaGroupId)) {
                mediaGroupBuffer.set(mediaGroupId, {
                    photos:    [],
                    caption:   '',
                    fromName,
                    teamEntry,
                    timer:     null,
                });
            }
            const buf = mediaGroupBuffer.get(mediaGroupId);
            buf.photos.push(bestPhoto);
            if (caption) buf.caption = caption; // chỉ ảnh đầu có caption

            // Reset timer mỗi khi nhận thêm ảnh
            clearTimeout(buf.timer);
            buf.timer = setTimeout(async () => {
                mediaGroupBuffer.delete(mediaGroupId);
                await processPhotoGroup(buf.photos, buf.caption, buf.fromName, buf.teamEntry);
            }, MEDIA_GROUP_DELAY);
        } else {
            // Ảnh đơn lẻ — xử lý ngay
            await processPhotoGroup([bestPhoto], caption, fromName, teamEntry);
        }
        return;
    }

    // ── Button callbacks ──────────────────────────────────────
    if (!update.callback_query) return;

    const cq       = update.callback_query;
    const data     = cq.data || '';
    const fromName = cq.from?.first_name || 'Admin';
    const chatId   = String(cq.message?.chat?.id);
    const msgId    = cq.message?.message_id;

    console.log(`📲 Button: ${data} từ ${fromName}`);

    try {

        // pay_approve / pay_disapprove — duyệt thanh toán
        const payMatch = data.match(/^pay_(approve|disapprove)_(.+)$/);
        if (payMatch) {
            const action      = payMatch[1];
            const orderNumber = payMatch[2];
            const updatedBy   = fromName;

            await answerCallback(cq.id, '⏳ Đang xử lý...');

            try {
                await approvePaymentWP(orderNumber, action, updatedBy);

                const tracked     = getTracked(orderNumber);
                const statusText  = action === 'approve'
                    ? `✅ *Đã duyệt* bởi ${fromName}`
                    : `❌ *Từ chối* bởi ${fromName}`;

                // Edit message — giữ nội dung gốc, xoá button
                const origText = tracked?.paymentMsgText || '';
                await editMessage(chatId, msgId, origText + `

${statusText}`, []);

                // Nếu approve → gửi đơn vào Group Tổng luôn
                if (action === 'approve') {
                    await sendMessage(chatId,
                        `✅ Đơn *#${orderNumber}* đã được duyệt thanh toán — chuyển sang *processing*`
                    );
                } else {
                    await sendMessage(chatId,
                        `❌ Đơn *#${orderNumber}* bị từ chối thanh toán — đã hủy`
                    );
                }

                console.log(`💳 Payment ${action}: order #${orderNumber} by ${fromName}`);
            } catch (e) {
                console.error('❌ Payment action:', e.message);
                await answerCallback(cq.id, '❌ Lỗi: ' + e.message, true);
            }
            return;
        }

        // reassign_{orderNumber} — assign lại sau khi khách cung cấp credentials mới
        const reassignMatch = data.match(/^reassign_(.+)$/);
        if (reassignMatch) {
            const orderNumber = reassignMatch[1];
            await answerCallback(cq.id, 'Chọn Team để assign');
            // Gửi lại keyboard assign
            const teams = getTeamGroups();
            const rows  = [];
            for (let i = 0; i < teams.length; i += 3) {
                rows.push(teams.slice(i, i + 3).map(([key, g]) => ({
                    text: `➡️ ${g.label}`, callback_data: `assign_${key}_${orderNumber}`
                })));
            }
            await sendMessage(chatId, `🔄 Chọn Team xử lý lại đơn *#${orderNumber}*:`, rows);
            return;
        }

        // rpt_today / rpt_yesterday — nút chọn ngày tra soát
        const rptMatch = data.match(/^rpt_(today|yesterday)_(.+)$/);
        if (rptMatch) {
            const period    = rptMatch[1];
            const teamParam = rptMatch[2]; // 'TOTAL' hoặc tên team
            const teamLabel = teamParam === 'TOTAL' ? '' : teamParam;
            const title     = teamParam === 'TOTAL' ? 'Tổng' : teamParam;

            const now  = new Date();
            if (period === 'yesterday') now.setDate(now.getDate() - 1);
            const isoDate = now.toISOString().split('T')[0];

            await answerCallback(cq.id, '⏳ Đang tra soát...');
            try {
                const data2  = await queryReport(isoDate, teamLabel);
                const report = formatReport(data2, title);
                await sendMessage(chatId, report);
            } catch(e) {
                await sendMessage(chatId, `❌ Lỗi: ${e.message}`);
            }
            return;
        }

        // assign_{key}_{orderNumber} → forward sang Team
        // Key có thể chứa '_' (vd: team_vip) nên dùng format: assign_KEY_ORDER
        // Parse: tất cả sau "assign_" và trước ORDER (order number không chứa '_')
        const assignMatch = data.match(/^assign_(.+?)_(\d+.*)$/);
        if (assignMatch) {
            const groupKey    = assignMatch[1];
            const orderNumber = assignMatch[2];
            const group       = getGroupByKey(groupKey);

            if (!group?.id) {
                await answerCallback(cq.id, `❌ Group "${groupKey}" không tồn tại hoặc chưa cấu hình`, true);
                return;
            }

            const tracked      = getTracked(orderNumber);
            let originalText   = tracked?.orderText || '';

            console.log(`🔍 assign #${orderNumber}: tracked=${!!tracked} orderText=${originalText.length} chars`);

            // Nếu không có orderText (bot restart hoặc đơn cũ) → fetch lại từ WP
            if (!originalText) {
                console.log(`🔄 Rebuilding orderText from WP for #${orderNumber}...`);
                try {
                    const wpRes = await axios.get(
                        `${WORDPRESS_URL}/wp-json/telegram-orders/v1/order/${orderNumber}`,
                        { headers: { 'Authorization': `Bearer ${WEBHOOK_SECRET}` }, timeout: 10000 }
                    );
                    const total = getTotalGroup();
                    originalText = formatOrderMessage(wpRes.data, total?.label || 'VẬN ĐƠN TỔNG');
                    trackOrder(orderNumber, { orderText: originalText });
                    console.log(`✅ Rebuilt orderText for #${orderNumber}`);
                } catch (fetchErr) {
                    console.error(`❌ Cannot rebuild orderText: ${fetchErr.message}`);
                    await answerCallback(cq.id, '❌ Không lấy được nội dung đơn từ WP.', true);
                    return;
                }
            }

            const teamMsgText = originalText.replace(getTotalGroup()?.label || 'VẬN ĐƠN TỔNG', group.label);
            const teamMsgId    = await sendMessage(group.id, teamMsgText, keyboardTeam(orderNumber));

            // Gửi ảnh đơn hàng sang Team (nếu có)
            const images = tracked?.customerImages || [];
            if (images.length > 0) {
                console.log(`🖼 Forward ${images.length} ảnh → ${group.label}`);
                images.length === 1
                    ? await sendPhoto(group.id, images[0])
                    : await sendMediaGroup(group.id, images);
            }

            trackOrder(orderNumber, {
                teamMsgId,
                teamChatId:  group.id,
                teamLabel:   group.label,
                teamMsgText, // lưu text gốc gửi sang Team để edit đúng sau này
            });

            // Edit message ở Tổng: giữ nội dung gốc, append assign info, giữ 3 nút Done/Cancel/Invalid
            const total = getTotalGroup();
            await editMessage(chatId, msgId,
                originalText + `\n\n➡️ *Đã chuyển sang ${group.label}* bởi ${fromName}`,
                [
                    [
                        { text: '✅ Done',          callback_data: `done_${orderNumber}`    },
                        { text: '❌ Invalid Login', callback_data: `invalid_${orderNumber}` },
                        { text: '🚫 Cancel',        callback_data: `cancel_${orderNumber}`  },
                    ],
                ]
            );

            await answerCallback(cq.id, `✅ Đã chuyển sang ${group.label}`);
            console.log(`✅ #${orderNumber} → ${group.label}`);
            return;
        }

        // team_done / team_invalid / team_cancel
        const teamActionMatch = data.match(/^team_(done|invalid|cancel)_(.+)$/);
        if (teamActionMatch) {
            const action      = teamActionMatch[1];
            const orderNumber = teamActionMatch[2];
            const tracked     = getTracked(orderNumber);

            // Lấy teamLabel từ chatId (chính xác hơn tracker cho đơn cũ)
            const teamEntryBtn = getGroupByChatId(chatId);
            const resolvedTeamLabel = teamEntryBtn?.[1]?.label || tracked?.teamLabel || 'Team';

            await answerCallback(cq.id, '⏳ Bot đang xử lý...');

            try {
                await botProcessStatus(
                    orderNumber, action, fromName,
                    resolvedTeamLabel,
                    chatId, msgId
                );
            } catch (e) {
                await answerCallback(cq.id, '❌ Lỗi WP: ' + e.message, true);
            }
            return;
        }

        // upr_{orderNumber}_{idx} — admin bấm "📤 Upload lên WP"
        // callback_data ngắn (< 64 bytes): fileId lưu trong tracker theo index
        const uploadMatch = data.match(/^upr_([^_]+)_(\d+)$/);
        if (uploadMatch) {
            const orderNumber = uploadMatch[1];
            const idx         = parseInt(uploadMatch[2], 10);
            const uploadedBy  = `${fromName} (Telegram)`;

            await answerCallback(cq.id, '⏳ Đang upload...');

            try {
                const tracked      = getTracked(orderNumber);
                const pendingList  = tracked?.pendingReceipts || [];
                const receiptEntry = pendingList[idx];

                if (!receiptEntry) {
                    await sendMessage(chatId, `❌ Không tìm thấy ảnh (idx: ${idx}). Server có thể đã restart.`);
                    return;
                }

                const fileUrl  = await getTelegramFileUrl(receiptEntry.fileId);
                const fileName = `receipt_${orderNumber}_${Date.now()}.jpg`;
                const result   = await uploadReceiptToWP(orderNumber, fileUrl, fileName, uploadedBy);

                await tgPost('editMessageReplyMarkup', {
                    chat_id:      chatId,
                    message_id:   msgId,
                    reply_markup: { inline_keyboard: [] },
                });

                await sendMessage(chatId,
                    `✅ *Đã upload ảnh lên WP*\nĐơn *#${orderNumber}* — attachment #${result.attachment_id}`
                );
                console.log(`✅ Receipt uploaded: order #${orderNumber}, idx ${idx}, attachment #${result.attachment_id}`);
            } catch (e) {
                console.error('❌ Upload receipt:', e.message);
                await sendMessage(chatId, `❌ Upload thất bại: ${e.message}`);
            }
            return;
        }

        // done / invalid / cancel từ Group Tổng
        const totalActionMatch = data.match(/^(done|invalid|cancel)_(.+)$/);
        if (totalActionMatch) {
            const action      = totalActionMatch[1];
            const orderNumber = totalActionMatch[2];

            await answerCallback(cq.id, '⏳ Bot đang xử lý...');

            try {
                await botProcessStatus(orderNumber, action, fromName, 'Tổng', chatId, msgId);
            } catch (e) {
                await answerCallback(cq.id, '❌ Lỗi WP: ' + e.message, true);
            }
            return;
        }

    } catch (err) {
        console.error('❌ /telegram-callback:', err.message);
        if (err.response?.data) {
            console.error('   Telegram error:', JSON.stringify(err.response.data));
        }
        if (update?.callback_query?.data) {
            console.error('   callback_data:', update.callback_query.data);
        }
    }
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
    const total  = getTotalGroup();
    const teams  = getTeamGroups();

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚀 Telegram Bot Server v3.0');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🌐 Port          : ${PORT}`);
    console.log(`🤖 Bot Token     : ${BOT_TOKEN ? '✅' : '❌ MISSING'}`);
    console.log(`📡 Group Tổng    : ${total ? `✅ ${total.label} (${total.id})` : '❌ MISSING'}`);
    console.log(`👥 Team groups   : ${teams.length > 0 ? teams.map(([k, g]) => g.label).join(', ') : '⚠️  none'}`);
    console.log(`📋 Groups file   : ${GROUPS_FILE}`);
    console.log(`📋 Tracked orders: ${Object.keys(orderTracker).length}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📡 Admin API (cần X-Admin-Secret header):');
    console.log(`   GET    /admin/groups`);
    console.log(`   POST   /admin/groups       { key, id, label, type }`);
    console.log(`   PUT    /admin/groups/:key  { id?, label?, type? }`);
    console.log(`   DELETE /admin/groups/:key`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

// setWebhook chạy sau khi server đã bind xong (tránh crash trong listen callback)
setTimeout(async () => {
    try {
        const webhookUrl = `${process.env.WEBHOOK_URL || 'https://demo.buffupnow.com'}/telegram-callback`;
        await tgPost('setWebhook', { url: webhookUrl, allowed_updates: ['message', 'callback_query', 'channel_post'] });
        console.log(`🔗 Webhook set: ${webhookUrl}`);
    } catch (e) {
        console.warn('⚠️  setWebhook failed:', e.message);
    }
}, 2000);

// Giữ process sống, bắt lỗi không xử lý
process.on('uncaughtException',  (err) => console.error('💥 Uncaught:', err.message));
process.on('unhandledRejection', (err) => console.error('💥 Unhandled:', err?.message || err));
