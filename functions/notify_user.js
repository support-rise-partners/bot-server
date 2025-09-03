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

        console.log("🤖 AI Reply:", aiReply);
        console.log("📧 Extrahierte Emails aus AI:", emailsArray);

        // Build targets from the new getReferenceByEmail shape: [{ email, reference }]
        let targets = [];
        if (aiReply && aiReply.trim() === '__ALL__') {
            targets = await getReferenceByEmail('__ALL__');
            if (!Array.isArray(targets) || targets.length === 0) {
                return res.status(400).json({ status: 'error', message: 'Keine gültigen ConversationReferences für alle Mitarbeiter gefunden.' });
            }
        } else {
            if (!emailsArray.length) {
                return res.status(400).json({ status: 'error', message: 'Konnte keine gültigen Empfänger aus dem Eingabetext ermitteln.' });
            }
            targets = await getReferenceByEmail(emailsArray);
            if (!Array.isArray(targets) || targets.length === 0) {
                return res.status(400).json({ status: 'error', message: 'Keine gültigen ConversationReferences für die angegebenen Empfänger gefunden.' });
            }
        }

        const sent = [];
        const failed = [];

        for (const { email: targetEmail, reference: conversationReference } of targets) {
            try {
                if (!conversationReference?.serviceUrl) {
                    console.warn('⚠️ Überspringe Reference ohne serviceUrl:', {
                        to: targetEmail,
                        hasConversation: Boolean(conversationReference?.conversation),
                        hasUser: Boolean(conversationReference?.user),
                        hasBot: Boolean(conversationReference?.bot),
                    });
                    failed.push(targetEmail);
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
                            sent.push(targetEmail);
                        } else {
                            console.warn("⚠️ Leere/ungültige OpenAI-Antwort:", JSON.stringify(response, null, 2));
                            failed.push(targetEmail);
                        }
                    }
                );
            } catch (err) {
                const errDetails = err?.response?.data || err?.stack || err?.message || String(err);
                console.error(`❌ Fehler beim Senden an ${targetEmail}:`, errDetails);
                failed.push(targetEmail);
            }
        }

        const unique = arr => Array.from(new Set(arr));
        const sentUnique = unique(sent);
        const failedFiltered = unique(failed.filter(e => !sentUnique.includes(e)));

        console.log("✅ Erfolgreich gesendet an:", sentUnique);
        console.log("❌ Fehler beim Senden an:", failedFiltered);

        return res.status(200).json({ status: "done", sent: sentUnique, failed: failedFiltered });
    } catch (error) {
        console.error("❌ Fehler beim Senden:", error.message);
        return res.status(500).json({ status: "error", message: "Interner Fehler beim Senden der Nachricht." });
    }
}

export default notifyUserHandler;