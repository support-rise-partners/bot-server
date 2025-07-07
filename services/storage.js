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

async function saveConversationReference(reference) {
    try {
        console.log("📥 Eingehende Referenz:", JSON.stringify(reference, null, 2));
        const userId = reference?.user?.id || "";
        const aadObjectId = reference?.user?.aadObjectId;
        const conversationId = reference?.conversation?.id || "";
        const conversationType = reference?.conversation?.conversationType;
        if (conversationType !== "personal") {
            console.log("⏩ Nicht-personales Gespräch erkannt – Referenz wird nicht gespeichert.");
            return;
        }
        const serviceUrl = reference?.serviceUrl || "";

        let userNameResolved = undefined;
        const token = process.env.BEARER_TOKEN;

        if (!userNameResolved && aadObjectId) {
            try {
                const response = await fetch(`https://graph.microsoft.com/v1.0/users/${aadObjectId}`, {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                });

                if (response.ok) {
                    const user = await response.json();
                    userNameResolved = user?.userPrincipalName || user?.mail || user?.displayName || aadObjectId;
                    console.log("✅ Benutzername über Graph API erhalten:", userNameResolved);
                } else {
                    console.error("❌ Fehler beim Abrufen des Benutzernamens von Graph API:", response.statusText);
                }
            } catch (err) {
                console.error("❌ Ausnahme beim Abrufen des Benutzernamens von Graph API:", err.message);
            }
        }
        if (!userNameResolved) {
            userNameResolved = aadObjectId || userId;
        }

        console.log("📌 Extrahierte Felder:", {
            userName: userNameResolved,
            serviceUrl,
            conversationId,
            aadObjectId
        });

        const cleanedReference = JSON.stringify(reference, (key, value) => {
            if (typeof value === 'function' || typeof value === 'symbol') return undefined;
            if (key.startsWith('_')) return undefined;
            return value;
        });

        const entity = {
            partitionKey: "Conversation",
            rowKey: userNameResolved.toLowerCase(),
            reference: cleanedReference,
            serviceUrl,
            conversationId,
            aadObjectId
        };

        await referenceClient.upsertEntity(entity, "Merge");
    } catch (error) {
        console.error("Fehler beim Speichern der Referenz:", error.message);
    }
}

async function getConversationReferenceById(userId) {
    try {
        const normalizedUserId = userId.toLowerCase();
        const entity = await referenceClient.getEntity("Conversation", normalizedUserId);
        return {
            reference: JSON.parse(entity.reference),
            serviceUrl: entity.serviceUrl,
            conversationId: entity.conversationId,
            userId: entity.userId
        };
    } catch (error) {
        console.error(`Fehler beim Abrufen der Referenz für ${userId}:`, error.message);
        return null;
    }
}

const MESSAGE_HISTORY_WINDOW_MINUTES = 15;

async function getLastMessages(sessionId, limit = 20) {
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

export { saveMessage, getLastMessages, saveConversationReference, getConversationReferenceById };