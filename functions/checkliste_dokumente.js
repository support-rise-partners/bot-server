// functions/checkliste_dokumente.js (ESM, финальная версия, фикс парсинга args и дефолтного ответа)

import {
  prepareAndIndexSession,
  vectorSearchTopK,
  cleanupSessionResources
} from '../services/tempCognitiveSearch.js';

import { adapter } from '../bot/adapter.js';
import { simpleChatCompletion } from '../services/openai.js';
import { getEmailByUserName, getReferenceByEmail } from '../services/conversationReferenceService.js';

const OPENAI_ENDPOINT   = (process.env.OPENAI_ENDPOINT || '').trim();
const OPENAI_KEY        = (process.env.OPENAI_KEY || '').trim();
const OPENAI_DEPLOYMENT = (process.env.OPENAI_DEPLOYMENT || 'gpt-4o').trim();
const OPENAI_VERSION    = (process.env.OPENAI_VERSION || '2024-12-01-preview').trim();

// Безопасная сериализация для логов
function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

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


function parseJsonSafe(raw) {
  const s = typeof raw === 'string' ? raw.trim() : String(raw || '');
  const fenced = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(fenced); } catch {}
  const m = s.match(/\{[\s\S]*\}$/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// --- НОВОЕ: нормализация conversationReference из getReferenceByEmail(email)
function isValidConversationReference(ref) {
  return !!(ref && ref.serviceUrl && ref.conversation && ref.conversation.id);
}

function resolveConversationReference(refResult) {
  // Может прийти объект { email, reference }, массив таких объектов, либо сам reference
  if (Array.isArray(refResult)) {
    const first = refResult.find(r => r && (r.reference || r.reference === 0));
    const ref = first?.reference || first;
    return isValidConversationReference(ref) ? ref : null;
  }
  // Если объект с полем reference
  if (refResult && typeof refResult === 'object' && refResult.reference) {
    return isValidConversationReference(refResult.reference) ? refResult.reference : null;
  }
  // Если это уже reference
  return isValidConversationReference(refResult) ? refResult : null;
}

/**
 * Default-экспорт для function calling:
 *   export default async function (sessionId, userName, args)
 * args: { dokumente: string[], fragen: string[] } ИЛИ JSON-строка с такими полями
 */
export default async function checkliste_dokumente(sessionId, userName, args = {}) {
  console.log(`[checkliste_dokumente] start sessionId=${sessionId}, userName="${userName}", argsType=${typeof args}`);
  if (typeof args === 'string') {
    console.log('[checkliste_dokumente] raw args string preview:', (args.length > 300 ? args.slice(0, 300) + '…' : args));
  } else {
    console.log('[checkliste_dokumente] raw args object preview:', safeStringify(args).slice(0, 300));
  }
  // --- НОВОЕ: корректная распаковка аргументов
  const { dokumente, fragen, _error } = normalizeArgs(args);
  console.log(`[checkliste_dokumente] normalized: dokumente=${dokumente.length}, fragen=${fragen.length}, hasError=${!!_error}`);

  // Попробуем отправить «подожди»-сообщение до старта пайплайна
  try {
    console.log('[notify] resolving ConversationReference…');
    console.log(`[notify] getEmailByUserName("${userName}") → start`);
    const email = await getEmailByUserName(userName);
    console.log(`[notify] getEmailByUserName("${userName}") →`, email || 'null');
    let conversationReference = null;
    if (email) {
      console.log(`[notify] getReferenceByEmail("${email}") → start`);
      const refResult = await getReferenceByEmail(email);
      console.log('[notify] getReferenceByEmail result type=', Array.isArray(refResult) ? 'array' : typeof refResult);
      console.log('[notify] getReferenceByEmail result preview=', safeStringify(refResult).slice(0, 500));
      conversationReference = resolveConversationReference(refResult);
      console.log('[notify] resolveConversationReference →',
        conversationReference ? `valid=${isValidConversationReference(conversationReference)} serviceUrl=${conversationReference?.serviceUrl} convId=${conversationReference?.conversation?.id}` : 'null');
    }

    console.log('[notify] adapter present=', !!adapter, 'conversationReference present=', !!conversationReference);
    if (adapter && conversationReference) {
      console.log('[notify] calling adapter.continueConversation…');
      await adapter.continueConversation(conversationReference, async (turnContext) => {
        console.log('[notify] continueConversation: building system reply via getChatCompletion…');
        const response = await simpleChatCompletion(
          'System: Du bist Risy – der freundliche, hilfsbereite Assistent für die Mitarbeitenden von RISE PARTNERS Audit GmbH. Formuliere eine kurze, lockere und empathische Nachricht im Du-Tonfall: Hmm... ich muss kurz nachdenken, ich melde mich gleich mit einer Antwort! Halte dich kurz, natürlich und menschlich – gern mit einem passenden Emoji.',
          'Erzeuge jetzt eine kurze, freundliche Hinweis-Nachricht als Antwort auf die Nutzeranfrage'
        );
        const replyText = typeof response === 'string' ? response : response?.reply;
        console.log('[notify] getChatCompletion reply length=', replyText ? replyText.length : 0);
        if (replyText && replyText.trim()) {
          await turnContext.sendActivity({ type: 'message', text: replyText });
        } else {
          console.warn("⚠️ Leere/ungültige OpenAI-Antwort: replyText=", replyText, " raw=", safeStringify(response));
        }
      });
    } else {
      if (!adapter) console.warn('⚠️ Kein Bot-Adapter verfügbar.');
      if (!conversationReference) console.warn('⚠️ Keine gültige ConversationReference gefunden – Vorab-Nachricht wird übersprungen.');
    }
  } catch (e) {
    console.warn('⚠️ Fehler beim Senden der Vorab-Nachricht:', e?.stack || e?.message || e);
  }

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
    console.log('[pipeline] prepareAndIndexSession → start', { sessionId, docs: dokumente.length });
    // 1) Подготовка и индексация
    await prepareAndIndexSession({ sessionId, urls: dokumente });
    console.log('[pipeline] prepareAndIndexSession → done');

    // 2) Ответы по вопросам
    const SYSTEM = 'Du bist ein sachlicher Assistent. Antworte präzise in Deutsch. Antworte als JSON {"answer": string, "quote": string}.';

    for (const frage of fragen) {
      const trimmed = (frage || '').toString().trim();
      console.log('[pipeline] Frage:', trimmed);
      if (!trimmed) {
        results.push({ frage, antwort: 'Leere Frage.', zitat: '' });
        continue;
      }

      const chunks = await vectorSearchTopK({ sessionId, text: trimmed, k: 3 });
      console.log('[pipeline] vectorSearchTopK count=', chunks.length);
      if (chunks.length) {
        console.log('[pipeline] top doc titles:', chunks.map(c => c.document_title).slice(0,3));
      }
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
      } catch (e) {
        console.warn('[pipeline] simpleChatCompletion error:', (e && (e.stack || e.message)) || e);
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
    console.error('[checkliste_dokumente] Pipeline-Fehler:', err?.stack || msg);
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