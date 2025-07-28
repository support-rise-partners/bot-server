import { TurnContext } from 'botbuilder';
import { TableClient } from "@azure/data-tables";
import { getUserDataById, getUserInfoByEmail } from './graphClient.js';

const referenceClient = TableClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING,
  "ConversationReferences"
);

/**
 * Speichert oder aktualisiert ConversationReference für den Benutzer.
 * @param {TurnContext} context
 */
export async function saveOrUpdateReference(context) {
  const reference = TurnContext.getConversationReference(context.activity);
  const aadObjectId = context.activity.from?.aadObjectId;

  if (!aadObjectId || context.activity.conversation?.conversationType !== 'personal') return;

  try {
    const { displayName, email } = await getUserDataById(aadObjectId);

    const entity = {
      partitionKey: aadObjectId,
      rowKey: aadObjectId,
      name: displayName || '',
      email: email || '',
      reference: JSON.stringify(reference)
    };

    await referenceClient.upsertEntity(entity, "Merge");
  } catch (err) {
    console.error("❌ Fehler beim Speichern ConversationReference:", err.message);
  }
}

/**
 * Holt ConversationReference anhand der Benutzer-Email.
 * @param {string} email
 * @returns {Promise<Object|null>} ConversationReference oder null
 */
export async function getReferenceByEmail(email) {
  try {
    const { id } = await getUserInfoByEmail(email);
    const entity = await referenceClient.getEntity(id, id);
    return JSON.parse(entity.reference);
  } catch (err) {
    console.error("❌ Fehler beim Abrufen ConversationReference:", err.message);
    return null;
  }
}

/**
 * Holt die E-Mail-Adresse anhand der SessionId (AAD-Objekt-ID).
 * @param {string} sessionId
 * @returns {Promise<string|null>} Email oder null
 */
export async function getEmailBySessionId(sessionId) {
  try {
    const entity = await referenceClient.getEntity(sessionId, sessionId);
    return entity.email || null;
  } catch (err) {
    console.error("❌ Fehler beim Abrufen der E-Mail anhand der SessionId:", err.message);
    return null;
  }
}