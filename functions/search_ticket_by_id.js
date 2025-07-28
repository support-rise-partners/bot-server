import fetch from 'node-fetch';
import { getChatCompletion } from '../services/openai.js';
import { getEmailByUserName } from '../services/conversationReferenceService.js';

export default async function (sessionId, userName, args) {
    try {
        console.log("🔍 Suche nach Tickets mit Argumenten:", args);
        if (typeof args === "string") {
            args = JSON.parse(args);
        }

        const email = await getEmailByUserName(userName);
        const requestBody = {
            ticket_id: args.ticket_id,
            email
        };

        const powerAutomateUrl = 'https://prod-02.germanywestcentral.logic.azure.com:443/workflows/a909b6aa1391489db276232bad6b210c/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=JcKpYCJYixVMh7kayCzdp36JWmwMgRqfSDtaU59DN4E';

        const response = await fetch(powerAutomateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            throw new Error(`Power Automate request failed: ${response.statusText}`);
        }

        const ticketData = await response.json();
        console.log("📥 Erhaltene Ticketdaten:", ticketData);

        const { reply } = await getChatCompletion({
            sessionId,
            role: 'system',
            text: `Gefundene Tickets basierend auf der Anfrage:\n${JSON.stringify(ticketData, null, 2)}`
        });

        return reply;
    } catch (error) {
        console.error("❌ Fehler bei der Ticket-Suche:", error.message);
        return "Es ist ein Fehler bei der Suche nach den Tickets aufgetreten.";
    }
}
