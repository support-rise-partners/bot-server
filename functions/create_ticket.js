import fetch from 'node-fetch';
import { getChatCompletion } from '../services/openai.js';
import { getEmailByUserName } from '../services/conversationReferenceService.js';

export default async function (sessionId, userName, args) {
    try {
        console.log("Creating ticket with arguments:", args);
        if (typeof args === "string") {
            args = JSON.parse(args);
        }
        const email = await getEmailByUserName(userName);
        args.email = email;

        const powerAutomateUrl = 'https://defaultf70052617df14a29b0f88bb1e67576.23.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/ab40992aa0204ec19316157f28653d28/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=vn1NfrRURcgMaQASVmzNG2OBrVzob_OA1zradLqc5x0';

        const response = await fetch(powerAutomateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args)
        });

        if (!response.ok) {
            throw new Error(`Power Automate request failed: ${response.statusText}`);
        }

        const data = await response.json();
        console.log("✅ Ticket erfolgreich an Power Automate übermittelt:", data);

        const { reply } = await getChatCompletion({
            sessionId,
            role: 'system',
            text: `Ticket wurde erstellt. Informiere den User darüber. nTicket-ID: ${data.ticketId} Link: ${data.ticketLink || 'n/a'}. Innerhalb der nächsten 5 Minuten kann das Ticket bei Bedarf über den Link korrigiert werden.`
        });

        return reply;
    } catch (error) {
        console.error("❌ Fehler beim Erstellen des Tickets:", error.message);
        return "Es ist ein Fehler beim Erstellen des Tickets aufgetreten.";
    }
}