import { adapter } from '../bot/adapter.js';
import { getReferenceByEmail } from '../services/conversationReferenceService.js';
import { getChatCompletion, simpleChatCompletion } from '../services/openai.js';

function safeJsonParse(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        return null;
    }
}

function extractEmailsFromAI(rawText) {
    const text = (rawText || '').trim();
    let jsonText = text;
    const first = text.indexOf('[');
    const last = text.lastIndexOf(']');
    if (first !== -1 && last !== -1 && last > first) {
        jsonText = text.slice(first, last + 1);
    }
    const parsed = safeJsonParse(jsonText);
    if (!Array.isArray(parsed)) return [];
    const domain = '@rise-partners.de';
    const emailRegex = /^[a-z0-9_.+-]+@[a-z0-9-]+\.[a-z0-9-.]+$/;
    const unique = Array.from(new Set(parsed.map(e => String(e).trim().toLowerCase())));
    return unique.filter(e => emailRegex.test(e) && e.endsWith(domain));
}

export async function notifyUserHandler(req, res) {
    try {
        console.log("📥 Eingehender Anfrage-Body:", req.body);
        let { emails, message } = req.body;

        // 1) Validate message as non-empty string
        if (typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ status: 'error', message: "Erwarte gültiges Feld 'message' (string)." });
        }
        // 1) Validate emails as non-empty string (freeform names/emails)
        if (typeof emails !== 'string' || !emails.trim()) {
            return res.status(400).json({ status: 'error', message: "Feld 'emails' muss eine nicht-leere Zeichenkette sein." });
        }

        // 2) Transform freeform names/emails into an array via simpleChatCompletion
        const systemPromptText = `You are given a freeform text that may include names, nicknames, and/or email addresses of RISE PARTNERS employees.\n\nTask:\n1) Extract the intended recipients.\n2) Convert each person to an email in the format vorname.nachname@rise-partners.de.\n3) Remove diacritics/umlauts and special characters from names (ä->ae, ö->oe, ü->ue, ß->ss).\n4) Use lowercase only.\n5) Output ONLY a compact JSON array of unique strings (emails), e.g.: ["max.mustermann@rise-partners.de", "anna.meier@rise-partners.de"]. No prose, no markdown.\n6) If the text indicates that the user wants to notify ALL employees, output exactly the string "__ALL__" (instead of a JSON array).`;

        const userPromptText = emails;
        const aiReply = await simpleChatCompletion(systemPromptText, userPromptText);
        const emailsArray = extractEmailsFromAI(aiReply);

        let conversationReferences = [];
        if (aiReply && aiReply.trim() === '__ALL__') {
            conversationReferences = await getReferenceByEmail('__ALL__');
            if (!Array.isArray(conversationReferences) || conversationReferences.length === 0) {
                return res.status(400).json({ status: 'error', message: 'Keine gültigen ConversationReferences für alle Mitarbeiter gefunden.' });
            }
        } else {
            if (!emailsArray.length) {
                return res.status(400).json({ status: 'error', message: 'Konnte keine gültigen Empfänger aus dem Eingabetext ermitteln.' });
            }
            conversationReferences = await getReferenceByEmail(emailsArray);
            if (!Array.isArray(conversationReferences) || conversationReferences.length === 0) {
                return res.status(400).json({ status: 'error', message: 'Keine gültigen ConversationReferences für die angegebenen Empfänger gefunden.' });
            }
        }

        const sent = [];
        const failed = [];

        for (const conversationReference of conversationReferences) {
            try {
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
                            const refEmail = conversationReference?.user?.email || conversationReference?.user?.id || 'unknown';
                            sent.push(refEmail);
                        } else {
                            console.warn("⚠️ Leere/ungültige OpenAI-Antwort:", JSON.stringify(response, null, 2));
                            const refEmail = conversationReference?.user?.email || conversationReference?.user?.id || 'unknown';
                            failed.push(refEmail);
                        }
                    }
                );
            } catch (err) {
                const refEmail = conversationReference?.user?.email || conversationReference?.user?.id || 'unknown';
                console.error(`❌ Fehler beim Senden an ${refEmail}:`, err.message);
                failed.push(refEmail);
            }
        }

        return res.status(200).json({ status: "done", sent, failed });
    } catch (error) {
        console.error("❌ Fehler beim Senden:", error.message);
        return res.status(500).json({ status: "error", message: "Interner Fehler beim Senden der Nachricht." });
    }
}

export default notifyUserHandler;