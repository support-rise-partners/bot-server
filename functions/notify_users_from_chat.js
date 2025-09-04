import { getChatCompletion } from '../services/openai.js';
import { notifyUserHandler } from './notify_user.js';
import { getEmailByUserName } from '../services/conversationReferenceService.js';
import { isAdmin } from '../config/roles.js';

/**
 * Wrapper zum Versenden von Nachrichten aus dem Chat-Kontext.
 * Nimmt freie Empfängerangaben (Namen/E-Mails oder ALL) und eine Nachricht entgegen,
 * präﬁxiert den Nachrichtentext mit "Informiere den User: " und ruft den bestehenden HTTP-Handler auf.
 *
 * @param {string} sessionId   Session identifier
 * @param {string} userName    Name of the user
 * @param {object} args        Object containing recipients and message
 * @returns {Promise<{ code: number, status: string, sent: string[], failed: string[] }>} Ergebnis des Versands
 */
export default async function (sessionId, userName, args) {
  // --- Parse args if it comes as a string (no normalization; no fallbacks) ---
  console.log("📦 Raw args:", args);
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch (err) {
      console.error("❌ Failed to parse args JSON:", err?.message);
      args = {};
    }
  }
  const prefixedMessage = `Das ist eine Eingehende Systemnachricht: ${args?.message || ''}. Informiere den User in deinem Namen darüber, als ob diese Nachricht von dir kommt ohne weitere Komentare`;
  console.log("📨 Eingehende Parameter -> message:", args?.message, "email:", args?.recipients);

  const fakeReq = { body: { emails: args?.recipients || '', message: prefixedMessage || '' } };
  console.log("📤 NotifyUserHandler call with emails:", fakeReq.body.emails, "message:", fakeReq.body.message);
  let result;
  const fakeRes = {
    status(code) {
      this.statusCode = code || 200;
      return this;
    },
    json(payload) {
      result = { code: this.statusCode || 200, ...payload };
      return result;
    }
  };

  const email = await getEmailByUserName(userName);
  if (!isAdmin(email)) {
    const { reply } = await getChatCompletion({
      sessionId: sessionId,
      role: 'system',
      text: "Du brauchst administratorrechte, um diese Funktion zu nutzen"
    });
    return reply;
  }

  if (typeof args.recipients !== 'string' || !args.recipients.trim()) {
    throw new Error("'recipients' must be a non-empty string");
  }
  if (typeof args.message !== 'string' || !args.message.trim()) {
    throw new Error("'message' must be a non-empty string");
  }

  await notifyUserHandler(fakeReq, fakeRes);

  // Optional system completion step
  const { reply } = await getChatCompletion({
    sessionId: sessionId,
    role: 'system',
    text: JSON.stringify(result)
  });

  return reply;
}