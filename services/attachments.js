import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { MicrosoftAppCredentials } from 'botframework-connector';

const TEMP_DIR = path.resolve('tmp_attachments');
const FILE_LIFETIME_MINUTES = 15;
const SERVER_HOST = process.env.SERVER_HOST;

function cleanUpOldFiles() {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
    const now = Date.now();
    for (const file of fs.readdirSync(TEMP_DIR)) {
        const filePath = path.join(TEMP_DIR, file);
        const stats = fs.statSync(filePath);
        const ageMinutes = (now - stats.mtimeMs) / 60000;
        if (ageMinutes > FILE_LIFETIME_MINUTES) fs.unlinkSync(filePath);
    }
}

function saveToTmp(buffer, extension = 'bin') {
    const safeExt = (extension || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    const fileName = `${uuidv4()}.${safeExt}`;
    const filePath = path.join(TEMP_DIR, fileName);
    fs.writeFileSync(filePath, buffer);
    return `${SERVER_HOST}/tmp/${fileName}`;
}

function extFromContentType(ct = '') {
    const type = ct.toLowerCase();
    if (type.startsWith('image/')) return type.split('/')[1] || 'png';
    if (type === 'application/pdf') return 'pdf';
    if (type === 'application/msword') return 'doc';
    if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
    return '';
}

function extFromName(name = '') {
    const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
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
    if (!attachments.length) return { imageUrls: [], docUrls: [], fileNotices: [] };

    cleanUpOldFiles();

    const imageUrls = [];
    const docUrls = [];

    for (const attachment of attachments) {
        const ct = (attachment.contentType || '').toLowerCase();
        const name = attachment.name || '';
        let buffer = null;
        let extension = '';

        const isImage = ct.startsWith('image/');
        const isPdf = ct === 'application/pdf' || /\.pdf$/i.test(name || '');
        const isDoc = ct === 'application/msword' || /\.doc$/i.test(name || '');
        const isDocx = ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(name || '');
        const needsAuthFetch = !!attachment.contentUrl; 
        const hasPublicDownload = !!attachment.content?.downloadUrl;

        try {
            if (isImage) {
                buffer = needsAuthFetch
                    ? await fetchWithBotToken(attachment.contentUrl)
                    : hasPublicDownload
                        ? await fetchDirect(attachment.content.downloadUrl)
                        : null;
                extension = extFromContentType(ct) || extFromName(name) || 'png';
                if (!buffer) continue;
                imageUrls.push(saveToTmp(buffer, extension));
                continue;
            }

            if (isPdf || isDoc || isDocx) {
                buffer = needsAuthFetch
                    ? await fetchWithBotToken(attachment.contentUrl)
                    : hasPublicDownload
                        ? await fetchDirect(attachment.content.downloadUrl)
                        : null;
                extension = extFromContentType(ct) || extFromName(name) || (isPdf ? 'pdf' : isDocx ? 'docx' : 'doc');
                if (!buffer) {
                    fileNotices.push(`Anhang konnte nicht geladen werden: ${name || '(unbenannt)'}`);
                    continue;
                }
                docUrls.push(saveToTmp(buffer, extension));
                fileNotices.push(`gespeicherte Datei: ${name || '(unbenannt)'} (Format .${extension})`);
                continue;
            }

            if (name && !isImage) {
                const ext = path.extname(name);
                fileNotices.push(`angehängte Datei: ${name} (Format ${ext})`);
                continue;
            }
        } catch (e) {
            fileNotices.push(`Fehler beim Verarbeiten von ${name || '(unbenannt)'}: ${e?.message || e}`);
        }
    }

    return { imageUrls, docUrls, fileNotices };
}