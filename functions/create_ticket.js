import fetch from 'node-fetch';
import { getChatCompletion } from '../services/openai.js';
import { getEmailByUserName } from '../services/conversationReferenceService.js';

export default async function (userName, args) {
    try {
        console.log("Creating ticket with arguments:", args);
        if (typeof args === "string") {
            args = JSON.parse(args);
        }
        const email = await getEmailByUserName(userName);
        args.email = email;

        const powerAutomateUrl = 'https://prod-23.germanywestcentral.logic.azure.com:443/workflows/ab40992aa0204ec19316157f28653d28/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=g8H_FeIAGwIVQfy_3nQGEeguiy7p4tKfI4u6jHsHmB8';

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
            text: `Ticket wurde erstellt. Informiere den User darüber. nTicket-ID: ${data.ticketId} Link: ${data.ticketLink || 'n/a'}`
        });

        return reply;
    } catch (error) {
        console.error("❌ Fehler beim Erstellen des Tickets:", error.message);
        return "Es ist ein Fehler beim Erstellen des Tickets aufgetreten.";
    }
}