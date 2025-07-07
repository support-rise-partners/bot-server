import { adapter } from '../bot/adapter.js';
import { getConversationReferenceById } from '../services/storage.js';
import { getChatCompletion } from '../services/openai.js';

export async function notifyUserHandler(req, res) {
    try {
        console.log("📥 Eingehender Anfrage-Body:", req.body);
        const { userId, message } = req.body;

        const { reference: conversationReference } = await getConversationReferenceById(userId);
        console.log("📌 Geladene Konversationsreferenz:", conversationReference);
        console.log("🛠 ServiceUrl:", conversationReference?.serviceUrl);
        console.log("🛠 conversation.id:", conversationReference?.conversation?.id);
        console.log("🛠 user.id:", conversationReference?.user?.id);

        if (!conversationReference || !message) {
            return res.status(400).send("conversationReference und message sind erforderlich.");
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
                } else {
                    console.warn("⚠️ OpenAI-Antwort war leer oder ungültig:", response);
                    await turnContext.sendActivity("Tut mir leid, ich konnte keine gültige Antwort generieren.");
                }
            }
        );

        return res.status(200).send("Nachricht gesendet.");
    } catch (error) {
        console.error("❌ Fehler beim Senden:", error.message);
        return res.status(500).send("Interner Fehler beim Senden der Nachricht.");
    }
}

export default notifyUserHandler;