import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import dotenv from 'dotenv';
dotenv.config();
import fetch from 'node-fetch';
import { TableClient } from "@azure/data-tables";
import cron from 'node-cron';

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

// Aufbewahrungsdauer der Chat-Historie (in Minuten); Standard: 24 Stunden
const CHAT_HISTORY_RETENTION_MINUTES = parseInt(
    process.env.CHAT_HISTORY_RETENTION_MINUTES || String(24 * 60),
    10
);

/**
 * Löscht alte Nachrichten aus der Tabelle "ChatHistory".
 * Es werden alle Einträge mit RowKey (Millisekunden-Timestamp) kleiner als dem Stichtag gelöscht.
 */
async function purgeOldMessages() {
    const cutoff = Date.now() - CHAT_HISTORY_RETENTION_MINUTES * 60 * 1000;
    const cutoffStr = String(cutoff);
    let removed = 0;

    try {
        const entities = client.listEntities({
            queryOptions: {
                // globaler Filter über alle Partitionen: alles löschen, was älter ist
                filter: `RowKey lt '${cutoffStr}'`
            }
        });

        for await (const entity of entities) {
            try {
                await client.deleteEntity(entity.partitionKey, entity.rowKey);
                removed++;
            } catch (err) {
                console.error("Fehler beim Löschen eines Eintrags:", err.message);
            }
        }

        console.log(`Bereinigung abgeschlossen: ${removed} alte Nachricht(en) entfernt (Stichtag: ${new Date(cutoff).toISOString()}).`);
    } catch (error) {
        console.error("Fehler bei der Bereinigung der Chat-Historie:", error.message);
    }
}

/**
 * Plant eine nächtliche Bereinigung um 03:30 Europe/Berlin.
 * Zeitplan kann über ENV TZ (Standard: Europe/Berlin) beeinflusst werden.
 */
function startNightlyCleanup() {
    const tz = process.env.TZ || 'Europe/Berlin';
    // Sekunden Minute Stunde Tag Monat Wochentag
    cron.schedule('0 30 3 * * *', async () => {
        console.log("Starte nächtliche Bereinigung der Chat-Historie …");
        await purgeOldMessages();
    }, { timezone: tz });
    console.log(`⏰ Nächtliche Bereinigung der Chat-Historie geplant: täglich 03:30 (${tz}). Aufbewahrung: ${CHAT_HISTORY_RETENTION_MINUTES} Minuten.`);
}

// Scheduler direkt aktivieren, sobald dieses Modul geladen wird
startNightlyCleanup();

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

        // Оставляем только три последние system-сообщения, сохраняя хронологический порядок всей ленты
        const systemMessages = results.filter(m => m.role === 'system');
        const lastSystemMessages = systemMessages.slice(-3);
        const allowedSystemTimestamps = new Set(lastSystemMessages.map(m => m.timestamp));

        // Фильтруем исходный уже отсортированный список: пропускаем все non-system и только разрешённые system
        const filtered = results.filter(m => m.role !== 'system' || allowedSystemTimestamps.has(m.timestamp));

        return filtered.slice(-limit);
    } catch (error) {
        console.error("Fehler beim Abrufen der Nachrichten:", error.message);
        return [];
    }
}

export { saveMessage, getLastMessages, purgeOldMessages, startNightlyCleanup };