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
 * Holt ConversationReference anhand der Benutzer-Email(s) oder gibt alle zurück.
 * @param {string|Array<string>|{all:true}} emails
 * @returns {Promise<Object|Array<Object>|null>} ConversationReference(s) oder null/[]
 */
export async function getReferenceByEmail(emails) {
  try {
    // Case 1: Request ALL references
    if (emails === '*' || emails === '__ALL__' || (emails && typeof emails === 'object' && emails.all === true)) {
      const allMap = await getAllReferences();
      return Object.entries(allMap).map(([email, reference]) => ({ email, reference }));
    }

    // Case 2: Array of emails → return array of references
    if (Array.isArray(emails)) {
      const results = [];
      for (const email of emails) {
        if (!email) { results.push({ email, reference: undefined }); continue; }
        const reference = await getSingleReferenceByEmail(email);
        results.push({ email, reference });
      }
      return results;
    }

    // Case 3: Single email (string) → return the ConversationReference or null
    if (typeof emails === 'string') {
      return await getSingleReferenceByEmail(emails);
    }
// Hilfsfunktion: holt eine einzelne ConversationReference zu einem E-Mail-Wert
async function getSingleReferenceByEmail(email) {
  if (!email) return null;
  const target = String(email).toLowerCase();

  // 1) Versuche via Graph die AAD-ID zu finden und direkt per Schlüssel zu lesen
  try {
    const { id } = await getUserInfoByEmail(target);
    if (id) {
      const entity = await referenceClient.getEntity(id, id);
      try { return JSON.parse(entity.reference); } catch { return null; }
    }
  } catch {
    // Ignorieren, weiter mit Fallback
  }

  // 2) Fallback: vollständiges Durchlaufen der Tabelle und Match auf email (case-insensitive)
  try {
    const entities = referenceClient.listEntities();
    for await (const entity of entities) {
      const em = (entity.email || '').toLowerCase();
      if (em === target) {
        try { return JSON.parse(entity.reference); } catch { return null; }
      }
    }
  } catch {
    // Ignorieren
  }

  return null;
}
    // Fallback: unsupported type → empty array
    return [];
  } catch (err) {
    console.error("❌ Fehler beim Abrufen ConversationReference:", err.message);
    return Array.isArray(emails) || emails === '*' || emails === '__ALL__' || (emails && emails.all === true) ? [] : null;
  }
}

/**
 * Gibt eine Map aller ConversationReferences zurück: { [emailLowercase]: ConversationReference }
 * @returns {Promise<Object>} Map von Email zu ConversationReference
 */
export async function getAllReferences() {
  const map = {};
  try {
    const entities = referenceClient.listEntities();
    for await (const entity of entities) {
      const email = (entity.email || '').toLowerCase();
      if (!email) continue;
      try {
        map[email] = JSON.parse(entity.reference);
      } catch (e) {
        console.error('⚠️ Konnte Reference nicht parsen für', email, e.message);
      }
    }
  } catch (err) {
    console.error('❌ Fehler beim Auflisten aller ConversationReferences:', err.message);
  }
  return map;
}

/**
 * Holt die E-Mail-Adresse anhand des Benutzernamens.
 * @param {string} userName
 * @returns {Promise<string|null>} Email oder null
 */
export async function getEmailByUserName(userName) {
  try {
    const entities = referenceClient.listEntities({
      queryOptions: {
        filter: `name eq '${userName}'`
      }
    });

    for await (const entity of entities) {
      return entity.email || null;
    }

    return null; // Falls kein Treffer
  } catch (err) {
    console.error("❌ Fehler beim Abrufen der E-Mail anhand des Benutzernamens:", err.message);
    return null;
  }
}