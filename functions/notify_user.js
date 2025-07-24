import { adapter } from '../bot/adapter.js';
import { getReferenceByEmail } from '../services/conversationReferenceService.js';
import { getChatCompletion } from '../services/openai.js';

export async function notifyUserHandler(req, res) {
    try {
        console.log("📥 Eingehender Anfrage-Body:", req.body);
        let { emails, message } = req.body;
        if (!emails) {
            return res.status(400).json({ status: "error", message: "Feld 'emails' fehlt." });
        }
        const emailsArray = Array.isArray(emails) ? emails : [emails];
        if (typeof message !== 'string') {
            return res.status(400).json({ status: "error", message: "Erwarte { emails: [], message: \"...\" }" });
        }

        const sent = [];
        const failed = [];

        for (const email of emailsArray) {
            try {
                const conversationReference = await getReferenceByEmail(email);
                if (!conversationReference) {
                    console.warn(`⚠️ Kein ConversationReference für ${email} gefunden`);
                    failed.push(email);
                    continue;
                }

                await adapter.continueConversation(
                    conversationReference,
                    async (turnContext) => {
                        const response = await getChatCompletion({
                            sessionId: conversationReference?.conversation?.id,
                            role: 'system',
                            text: message
                        });
                        const replyText = typeof response === 'string' ? response : response?.reply;

                        if (replyText && replyText.trim()) {
                            await turnContext.sendActivity({ type: 'message', text: replyText });
                            sent.push(email);
                        } else {
                            console.warn("⚠️ Leere/ungültige OpenAI-Antwort:", JSON.stringify(response, null, 2));
                            await turnContext.sendActivity("Tut mir leid, ich konnte keine gültige Antwort generieren.");
                            failed.push(email);
                        }
                    }
                );
            } catch (err) {
                console.error(`❌ Fehler beim Senden an ${email}:`, err.message);
                failed.push(email);
            }
        }

        return res.status(200).json({ status: "done", sent, failed });
    } catch (error) {
        console.error("❌ Fehler beim Senden:", error.message);
        return res.status(500).json({ status: "error", message: "Interner Fehler beim Senden der Nachricht." });
    }
}

export default notifyUserHandler;