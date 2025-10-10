// functions/checkliste_dokumente.js (ESM, finale Fassung)

import {
  prepareAndIndexSession,
  vectorSearchTopK,
  cleanupSessionResources
} from '../services/tempCognitiveSearch.js';

import { adapter } from '../bot/adapter.js';
import { simpleChatCompletion, getChatCompletion } from '../services/openai.js';
import { getEmailByUserName, getReferenceByEmail } from '../services/conversationReferenceService.js';

// JSON-String → Objekt (oder Fehlerstruktur)
function normalizeArgs(raw) {
  let a = raw;
  if (typeof raw === 'string') {
    try { a = JSON.parse(raw); } catch {
      return { dokumente: [], fragen: [], _error: 'Ungültiges JSON in args.' };
    }
  }
  a = a && typeof a === 'object' ? a : {};
  const dokumente = Array.isArray(a.dokumente) ? a.dokumente.filter(Boolean) : [];
  const fragen    = Array.isArray(a.fragen)    ? a.fragen.filter(Boolean)    : [];
  return { dokumente, fragen };
}

// Robust: extrahiert JSON aus evtl. eingezäunten Antwort-Strings
function parseJsonSafe(raw) {
  const s = typeof raw === 'string' ? raw.trim() : String(raw || '');
  const fenced = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(fenced); } catch {}
  const m = s.match(/\{[\s\S]*\}$/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// Prüft minimale Felder für ConversationReference
function isValidConversationReference(ref) {
  return !!(ref && ref.serviceUrl && ref.conversation && ref.conversation.id);
}

// Vereinheitlicht unterschiedliche Rückgabetypen aus getReferenceByEmail
function resolveConversationReference(refResult) {
  if (Array.isArray(refResult)) {
    const first = refResult.find(r => r && (r.reference || r.reference === 0));
    const ref = first?.reference || first;
    return isValidConversationReference(ref) ? ref : null;
  }
  if (refResult && typeof refResult === 'object' && refResult.reference) {
    return isValidConversationReference(refResult.reference) ? refResult.reference : null;
  }
  return isValidConversationReference(refResult) ? refResult : null;
}

async function sendResultsToPowerAutomate(results, email) {
  console.log('📤 [PowerAutomate] Инициализация запроса...');
  console.log('📧 Email:', email);
  console.log('📦 Results:', JSON.stringify(results, null, 2));

  const POWER_AUTOMATE_URL = 'https://defaultf70052617df14a29b0f88bb1e67576.23.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/b8006ed7ba9942f28d67c05193810077/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=8E4SZmPHTHwQfW_3x0d1E1xnbLeKOR_69YE1nKX1_0Y';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    console.log('🚀 [PowerAutomate] Отправка запроса на:', POWER_AUTOMATE_URL);
    console.time('⏱️ PowerAutomate Fetch Duration');
    const res = await fetch(POWER_AUTOMATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email || null, results }),
      signal: controller.signal
    });
    console.timeEnd('⏱️ PowerAutomate Fetch Duration');
    console.log('✅ [PowerAutomate] Ответ получен. Status:', res.status);

    const text = await res.text().catch(() => '');
    console.log('📩 [PowerAutomate] Тело ответа:', text.slice(0, 500)); // показываем первые 500 символов
    return { ok: res.ok, status: res.status, body: text };
  } catch (err) {
    console.error('❌ [PowerAutomate] Ошибка при выполнении fetch:', err?.name, err?.message);
    if (err?.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Default-Export für Function-Calling:
 *   export default async function (sessionId, userName, args)
 * args: { dokumente: string[], fragen: string[] } ODER JSON-String mit diesen Feldern
 */
export default async function checkliste_dokumente(sessionId, userName, args = {}) {
  const { dokumente, fragen, _error } = normalizeArgs(args);

  // Kurze Vorab-Nachricht an den Nutzer (falls ConversationReference vorhanden)
  try {
    const email = await getEmailByUserName(userName);
    if (email) {
      const refResult = await getReferenceByEmail(email);
      const conversationReference = resolveConversationReference(refResult);
      if (adapter && conversationReference) {
        // asynchron starten, Hauptfluss nicht blockieren
        (async () => {
          try {
            await adapter.continueConversation(conversationReference, async (turnContext) => {
              const response = await simpleChatCompletion(
                'System: Du bist Risy – der freundliche Assistent. Umformuliere eine sehr kurze, lockere System-Nachricht im Du-Ton: "Hmm… ich muss kurz nachdenken, ich melde mich gleich mit einer Antwort!"',
                'Erzeuge und gebe zurück nur eine kurze, freundliche Hinweis-Nachricht (leicht umformuliert "Hmm… lass mich kurz überlegen, ich bin gleich zurück mit der Antwort!") - ohne weitere Angaben.'
              );
              const replyText = typeof response === 'string' ? response : response?.reply;
              if (replyText && replyText.trim()) {
                await turnContext.sendActivity({ type: 'message', text: replyText });
              }
            });
          } catch {}
        })();
      }
    }
  } catch {}

  // Frühe Fehlerfälle
  if (_error) {
    const results = [{ frage: null, yesno: '', antwort: 'Fehler beim Verarbeiten der Eingabe.', zitat: _error }];
    console.log(results);
    // optional an Power Automate senden (Fehlerfall)
    return JSON.stringify(results);
  }
  if (!dokumente.length) {
    const results = [{ frage: null, yesno: '', antwort: 'Keine Dokumente übermittelt.', zitat: '' }];
    console.log(results);
    return JSON.stringify(results);
  }

  const results = [];
  try {
    // 1) Vorbereitung & Indexierung
    await prepareAndIndexSession({ sessionId, urls: dokumente });

    // 2) Fragen beantworten (Vektor-Suche → LLM mit Kontext)
    const SYSTEM = 'Du bist ein sachlicher Assistent. Antworte präzise in Deutsch. Gib **ausschließlich** JSON zurück im Format {"yesno": "ja"|"nein", "answer": string, "quote": string}.';
    for (const frage of fragen) {
      const q = (frage || '').toString().trim();
      if (!q) {
        results.push({ frage, yesno: '', antwort: 'Leere Frage.', zitat: '' });
        continue;
      }

      const chunks = await vectorSearchTopK({ sessionId, text: q, k: 3 });
      if (!chunks.length) {
        results.push({ frage: q, yesno: 'nein', antwort: 'Keine fundierte Antwort in den Dokumenten gefunden.', zitat: '' });
        continue;
      }

      const context = chunks
        .map((c, i) => `# Chunk ${i + 1} — ${c.document_title}\n${c.content_text}`)
        .join('\n\n');

      const USER = `Frage: ${q}\n\nKontext (relevante Chunks):\n${context}\n\nFormatiere die Antwort **nur** als JSON mit den Feldern {\"yesno\": \"ja\" oder \"nein\", \"answer\": string, \"quote\": string}.\n- \"yesno\" soll eine sehr kurze Ja/Nein-Entscheidung sein (\"ja\" wenn der Kontext eine klare Bejahung stützt, sonst \"nein\").\n- Schreibe keinerlei zusätzlichen Text außerhalb des JSON.`;

      let raw = '';
      try {
        raw = await simpleChatCompletion(SYSTEM, USER);
      } catch {
        results.push({
          frage: q,
          yesno: '',
          antwort: 'Antwort konnte nicht generiert werden.',
          zitat: chunks[0]?.content_text?.slice(0, 600) || ''
        });
        continue;
      }

      const parsed = parseJsonSafe(raw);
      const yesno  = typeof parsed?.yesno === 'string' ? parsed.yesno.trim().toLowerCase() : '';
      const antwort = parsed?.answer || (typeof raw === 'string' ? raw : '');
      const zitat   = parsed?.quote  || (chunks[0]?.content_text || '').slice(0, 600);
      results.push({ frage: q, yesno, antwort, zitat });
    }
  } catch (err) {
    const msg = err?.message || String(err);
    results.push({ frage: null, yesno: '', antwort: 'Interner Fehler im Verarbeitungspipeline.', zitat: msg });
  } finally {
    // 3) Aufräumen: temporäre Ressourcen entfernen
    try {
      await cleanupSessionResources({ sessionId, deleteIndex: true, deleteDataSource: true, deleteBlobs: true });
    } catch {}
  }

  // Ergebnisse an Power Automate senden und Antwort verwenden
  try {
    const email = await getEmailByUserName(userName);
    const pa = await sendResultsToPowerAutomate(results, email);
    if (pa?.ok) {
      const aiResp = await getChatCompletion({
        sessionId,
        role: 'system',
        text: pa.body || '',
        userName
      });
      const replyText = typeof aiResp === 'string' ? aiResp : (aiResp?.reply ?? JSON.stringify(aiResp));
      console.log('✅ Finale AI-Antwort:', replyText);
      return replyText;
    } else {
      console.log('⚠️ Power Automate hat keine gültige Antwort geliefert:', pa);
      return JSON.stringify(results);
    }
  } catch (err) {
    console.error('❌ Fehler beim Power Automate-Schritt:', err.message);
    console.log(results);
    return JSON.stringify(results);
  }
}