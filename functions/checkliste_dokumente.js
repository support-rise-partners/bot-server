// Orchestrierung: lädt Dokumente, indexiert sie pro Sitzung, sucht Top-3 Chunks je Frage
// und lässt OpenAI aus diesen Chunks eine Antwort + genaue Quellen-Zitat formulieren.

const {
  prepareAndIndexSession,
  vectorSearchTopK,
  cleanupSessionResources
} = require('../services/tempCognitiveSearch');

const { simpleChatCompletion } = require('../services/openai');

// Hilfsfunktion: baut nutzerfreundlichen Kontext aus Chunks
function buildContextFromChunks(chunks) {
  return chunks
    .map((c, i) => [
      `# Quelle ${i + 1}: ${c.document_title || 'Unbenannt'}`,
      c.content_text || ''
    ].join('\n'))
    .join('\n\n---\n\n');
}

// System-Prompt (deutsch): klare Ausgabe als JSON mit Feldern answer, quote
const DEFAULT_SYSTEM_PROMPT = `Du bist ein präziser Assistent für Dokumentenfragen (DE/EN).
Antworte NUR anhand des bereitgestellten Kontexts. Wenn die Antwort nicht sicher ist, sage es explizit.
Gib das Ergebnis **ausschließlich** als JSON im Schema {"answer":"...","quote":"..."} zurück.
Die Eigenschaft "quote" muss eine ** ausführliche, wortgetreue** Textpassage aus dem Kontext sein.`;

// Baut User-Prompt aus Frage + Kontext
function makeUserPrompt(question, context) {
  return [
    `Frage: ${question}`,
    '',
    'Kontext:',
    context
  ].join('\n');
}

// Erwartet args: { dokumente: string[], fragen: string[] }
exports.default = async function (sessionId, userName, args) {
  const dokumente = Array.isArray(args?.dokumente) ? args.dokumente : [];
  const fragen = Array.isArray(args?.fragen) ? args.fragen : [];

  if (!sessionId) throw new Error('sessionId fehlt');
  if (!dokumente.length) throw new Error('args.dokumente ist leer');
  if (!fragen.length) throw new Error('args.fragen ist leer');

  const results = [];

  // 1) Upload + Erstellen aller temporären Ressourcen + Indexierung
  const prep = await prepareAndIndexSession({ sessionId, urls: dokumente });

  try {
    // 2) Für jede Frage: vektorbasierte Suche -> OpenAI-Antwort
    for (const frage of fragen) {
      const chunks = await vectorSearchTopK({ sessionId, text: frage, k: 3 });
      const context = buildContextFromChunks(chunks);

      const userPrompt = makeUserPrompt(frage, context);

      let answerText = '';
      let quoteText = '';

      // OpenAI-Aufruf: erwartet JSON mit { answer, quote }
      const raw = await simpleChatCompletion(DEFAULT_SYSTEM_PROMPT, userPrompt);

      try {
        const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw));
        answerText = parsed.answer || '';
        quoteText = parsed.quote || '';
      } catch {
        // Fallback: falls kein valides JSON — komplette Antwort verwenden
        answerText = typeof raw === 'string' ? raw : String(raw);
        // Versuche die erste Caption/den ersten Chunk als Zitat zu geben
        quoteText = (chunks[0]?.content_text || '').slice(0, 400);
      }

      results.push({
        frage,
        antwort: answerText,
        zitat: quoteText
      });
    }

    console.log('\n[Endergebnisse]', results);
    return results;
  } finally {
    // 3) Aufräumen: Indexer, Index, DataSource, Blobs löschen
    await cleanupSessionResources({ sessionId, deleteIndex: true, deleteDataSource: true, deleteBlobs: true })
      .catch(() => {});
  }
};