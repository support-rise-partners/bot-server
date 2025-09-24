import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import dotenv from 'dotenv';
dotenv.config();
import fetch from 'node-fetch';
import { TableClient } from "@azure/data-tables";

const client = TableClient.fromConnectionString(
    process.env.AZURE_STORAGE_CONNECTION_STRING,
    "ChatHistory"
);

try {
    await client.createTable();
} catch (error) {
    console.error("Fehler beim Erstellen der Tabelle:", error.message);
}

const referenceClient = TableClient.fromConnectionString(
    process.env.AZURE_STORAGE_CONNECTION_STRING,
    "ConversationReferences"
);

try {
    await referenceClient.createTable();
} catch (error) {
    console.error("Fehler beim Erstellen der Referenztabelle:", error.message);
}

async function saveMessage(sessionId, role, message) {
    try {
        const entity = {
            partitionKey: sessionId,
            rowKey: Date.now().toString(),
            role,
            message
        };
        await client.createEntity(entity);
    } catch (error) {
        console.error("Fehler beim Speichern der Nachricht:", error.message);
    }
}

const MESSAGE_HISTORY_WINDOW_MINUTES = 20;

async function getLastMessages(sessionId, limit = 40) {
    try {
        const sinceTimestamp = Date.now() - MESSAGE_HISTORY_WINDOW_MINUTES * 60 * 1000;
        const entities = client.listEntities({
            queryOptions: {
                filter: `PartitionKey eq '${sessionId}' and RowKey ge '${sinceTimestamp}'`
            }
        });

        const results = [];
        for await (const entity of entities) {
            results.push({
                role: entity.role,
                message: entity.message,
                timestamp: entity.rowKey
            });
        }

        results.sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp));
        return results.slice(-limit);
    } catch (error) {
        console.error("Fehler beim Abrufen der Nachrichten:", error.message);
        return [];
    }
}

export { saveMessage, getLastMessages };