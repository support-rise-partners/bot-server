import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { MicrosoftAppCredentials } from 'botframework-connector';

const TEMP_DIR = path.resolve('tmp_attachments');
const IMAGES_DIR = path.join(TEMP_DIR, 'images');
const DOCS_DIR = path.join(TEMP_DIR, 'docs');

function ensureDir(dirPath) {
    try { if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true }); } catch {}
}

const FILE_LIFETIME_MINUTES = 15;
const SERVER_HOST = process.env.SERVER_HOST;

if (!SERVER_HOST) {
    console.warn('⚠️ SERVER_HOST is not set. Public URLs for attachments may be invalid.');
    console.warn('⚠️ Expected public routes: /tmp/images/* and /tmp/docs/*');
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

function cleanUpOldFiles({ maxAgeMinutes = FILE_LIFETIME_MINUTES, targetDir = null } = {}) {
    const dir = targetDir || TEMP_DIR;
    try { ensureDir(dir); } catch {}
    const now = Date.now();
    let removed = 0;
    for (const file of fs.readdirSync(dir)) {
        const filePath = path.join(dir, file);
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
    if (__attachmentsCleanupTimer) return; // already active
    ensureDir(TEMP_DIR);
    ensureDir(IMAGES_DIR);
    ensureDir(DOCS_DIR);
    __attachmentsCleanupTimer = setInterval(() => {
        try {
            const removedImg = cleanUpOldFiles({ maxAgeMinutes, targetDir: IMAGES_DIR });
            const removedDoc = cleanUpOldFiles({ maxAgeMinutes, targetDir: DOCS_DIR });
            // Optional: console.debug(`[attachments] cleanup removed images:${removedImg}, docs:${removedDoc}`);
        } catch (e) {
            console.warn('[attachments] cleanup error:', e?.message || e);
        }
    }, Math.max(1, intervalMinutes) * 60 * 1000);
}

function saveFileToTmp(buffer, { extension = 'bin', originalName = '', contentType = '', kind = 'auto' } = {}) {
    ensureDir(TEMP_DIR);
    ensureDir(IMAGES_DIR);
    ensureDir(DOCS_DIR);

    // 1) Normalize and sanitize extension
    let safeExt = (extension || 'bin').toString().replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!safeExt) safeExt = 'bin';

    // 2) Decide kind (image/doc)
    let targetKind = kind;
    if (targetKind === 'auto') {
        const isImg = (contentType || '').toLowerCase().startsWith('image/') || isImageByExt(safeExt);
        targetKind = isImg ? 'image' : 'doc';
    }

    const dir = targetKind === 'image' ? IMAGES_DIR : DOCS_DIR;
    const publicSub = targetKind === 'image' ? 'tmp/images' : 'tmp/docs';
    ensureDir(dir);

    // 3) Build filename
    // For documents: prefer original name; for images: keep uuid to stay short/stable
    const buildSanitizedBase = (name) => {
        if (!name) return '';
        // remove extension from original name if present
        const base = name.replace(/\.[^.]+$/, '');
        // Normalize unicode and strip diacritics, keep ascii letters, numbers, dash, underscore and dots/spaces converted to underscores
        const ascii = base.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        const replaced = ascii.replace(/[^a-zA-Z0-9._-]+/g, '_');
        // collapse multiple underscores and trim
        const collapsed = replaced.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
        // lower-case and limit length
        return collapsed.toLowerCase().slice(0, 80) || 'datei';
    };

    let fileBase;
    if (targetKind === 'doc') {
        fileBase = buildSanitizedBase(originalName);
    } else {
        // images: use uuid to avoid very long names and caching issues
        fileBase = uuidv4();
    }

    let fileName = `${fileBase}.${safeExt}`;
    let filePath = path.join(dir, fileName);

    // 4) Ensure uniqueness (append short uuid if already exists)
    if (fs.existsSync(filePath)) {
        const shortId = uuidv4().slice(0, 8);
        fileName = `${fileBase}-${shortId}.${safeExt}`;
        filePath = path.join(dir, fileName);
    }

    // 5) Write file and sidecar meta
    fs.writeFileSync(filePath, buffer);

    const meta = {
        id: uuidv4(),
        storedName: fileName,
        originalName: originalName || null,
        contentType: contentType || null,
        extension: safeExt,
        kind: targetKind,
        createdAt: new Date().toISOString()
    };
    try { fs.writeFileSync(`${filePath}.json`, JSON.stringify(meta)); } catch {}

    // 6) Return public URL (filenames are ascii-safe)
    return `${SERVER_HOST}/${publicSub}/${fileName}`;
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

        // 3) Сохраняем файл в соответствующую подпапку
        const isImg = ct.startsWith('image/') || isImageByExt(extension);
        const publicUrl = saveFileToTmp(fileBuffer, { extension, originalName: name, contentType: ct, kind: isImg ? 'image' : 'doc' });

        // 4) Классифицируем: изображение → в imageUrls, остальные → в fileNotices
        if (isImg) {
            imageUrls.push(publicUrl);
        } else {
            fileNotices.push(`Angehängte Datei im Format .${extension}. Dateiname: ${path.basename(publicUrl)}`);
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