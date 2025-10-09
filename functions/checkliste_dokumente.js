// functions/checkliste_dokumente.js (ESM, финальная версия, фикс парсинга args и дефолтного ответа)

import {
  prepareAndIndexSession,
  vectorSearchTopK,
  cleanupSessionResources
} from '../services/tempCognitiveSearch.js';

const OPENAI_ENDPOINT   = (process.env.OPENAI_ENDPOINT || '').trim();
const OPENAI_KEY        = (process.env.OPENAI_KEY || '').trim();
const OPENAI_DEPLOYMENT = (process.env.OPENAI_DEPLOYMENT || 'gpt-4o').trim();
const OPENAI_VERSION    = (process.env.OPENAI_VERSION || '2024-12-01-preview').trim();

// --- НОВОЕ: нормализация аргументов из function calling (строка JSON или объект)
function normalizeArgs(raw) {
  let a = raw;
  if (typeof raw === 'string') {
    try { a = JSON.parse(raw); } catch {
      return { dokumente: [], fragen: [], _error: 'Ungültiges JSON in args (String konnte nicht geparst werden).' };
    }
  }
  a = a && typeof a === 'object' ? a : {};
  const dokumente = Array.isArray(a.dokumente) ? a.dokumente.filter(Boolean) : [];
  const fragen    = Array.isArray(a.fragen)    ? a.fragen.filter(Boolean)    : [];
  return { dokumente, fragen };
}

// Мини-обёртка для Chat Completion
async function simpleChatCompletion(systemPromptText, userPromptText) {
  if (!OPENAI_ENDPOINT || !OPENAI_KEY) {
    throw new Error('OPENAI_ENDPOINT/OPENAI_KEY sind nicht gesetzt.');
  }
  const url = `${OPENAI_ENDPOINT}/openai/deployments/${OPENAI_DEPLOYMENT}/chat/completions?api-version=${OPENAI_VERSION}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': OPENAI_KEY },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPromptText },
        { role: 'user',   content: userPromptText }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`OpenAI Chat Fehler: ${resp.status} ${t}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

function parseJsonSafe(raw) {
  const s = typeof raw === 'string' ? raw.trim() : String(raw || '');
  const fenced = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(fenced); } catch {}
  const m = s.match(/\{[\s\S]*\}$/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/**
 * Default-экспорт для function calling:
 *   export default async function (sessionId, userName, args)
 * args: { dokumente: string[], fragen: string[] } ИЛИ JSON-строка с такими полями
 */
export default async function checkliste_dokumente(sessionId, userName, args = {}) {
  // --- НОВОЕ: корректная распаковка аргументов
  const { dokumente, fragen, _error } = normalizeArgs(args);

  // Если парсинг провалился — вернём осмысленный результат, а не пустоту
  if (_error) {
    const results = [{ frage: null, antwort: 'Fehler beim Verarbeiten der Eingabe.', zitat: _error }];
    console.log(results);
    return JSON.stringify(results);
  }

  // Нет документов — сразу возвращаем понятный ответ (не пустой)
  if (!dokumente.length) {
    const results = [{ frage: null, antwort: 'Keine Dokumente übermittelt.', zitat: '' }];
    console.log(results);
    return JSON.stringify(results);
  }

  const results = [];
  try {
    // 1) Подготовка и индексация
    await prepareAndIndexSession({ sessionId, urls: dokumente });

    // 2) Ответы по вопросам
    const SYSTEM = 'Du bist ein sachlicher Assistent. Antworte präzise in Deutsch. Antworte als JSON {"answer": string, "quote": string}.';

    for (const frage of fragen) {
      const trimmed = (frage || '').toString().trim();
      if (!trimmed) {
        results.push({ frage, antwort: 'Leere Frage.', zitat: '' });
        continue;
      }

      const chunks = await vectorSearchTopK({ sessionId, text: trimmed, k: 3 });
      if (!chunks.length) {
        results.push({ frage, antwort: 'Keine fundierte Antwort in den Dokumenten gefunden.', zitat: '' });
        continue;
      }

      const context = chunks
        .map((c, i) => `# Chunk ${i + 1} — ${c.document_title}\n${c.content_text}`)
        .join('\n\n');

      const USER = `Frage: ${trimmed}\n\nKontext (relevante Chunks):\n${context}\n\nFormatiere die Antwort als JSON.`;

      let raw = '';
      try {
        raw = await simpleChatCompletion(SYSTEM, USER);
      } catch {
        results.push({
          frage,
          antwort: 'Antwort konnte nicht generiert werden (LLM-Fehler).',
          zitat: chunks[0]?.content_text?.slice(0, 600) || ''
        });
        continue;
      }

      const parsed = parseJsonSafe(raw);
      const antwort = parsed?.answer || (typeof raw === 'string' ? raw : '');
      const zitat   = parsed?.quote  || (chunks[0]?.content_text || '').slice(0, 600);

      results.push({ frage, antwort, zitat });
    }
  } catch (err) {
    // --- НОВОЕ: не оставляем пустой массив — кладём понятный объект с ошибкой
    const msg = err?.message || String(err);
    console.error('[checkliste_dokumente] Pipeline-Fehler:', msg);
    results.push({ frage: null, antwort: 'Interner Fehler im Verarbeitungspipeline.', zitat: msg });
  } finally {
    // 3) Уборка временных ресурсов
    try {
      await cleanupSessionResources({ sessionId, deleteIndex: true, deleteDataSource: true, deleteBlobs: true });
    } catch (e) {
      console.error('[cleanup] Aufräumen fehlgeschlagen:', e?.message || e);
    }
  }

  // В консоль выводим именно массив результатов (не пустую строку)
  console.log(results);
  return JSON.stringify(results);
}