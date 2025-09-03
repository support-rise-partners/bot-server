import { getChatCompletion } from '../services/openaiService.js';
import { notifyUserHandler } from './notify_user.js';

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
export default async function notifyUsersFromChat(sessionId, userName, args) {
  if (typeof args.recipients !== 'string' || !args.recipients.trim()) {
    throw new Error("'recipients' must be a non-empty string");
  }
  if (typeof args.message !== 'string' || !args.message.trim()) {
    throw new Error("'message' must be a non-empty string");
  }

  const prefixedMessage = `Informiere den User: ${args.message}`;

  // Fake req/res, damit wir den bestehenden Express-Handler wiederverwenden können
  const fakeReq = { body: { emails: args.recipients, message: prefixedMessage } };
  let result;
  const fakeRes = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      result = { code: this.statusCode, ...payload };
      return result;
    }
  };

  await notifyUserHandler(fakeReq, fakeRes);

  // Optional system completion step
  const aiResponse = await getChatCompletion({
    sessionId: sessionId,
    role: 'system',
    text: String(result)
  });

  return { ...result, aiResponse };
}