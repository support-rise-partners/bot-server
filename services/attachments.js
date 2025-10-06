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

function saveImageToTmp(buffer, extension = 'png') {
    const fileName = `${uuidv4()}.${extension}`;
    const filePath = path.join(TEMP_DIR, fileName);
    fs.writeFileSync(filePath, buffer);
    return `${SERVER_HOST}/tmp/${fileName}`;
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
        let fileBuffer;
        let extension = 'png';

        if ((attachment.contentType || '').toLowerCase().startsWith('image/')) {
            const ct = (attachment.contentType || '').toLowerCase();
            const tryDownloadUrl = attachment.content?.downloadUrl;

            if (tryDownloadUrl) {
                fileBuffer = await fetchDirect(tryDownloadUrl);
                extension = (ct.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
            } else if (attachment.contentUrl) {
                fileBuffer = await fetchWithBotToken(attachment.contentUrl);
                extension = (ct.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
            } else {
                continue;
            }
        } else if (attachment.content?.downloadUrl && attachment.name?.match(/\.(png|jpe?g|gif|bmp|webp)$/i)) {
            fileBuffer = await fetchDirect(attachment.content.downloadUrl);
            const rawExt = path.extname(attachment.name).slice(1).toLowerCase();
            const allowedExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
            extension = allowedExts.includes(rawExt) ? rawExt : 'png';
        } else if (attachment.name && !(attachment.contentType || '').toLowerCase().startsWith('image/')) {
            const ext = path.extname(attachment.name);
            fileNotices.push(`angehängte Datei: ${attachment.name} (Format ${ext})`);
            continue;
        } else {
            continue;
        }

        const publicUrl = saveImageToTmp(fileBuffer, extension);
        imageUrls.push(publicUrl);
    }

    return { imageUrls, fileNotices };
}