import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { adapter } from './bot/adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import 'dotenv/config';
import { MyBot } from './bot/bot.js';
import notifyUser from './functions/notify_user.js';
import { startExternalWeeklyScheduler } from './services/blobExportService/sitesExport.js';

console.log('AZURE_OPENAI_ENDPOINT =', process.env.AZURE_OPENAI_ENDPOINT);

const app = express().use(express.json());
app.use(express.static(__dirname + '/public'));
app.use('/tmp', express.static(__dirname + '/tmp_attachments'));

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