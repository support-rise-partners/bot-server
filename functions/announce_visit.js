

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
            besuchszeit: args.besuchszeit || args.dateTime,
            besucherinfo: args.besucherinfo || args.besucherInfo,
            ansprechperson: args.ansprechperson || args.ansprechpersonen,
            besuchszweck: args.besuchszweck || args.thema,
            email
        };

        if (args.zusatzinfo) {
            requestBody.zusatzinfo = args.zusatzinfo;
        }

        const powerAutomateUrl = 'https://defaultf70052617df14a29b0f88bb1e67576.23.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/733ba3d3c79e462c8025b446dbed8755/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=ZRCc3W_AmfgYJ_b8kvfjuyhy2BCydxwbrynRDVKAlEM';

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