

import fetch from 'node-fetch';
import { getChatCompletion } from '../services/openai.js';
import { getEmailByUserName } from '../services/conversationReferenceService.js';

export default async function (sessionId, userName, args) {
    try {
        console.log("📅 Besuchsankündigung mit Argumenten:", args);
        if (typeof args === "string") {
            args = JSON.parse(args);
        }

        const email = await getEmailByUserName(userName);
        const requestBody = {
            besuchszeit: args.dateTime,
            besucherinfo: args.besucherInfo,
            ansprechperson: args.ansprechpersonen,
            besuchszweck: args.thema,
            zusatzinfo: args.zusatzinfo || "",
            email
        };

        const powerAutomateUrl = 'https://prod-05.germanywestcentral.logic.azure.com:443/workflows/733ba3d3c79e462c8025b446dbed8755/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=H8I6TxmV6JTeP2z1T2i6iFxSb3rcQoHAYl3Bfu5LDMU';

        const response = await fetch(powerAutomateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            throw new Error(`Power Automate request failed: ${response.statusText}`);
        }

        const result = await response.json();
        console.log("✅ Besuch erfolgreich angekündigt:", result);

        const { reply } = await getChatCompletion({
            sessionId,
            role: 'system',
            text: `Der Besuch wurde erfolgreich angekündigt:\n${JSON.stringify(result, null, 2)}`
        });

        return reply;
    } catch (error) {
        console.error("❌ Fehler bei der Besuchsankündigung:", error.message);
        return "Es ist ein Fehler bei der Ankündigung des Besuchs aufgetreten.";
    }
}