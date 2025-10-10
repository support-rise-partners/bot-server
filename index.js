import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import path from 'path';
import { adapter } from './bot/adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import 'dotenv/config';
import { MyBot } from './bot/bot.js';
import notifyUser from './functions/notify_user.js';
import { startExternalWeeklyScheduler } from './services/blobExportService/sitesExport.js';

const app = express().use(express.json());
app.use(express.static(__dirname + '/public'));
// Ensure temp subfolders exist
const TMP_ROOT = path.join(__dirname, 'tmp_attachments');
const TMP_IMAGES = path.join(TMP_ROOT, 'images');
const TMP_DOCS = path.join(TMP_ROOT, 'docs');
try {
  fs.mkdirSync(TMP_IMAGES, { recursive: true });
  fs.mkdirSync(TMP_DOCS, { recursive: true });
} catch {}

app.use('/tmp/images', express.static(TMP_IMAGES, { maxAge: '1h', index: false }));
// No public route for /tmp/docs — remains private

const myBot = new MyBot();

app.post('/api/messages', (req, res) => {
    adapter.processActivity(req, res, async (context) => {
        await myBot.run(context);
    });
});

app.post('/api/notify_user', async (req, res) => {
    await notifyUser(req, res);
});

const port = process.env.PORT || 3978;
startExternalWeeklyScheduler();
app.listen(port, () => console.log(`Bot is running on port ${port}`));