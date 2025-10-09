import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { MicrosoftAppCredentials } from 'botframework-connector';

const TEMP_DIR = path.resolve('tmp_attachments');
const FILE_LIFETIME_MINUTES = 15;
const SERVER_HOST = process.env.SERVER_HOST;

if (!SERVER_HOST) {
    console.warn('⚠️ SERVER_HOST is not set. Public URLs for attachments may be invalid.');
}

const ALLOWED_MIME = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.microsoft.teams.file.download.info',
    'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp'
]);

function shouldProcessAttachment(att) {
    const ct = (att?.contentType || '').toLowerCase();
    if (!ct) return false;
    if (ct.startsWith('image/')) return true;
    if (ALLOWED_MIME.has(ct)) return true;
    // Teams schickt manchmal text/html, Karten etc. – die ignorieren wir still
    if (ct.startsWith('text/html')) return false;
    if (ct.startsWith('application/vnd.microsoft.card')) return false;
    return false;
}

function safeStat(p) {
    try { return fs.statSync(p); }
    catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}

function safeUnlink(p) {
    try { fs.unlinkSync(p); }
    catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
}

function cleanUpOldFiles({ maxAgeMinutes = FILE_LIFETIME_MINUTES } = {}) {
    try { if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch {}
    const now = Date.now();
    let removed = 0;
    for (const file of fs.readdirSync(TEMP_DIR)) {
        const filePath = path.join(TEMP_DIR, file);
        const st = safeStat(filePath);
        if (!st || !st.isFile()) continue;
        const ageMinutes = (now - st.mtimeMs) / 60000;
        if (ageMinutes > maxAgeMinutes) {
            safeUnlink(filePath);
            const sidecar = `${filePath}.json`;
            if (safeStat(sidecar)) safeUnlink(sidecar);
            removed++;
        }
    }
    return removed;
}

let __attachmentsCleanupTimer = null;

export function startAttachmentsHousekeeping({ intervalMinutes = 5, maxAgeMinutes = FILE_LIFETIME_MINUTES } = {}) {
    if (__attachmentsCleanupTimer) return; // bereits aktiv
    try { if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch {}
    __attachmentsCleanupTimer = setInterval(() => {
        try {
            const removed = cleanUpOldFiles({ maxAgeMinutes });
            // Optional: console.debug(`[attachments] cleanup removed ${removed} files`);
        } catch (e) {
            console.warn('[attachments] cleanup error:', e?.message || e);
        }
    }, Math.max(1, intervalMinutes) * 60 * 1000);
}

function saveFileToTmp(buffer, { extension = 'bin', originalName = '', contentType = '' } = {}) {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
    const safeExt = (extension || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    const fileId = uuidv4();
    const fileName = `${fileId}.${safeExt}`;
    const filePath = path.join(TEMP_DIR, fileName);
    fs.writeFileSync(filePath, buffer);

    // сохраняем метаданные рядом, чтобы потом можно было корректно чистить/аудитить
    const meta = {
        id: fileId,
        originalName: originalName || null,
        contentType: contentType || null,
        extension: safeExt,
        createdAt: new Date().toISOString()
    };
    try { fs.writeFileSync(`${filePath}.json`, JSON.stringify(meta)); } catch {}

    return `${SERVER_HOST}/tmp/${fileName}`;
}

function extFromContentType(ct = '') {
    const map = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/bmp': 'bmp',
        'application/pdf': 'pdf',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-excel': 'xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'text/plain': 'txt'
    };
    ct = (ct || '').toLowerCase();
    return map[ct] || '';
}

function isImageByExt(ext = '') {
    return ['png','jpg','jpeg','gif','bmp','webp'].includes(String(ext).toLowerCase());
}

async function fetchWithBotToken(url) {
    const credentials = new MicrosoftAppCredentials(
        process.env.MicrosoftAppId,
        process.env.MicrosoftAppPassword
    );
    const token = await credentials.getToken();
    const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'arraybuffer'
    });
    return Buffer.from(response.data, 'binary');
}

async function fetchDirect(url) {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data, 'binary');
}

export async function extractImagesFromContext(context) {
    const fileNotices = [];
    const attachments = context.activity?.attachments || [];
    if (!attachments.length) return { imageUrls: [], fileNotices: [] };

    const imageUrls = [];

    for (const attachment of attachments) {
        const ct = (attachment.contentType || '').toLowerCase();
        if (!shouldProcessAttachment(attachment)) {
            // Ignoriere nicht-Datei-Anhänge wie text/html, Karten etc.
            continue;
        }

        let fileBuffer = null;
        let extension = '';
        const name = attachment.name || '';

        // 1) Скачиваем бинарь (с приоритетом на прямую загрузку)
        try {
            if (attachment.content?.downloadUrl) {
                fileBuffer = await fetchDirect(attachment.content.downloadUrl);
            } else if (attachment.contentUrl) {
                fileBuffer = await fetchWithBotToken(attachment.contentUrl);
            } else {
                // иногда боты присылают contentUrl в content.links[0]
                const maybeUrl = attachment.content?.contentUrl || attachment.content?.url;
                if (maybeUrl) fileBuffer = await fetchDirect(maybeUrl);
            }
        } catch (e) {
            fileNotices.push(`angehängte Datei konnte nicht geladen werden: ${name || '(unbenannt)'} (${ct || 'unknown'})`);
            continue;
        }
        if (!fileBuffer) {
            fileNotices.push(`angehängte Datei konnte nicht geladen werden: ${name || '(unbenannt)'} (${ct || 'unknown'})`);
            continue;
        }

        // 2) Определяем расширение по contentType или имени файла
        const byCt = extFromContentType(ct);
        const byName = path.extname(name).replace('.', '').toLowerCase();
        extension = byCt || byName || 'bin';

        // 3) Сохраняем файл единым способом
        const publicUrl = saveFileToTmp(fileBuffer, { extension, originalName: name, contentType: ct });

        // 4) Классифицируем: изображение → в imageUrls, остальные → в fileNotices
        if (ct.startsWith('image/') || isImageByExt(extension)) {
            imageUrls.push(publicUrl);
        } else {
            fileNotices.push(`angehängte Datei: ${name || '(unbenannt)'} (Format .${extension}) Link: ${publicUrl}`);
        }
    }

    return { imageUrls, fileNotices };
}

if (!globalThis.__attachmentsCleanupStarted) {
    try {
        startAttachmentsHousekeeping({ intervalMinutes: 5, maxAgeMinutes: FILE_LIFETIME_MINUTES });
        globalThis.__attachmentsCleanupStarted = true;
    } catch {}
}