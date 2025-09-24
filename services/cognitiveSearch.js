// services/cognitiveSearch.js
import 'dotenv/config';
import { SearchClient, AzureKeyCredential } from '@azure/search-documents';
import { saveMessage } from '../storage.js';

const endpoint = process.env.AZURE_SEARCH_ENDPOINT; // e.g. https://risysuchebasis.search.windows.net
const apiKey = process.env.AZURE_SEARCH_API_KEY;
const indexName = process.env.AZURE_SEARCH_INDEX || 'risy-knowledge-rag';
const semanticConfig =
  process.env.AZURE_SEARCH_SEMANTIC_CONFIG || 'risy-knowledge-rag-semantic';

if (!endpoint || !apiKey) {
  console.warn(
    '[cognitiveSearch] Missing AZURE_SEARCH_ENDPOINT or AZURE_SEARCH_API_KEY in env.'
  );
}

const client = new SearchClient(endpoint, indexName, new AzureKeyCredential(apiKey));

async function getStrictSemanticAnswerString(message, sessionId) {
  if (!endpoint || !apiKey || !indexName) {
    return "";
  }

  const apiVersion = '2025-08-01-preview';
  const url = `${endpoint}/indexes('${indexName}')/docs/search?api-version=${apiVersion}`;

  const body = {
    search: message,
    top: 8,
    select: 'document_title,content_text',
    queryType: 'semantic',
    queryLanguage: 'de',
    searchFields: 'content_text,document_title',
    semanticConfiguration: semanticConfig,
    answers: 'extractive|count-3',
    captions: 'extractive|highlight-true',
    count: true,
    vectorQueries: [
      {
        kind: 'text',
        fields: 'content_embedding',
        text: message
      }
    ]
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Prefer': 'odata.include-annotations="*"',
        'api-key': apiKey
      },
      body: JSON.stringify(body)
    });

    const raw = await res.text();
    const json = JSON.parse(raw);

    let resultStr = "";

    if (Array.isArray(json['@search.answers'])) {
      const hasHighScore = json['@search.answers'].some(
        (ans) => typeof ans.score === 'number' && ans.score > 0.9
      );

      if (hasHighScore) {
        const answersHighlights = json['@search.answers']
          .map((ans) => ans.highlights)
          .filter((h) => typeof h === 'string' && h.trim().length > 0)
          .join('\n');

        const firstTwo = Array.isArray(json.value) ? json.value.slice(0, 2) : [];
        const firstTwoContentText = firstTwo
          .map((item) => (typeof item.content_text === 'string' ? item.content_text : ''))
          .filter((text) => text.trim().length > 0)
          .join('\n\n');

        resultStr = `${answersHighlights}\n\n${firstTwoContentText}`.trim();
      }
    }

    try {
      if (sessionId) {
        await saveMessage(sessionId, 'context', resultStr);
      }
    } catch (e) {
      console.warn('[cognitiveSearch] saveMessage failed:', e?.message || e);
    }

    return resultStr;
  } catch (err) {
    console.error('[getStrictSemanticAnswerString] error:', err);
    return "";
  }
}

export { getStrictSemanticAnswerString };
