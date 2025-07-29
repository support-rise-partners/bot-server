import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { MicrosoftAppCredentials } from 'botframework-connector';

const TEMP_DIR = path.resolve('tmp_attachments');
const FILE_LIFETIME_MINUTES = 15;
const SERVER_HOST = process.env.SERVER_HOST;

/**
 * Очищает временную директорию от старых файлов (старше 15 мин)
 */
function cleanUpOldFiles() {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

    const now = Date.now();
    for (const file of fs.readdirSync(TEMP_DIR)) {
        const filePath = path.join(TEMP_DIR, file);
        const stats = fs.statSync(filePath);
        const ageMinutes = (now - stats.mtimeMs) / 60000;
        if (ageMinutes > FILE_LIFETIME_MINUTES) {
            fs.unlinkSync(filePath);
        }
    }
}

/**
 * Сохраняет изображение в tmp и возвращает URL
 */
function saveImageToTmp(buffer, extension = 'png') {
    const fileName = `${uuidv4()}.${extension}`;
    const filePath = path.join(TEMP_DIR, fileName);
    fs.writeFileSync(filePath, buffer);
    return `${SERVER_HOST}/tmp/${fileName}`;
}

/**
 * Главная функция: извлекает и сохраняет изображения из context
 */
export async function extractImagesFromContext(context) {
    const fileNotices = [];
    const attachments = context.activity?.attachments || [];
    if (!attachments.length) return { imageUrls: [], fileNotices: [] };

    cleanUpOldFiles(); // очищаем старые перед началом

    const imageUrls = [];

    for (const attachment of attachments) {
        let fileBuffer;
        let extension = 'png';
        try {
            const isInlineImage = attachment.contentType?.startsWith('image/');
            const isUploadedImage = attachment.content?.downloadUrl;

            if (!isInlineImage && !isUploadedImage) {
                if (attachment.name && !attachment.contentType?.startsWith("image/")) {
                    const ext = path.extname(attachment.name);
                    fileNotices.push(`angehängte Datei: ${attachment.name} (Format ${ext})`);
                }
                continue;
            }

            if (isInlineImage) {
                const credentials = new MicrosoftAppCredentials(
                    process.env.MicrosoftAppId,
                    process.env.MicrosoftAppPassword
                );
                const token = await credentials.getToken();

                const response = await axios.get(attachment.contentUrl, {
                    headers: { Authorization: `Bearer ${token}` },
                    responseType: 'arraybuffer'
                });

                fileBuffer = Buffer.from(response.data, 'binary');
                extension = attachment.contentType.split('/')[1] || 'png';
            } else if (isUploadedImage) {
                const response = await axios.get(attachment.content.downloadUrl, {
                    responseType: 'arraybuffer'
                });
                fileBuffer = Buffer.from(response.data, 'binary');

                const rawExt = path.extname(attachment.name || '').slice(1).toLowerCase();
                const allowedExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
                extension = allowedExts.includes(rawExt) ? rawExt : (attachment.contentType?.split('/')[1] || 'png');
            }

            const publicUrl = saveImageToTmp(fileBuffer, extension);
            imageUrls.push(publicUrl);
        } catch (err) {
            console.warn("Fehler beim Verarbeiten eines Anhangs:", err.message);
            continue;
        }
    }

    return { imageUrls, fileNotices };
}