// functions/checkliste_dokumente.js (ESM, финальная версия)
// Оркестрация: принимает ссылки и вопросы → готовит временные ресурсы ACS → векторный поиск → LLM-ответ → уборка.
// Все операции хранилища/поиска импортируются из services/tempCognitiveSearch.js.

import {
  prepareAndIndexSession,
  vectorSearchTopK,
  cleanupSessionResources
} from '../services/tempCognitiveSearch.js';

// Параметры для LLM-ответа (ваш существующий чат-деплоймент)
const OPENAI_ENDPOINT   = (process.env.OPENAI_ENDPOINT || '').trim();
const OPENAI_KEY        = (process.env.OPENAI_KEY || '').trim();
const OPENAI_DEPLOYMENT = (process.env.OPENAI_DEPLOYMENT || 'gpt-4o').trim();
const OPENAI_VERSION    = (process.env.OPENAI_VERSION || '2024-12-01-preview').trim();

// Мини-обёртка для Chat Completion (без логики поиска/хранилища)
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

// Безопасный парсер JSON
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
 * args = { dokumente: string[], fragen: string[] }
 */
export default async function checkliste_dokumente(sessionId, userName, args = {}) {
  const dokumente = Array.isArray(args?.dokumente) ? args.dokumente : [];
  const fragen    = Array.isArray(args?.fragen) ? args.fragen : [];

  // Если нет документов — возвращаем пустой массив и печатаем его
  if (!dokumente.length) {
    const results = [];
    console.log(results);
    return results;
  }

  const results = [];
  try {
    // 1) Подготовить сессию: загрузить документы в Blob и создать временные ресурсы ACS, выполнить индексацию
    await prepareAndIndexSession({ sessionId, urls: dokumente });

    // 2) Для каждого вопроса: векторный поиск → формирование ответа моделью
    const SYSTEM = 'Du bist ein sachlicher Assistent. Antworte präzise in Deutsch. Antworte als JSON {"answer": string, "quote": string}.';

    for (const frage of fragen) {
      // Векторный поиск топ-3 релевантных чанка
      const chunks = await vectorSearchTopK({ sessionId, text: frage, k: 3 });
      if (!chunks.length) {
        results.push({ frage, antwort: 'Keine fundierte Antwort in den Dokumenten gefunden.', zitat: '' });
        continue;
      }

      const context = chunks
        .map((c, i) => `# Chunk ${i + 1} — ${c.document_title}\n${c.content_text}`)
        .join('\n\n');

      const USER = `Frage: ${frage}\n\nKontext (relevante Chunks):\n${context}\n\nFormatiere die Antwort als JSON.`;

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
    // Логируем ошибку пайплайна (в консоль выводим только финальный results; здесь — error)
    console.error('[checkliste_dokumente] Pipeline-Fehler:', err?.message || err);
  } finally {
    // 3) Обязательная уборка временных ресурсов (Index/Indexer/Skillset/DataSource + Blobs runs/<sessionId>/)
    try {
      await cleanupSessionResources({ sessionId, deleteIndex: true, deleteDataSource: true, deleteBlobs: true });
    } catch (e) {
      console.error('[cleanup] Aufräumen fehlgeschlagen:', e?.message || e);
    }
  }

  // Печатаем ТОЛЬКО массив результатов
  console.log(results);
  return results;
}