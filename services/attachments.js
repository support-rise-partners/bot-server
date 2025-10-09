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

function cleanUpOldFiles() {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
    const now = Date.now();
    for (const file of fs.readdirSync(TEMP_DIR)) {
        const filePath = path.join(TEMP_DIR, file);
        const stats = fs.statSync(filePath);
        const ageMinutes = (now - stats.mtimeMs) / 60000;
        if (ageMinutes > FILE_LIFETIME_MINUTES) {
            try { fs.unlinkSync(filePath); } catch {}
            try { fs.unlinkSync(`${filePath}.json`); } catch {}
        }
    }
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

    cleanUpOldFiles();

    const imageUrls = [];

    for (const attachment of attachments) {
        let fileBuffer = null;
        let extension = '';
        const name = attachment.name || '';
        const ct = (attachment.contentType || '').toLowerCase();

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