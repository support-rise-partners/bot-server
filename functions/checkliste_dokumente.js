/*
import path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { BlobServiceClient } from '@azure/storage-blob';
import { pathToFileURL } from 'url';

const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const BLOB_CONTAINER = process.env.AZURE_STORAGE_CONTAINER_TEMP || 'chat-temp-docs';
const SEARCH_ENDPOINT = process.env.AZURE_SEARCH_ENDPOINT; // e.g. https://<service>.search.windows.net
const SEARCH_KEY = process.env.AZURE_SEARCH_API_KEY;
const SEARCH_INDEX = process.env.AZURE_SEARCH_INDEX_TEMP || 'risy-chat-temp';

// Optional: import your simpleChatCompletion helper from your project
// Adjust the import path to your actual helper
import { simpleChatCompletion } from '../services/openai.js';

function req(pathname, method = 'GET', data) {
  return axios({
    method,
    url: `${SEARCH_ENDPOINT}${pathname}`,
    headers: {
      'Content-Type': 'application/json',
      'api-key': SEARCH_KEY
    },
    data
  }).then(r => r.data);
}

function stripReadonlyKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = JSON.parse(JSON.stringify(obj));
  delete clone['@odata.etag'];
  delete clone['@odata.context'];
  return clone;
}

async function createSkillsetFromConfig(baseConfig, nameOverride) {
  const body = stripReadonlyKeys(baseConfig);
  body.name = nameOverride;
  return req('/skillsets?api-version=2025-08-01-preview', 'POST', body);
}

async function createIndexerFromConfig(baseConfig, { name, dataSourceName, targetIndexName, skillsetName }) {
  const body = stripReadonlyKeys(baseConfig);
  body.name = name;
  if (dataSourceName) body.dataSourceName = dataSourceName;
  if (targetIndexName) body.targetIndexName = targetIndexName;
  if (skillsetName) body.skillsetName = skillsetName;
  // не запускаем по расписанию в разовых прогонах
  if (body.schedule) delete body.schedule;
  return req('/indexers?api-version=2025-08-01-preview', 'POST', body);
}

async function ensureContainer(containerClient) {
  try { await containerClient.createIfNotExists(); } catch {}
}

async function uploadDocsToBlob(urls, prefix, containerClient) {
  const uploaded = [];
  for (const url of urls) {
    const nameFromUrl = (() => {
      try {
        const u = new URL(url);
        const base = path.basename(u.pathname) || 'datei';
        return base.slice(0, 120);
      } catch { return 'datei'; }
    })();
    const blobName = `${prefix}/${uuidv4()}_${nameFromUrl}`;
    const blockClient = containerClient.getBlockBlobClient(blobName);
    const res = await axios.get(url, { responseType: 'arraybuffer' });
    await blockClient.uploadData(Buffer.from(res.data), { blobHTTPHeaders: { blobContentType: res.headers['content-type'] || 'application/octet-stream' } });
    uploaded.push({ blobName, url });
  }
  return uploaded;
}

async function ensureSharedIndex() {
  const api = '/indexes?api-version=2025-08-01-preview';
  const list = await req(api, 'GET');

  const VECTOR_PROFILE = process.env.AZURE_SEARCH_VECTOR_PROFILE || 'vector-profile';
  const VECTORIZER_NAME = process.env.AZURE_SEARCH_VECTORIZER_NAME || 'aoai-vectorizer';

  const AOAI_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/$/, '');
  const AOAI_MODEL_NAME = process.env.AZURE_OPENAI_EMBED_MODEL_NAME || 'text-embedding-3-small';
  const AOAI_DEPLOYMENT = process.env.AZURE_OPENAI_EMBED_DEPLOYMENT || process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT || undefined;

  // 1536 для text-embedding-3-small, 3072 для 3-large
  const VECTOR_DIM = Number(process.env.AZURE_SEARCH_EMBED_DIM || (AOAI_MODEL_NAME.includes('3-large') ? 3072 : 1536));

  const exists = (list.value || []).some(i => i.name === SEARCH_INDEX);
  if (exists) {
    try {
      const current = await req(`/indexes/${encodeURIComponent(SEARCH_INDEX)}?api-version=2025-08-01-preview`, 'GET');
      const keyField = (current.fields || []).find(f => f.key);
      const profileOk = !!current.vectorSearch?.profiles?.some(p => p.name === VECTOR_PROFILE);
      const vectorizerOk = !!current.vectorSearch?.vectorizers?.some(v => v.name === VECTORIZER_NAME);
      const dimField = (current.fields || []).find(f => f.name === 'content_embedding');
      const dimOk = dimField && dimField.dimensions === VECTOR_DIM;
      const needsRecreate = !keyField || keyField.name !== 'id' || keyField.analyzer !== 'keyword' || !profileOk || !vectorizerOk || !dimOk;
      if (!needsRecreate) return;
      await req(`/indexes/${encodeURIComponent(SEARCH_INDEX)}?api-version=2025-08-01-preview`, 'DELETE');
    } catch (e) {
      // proceed to create
    }
  }

  if (!AOAI_ENDPOINT || !AOAI_MODEL_NAME) {
    throw new Error('[VECTORIZER] AZURE_OPENAI_ENDPOINT и AZURE_OPENAI_EMBED_MODEL_NAME обязательны для server-side vectorization.');
  }

  const body = {
    name: SEARCH_INDEX,
    fields: [
      { name: 'id', type: 'Edm.String', key: true, searchable: true, analyzer: 'keyword', filterable: true, retrievable: true },
      { name: 'text_document_id', type: 'Edm.String', filterable: true, retrievable: true },
      { name: 'document_title', type: 'Edm.String', retrievable: true },
      { name: 'source_url', type: 'Edm.String', filterable: true, retrievable: true },
      { name: 'metadata_storage_path', type: 'Edm.String', filterable: true, retrievable: true },
      { name: 'metadata_storage_name', type: 'Edm.String', retrievable: true },
      { name: 'content', type: 'Edm.String', searchable: true, analyzer: 'standard.lucene', retrievable: true },
      {
        name: 'content_embedding',
        type: 'Collection(Edm.Single)',
        searchable: true,
        retrievable: true,
        dimensions: VECTOR_DIM,
        vectorSearchProfile: VECTOR_PROFILE
      }
    ],
    vectorSearch: {
      algorithms: [ { name: 'hnsw', kind: 'hnsw' } ],
      vectorizers: [
        {
          name: VECTORIZER_NAME,
          kind: 'azureOpenAI',
          resourceUri: AOAI_ENDPOINT,
          modelName: AOAI_MODEL_NAME,
          ...(AOAI_DEPLOYMENT ? { deploymentName: AOAI_DEPLOYMENT } : {})
        }
      ],
      profiles: [
        { name: VECTOR_PROFILE, algorithm: 'hnsw', vectorizer: VECTORIZER_NAME }
      ]
    }
  };
  await req('/indexes?api-version=2025-08-01-preview', 'POST', body);
}

async function createTempDataSource(prefix, dsName) {
  const body = {
    name: dsName,
    type: 'azureblob',
    credentials: { connectionString: STORAGE_CONN },
    container: { name: BLOB_CONTAINER, query: prefix },
    dataChangeDetectionPolicy: { '@odata.type': '#Microsoft.Azure.Search.HighWaterMarkChangeDetectionPolicy', highWaterMarkColumnName: 'metadata_storage_last_modified' },
    dataDeletionDetectionPolicy: { '@odata.type': '#Microsoft.Azure.Search.SoftDeleteColumnDeletionDetectionPolicy', softDeleteColumnName: 'IsDeleted', softDeleteMarkerValue: 'true' }
  };
  return req('/datasources?api-version=2025-08-01-preview', 'POST', body);
}

async function createAndRunIndexer(dsName, indexerName) {
  const body = {
    name: indexerName,
    dataSourceName: dsName,
    targetIndexName: SEARCH_INDEX,
    parameters: {
      configuration: {
        dataToExtract: 'contentAndMetadata',
        parsingMode: 'default',
        indexedFileNameExtensions: '.pdf,.doc,.docx,.rtf,.txt,.html,.htm,.ppt,.pptx,.xls,.xlsx',
        failOnUnsupportedContentType: false,
        failOnUnprocessableDocument: false
      }
    }
  };
  await req('/indexers?api-version=2025-08-01-preview', 'POST', body);
  await req(`/indexers/${encodeURIComponent(indexerName)}/run?api-version=2025-08-01-preview`, 'POST');
}

async function waitIndexerDone(indexerName, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await req(`/indexers/${encodeURIComponent(indexerName)}/status?api-version=2025-08-01-preview`, 'GET');
    const last = st?.lastResult;
    if (last && ['success','transientFailure','inProgress'].includes(last.status)) {
      if (last.status === 'success') return;
      if (last.status === 'inProgress') { await new Promise(r => setTimeout(r, 2000)); continue; }
      if (last.status === 'transientFailure') { await new Promise(r => setTimeout(r, 2000)); continue; }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

// Helper to escape OData string literals
function odataQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// NOTE: used only as a fallback when server-side vectorization is not available
// Create embedding for a query using Azure OpenAI


async function searchInRunPrefix(question, runPrefixUrl) {
  const common = {
    top: 10,
    select: 'content,metadata_storage_path,metadata_storage_name,document_title,source_url',
    filter: `metadata_storage_path ge ${odataQuote(runPrefixUrl)} and metadata_storage_path lt ${odataQuote(runPrefixUrl + '\\uffff')}`
  };
  const url = `${SEARCH_ENDPOINT}/indexes/${encodeURIComponent(SEARCH_INDEX)}/docs/search?api-version=2025-08-01-preview`;

  // Только server-side text → vector
  const bodyTextVector = {
    ...common,
    vectorQueries: [
      {
        kind: 'text',
        fields: 'content_embedding',
        text: question,
        k: 50
      }
    ]
  };

  try {
    const r = await axios.post(url, bodyTextVector, { headers: { 'api-key': SEARCH_KEY, 'Content-Type': 'application/json' } });
    return r.data?.value || [];
  } catch (e) {
    const details = e?.response?.data || e?.message || e;
    throw new Error(`[VECTOR:text] Server-side vectorization failed. Ensure index vectorizer is configured. Details: ${JSON.stringify(details)}`);
  }
}

async function deleteDocsByPrefix(runPrefixUrl) {
  let skip = 0;
  const pageSize = 1000;
  while (true) {
    const params = new URLSearchParams({
      'api-version': '2025-08-01-preview',
      search: '*',
      $top: String(pageSize),
      $skip: String(skip),
      select: 'metadata_storage_path'
    });
    const url = `${SEARCH_ENDPOINT}/indexes/${encodeURIComponent(SEARCH_INDEX)}/docs?${params.toString()}&$filter=metadata_storage_path%20ge%20${encodeURIComponent("'" + runPrefixUrl.replace(/'/g, "''") + "'")}%20and%20metadata_storage_path%20lt%20${encodeURIComponent("'" + (runPrefixUrl + "\uffff").replace(/'/g, "''") + "'")}`;
    const res = await axios.get(url, { headers: { 'api-key': SEARCH_KEY } });
    const rows = res.data?.value || [];
    if (!rows.length) break;
    const actions = rows.map(r => ({ '@search.action': 'delete', metadata_storage_path: r.metadata_storage_path }));
    await req(`/indexes/${encodeURIComponent(SEARCH_INDEX)}/docs/index?api-version=2025-08-01-preview`, 'POST', { value: actions });
    if (rows.length < pageSize) break;
    skip += rows.length;
  }
}

async function deleteIndexer(name) {
  try { await req(`/indexers/${encodeURIComponent(name)}?api-version=2025-08-01-preview`, 'DELETE'); } catch {}
}
async function deleteDataSource(name) {
  try { await req(`/datasources/${encodeURIComponent(name)}?api-version=2025-08-01-preview`, 'DELETE'); } catch {}
}

export async function runChecklisteDokumente({ tenantId, dokumente, fragen, indexerConfig, skillsetConfig, targetIndexName } = {}) {
  if (!Array.isArray(dokumente) || !Array.isArray(fragen)) throw new Error('dokumente und fragen müssen Arrays sein');
  if (!tenantId || typeof tenantId !== 'string') throw new Error('tenantId (string) ist erforderlich');
  if (!STORAGE_CONN || !SEARCH_ENDPOINT || !SEARCH_KEY) throw new Error('Azure-Konfiguration fehlt');

  const runId = uuidv4();
  const runPrefix = `tenants/${tenantId}/runs/${runId}`; // tenant-scoped isolation for blobs & index

  const blobService = BlobServiceClient.fromConnectionString(STORAGE_CONN);
  const container = blobService.getContainerClient(BLOB_CONTAINER);
  await ensureContainer(container);

  const uploaded = await uploadDocsToBlob(dokumente, runPrefix, container);
  const containerUrl = container.url.replace(/\/$/, '');
  const runPrefixUrl = `${containerUrl}/${runPrefix}`;

  const TARGET_INDEX = targetIndexName || SEARCH_INDEX;
  const OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
  const OPENAI_EMB_DEPLOYMENT = process.env.AZURE_OPENAI_EMBED_DEPLOYMENT || process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT;

  // подготовить финальные конфиги (если не пришли извне)
  let finalSkillsetConfig = skillsetConfig;
  if (!finalSkillsetConfig) {
    finalSkillsetConfig = JSON.parse(JSON.stringify(EMBEDDED_SKILLSET_CONFIG));
    finalSkillsetConfig.indexProjections.selectors[0].targetIndexName = TARGET_INDEX;
    const emb = finalSkillsetConfig.skills.find(s => s['@odata.type'] === '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill');
    if (emb) {
  if (OPENAI_ENDPOINT) emb.resourceUri = OPENAI_ENDPOINT;
  if (OPENAI_EMB_DEPLOYMENT) emb.deploymentId = OPENAI_EMB_DEPLOYMENT;
  emb.modelName = process.env.AZURE_OPENAI_EMBED_MODEL_NAME || emb.modelName || 'text-embedding-3-small';
  emb.dimensions = Number(process.env.AZURE_SEARCH_EMBED_DIM || ((emb.modelName || '').includes('3-large') ? 3072 : 1536));
}
  }

  let finalIndexerConfig = indexerConfig;
  if (!finalIndexerConfig) {
    finalIndexerConfig = JSON.parse(JSON.stringify(EMBEDDED_INDEXER_CONFIG));
  }

  await ensureSharedIndex();
  const dsName = `ds-${runId}`;
  const indexerName = `idxr-${runId}`;
  await createTempDataSource(runPrefix, dsName);

  // создать временный skillset и индексер из конфигов (или fallback)
  let createdSkillsetName;
  if (finalSkillsetConfig) {
    createdSkillsetName = `skillset-${runId}`;
    await createSkillsetFromConfig(finalSkillsetConfig, createdSkillsetName);
  }

  if (finalIndexerConfig) {
    await createIndexerFromConfig(finalIndexerConfig, {
      name: indexerName,
      dataSourceName: dsName,
      targetIndexName: TARGET_INDEX,
      skillsetName: createdSkillsetName
    });
    await req(`/indexers/${encodeURIComponent(indexerName)}/run?api-version=2025-08-01-preview`, 'POST');
  } else {
    await createAndRunIndexer(dsName, indexerName);
  }
  await waitIndexerDone(indexerName);

  const results = [];
  for (const frage of fragen) {
    const hits = await searchInRunPrefix(frage, runPrefixUrl);
    const topHits = (hits || []).slice(0, 5);
    const contextBlocks = topHits.map((h, i) => {
      const text = (h?.content || '').toString().slice(0, 1200);
      const title = h?.metadata_storage_name || 'Unbenannt';
      const url = h?.metadata_storage_path || '';
      return `[#${i + 1}] Titel: ${title}\nURL: ${url}\nText:\n${text}`;
    }).join('\n\n---\n\n');

    const systemText = [
      'Du bist ein präziser Assistent. Antworte knapp auf Deutsch.',
      'Nutze AUSSCHLIESSLICH den bereitgestellten Kontext.',
      'Gib die Antwort und zusätzlich eine WORTWÖRTLICHE Zitierstelle (quote) aus den Text-Abschnitten.',
      'Die quote MUSS ein zusammenhängender, wörtlicher Teilstring aus einem der bereitgestellten "Text:"-Blöcke sein (ohne Paraphrase).',
      'Die quote soll möglichst informativ sein: 200–600 Zeichen, aber NIE mehr als 800 Zeichen.',
      'Wenn keine verlässliche Antwort im Kontext vorhanden ist, setze answer auf "Keine Antwort im Kontext gefunden." und quote auf eine leere Zeichenkette.',
      'Antworte ausschließlich mit strikt gültigem JSON **ohne** Markdown oder Code-Fences, genau im Format {"answer":"...","quote":"..."}. Keine zusätzlichen Erklärungen.'
    ].join(' ');

    const userText = `Frage: ${frage}\n\nKontextausschnitte (#1–#${topHits.length}):\n${contextBlocks}`;

    let antwort = '';
    let quelleQuote = '';
    try {
      const comp = await simpleChatCompletion(systemText, userText);
      const raw = (typeof comp === 'string') ? comp : (comp?.content || comp?.message || '').toString();
      try {
        let cleaned = raw.trim();
        // Strip common code fences if present
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
        }
        // Extract first JSON object if extra text leaked
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          cleaned = cleaned.slice(firstBrace, lastBrace + 1);
        }
        const parsed = JSON.parse(cleaned);
        antwort = (parsed && typeof parsed.answer === 'string') ? parsed.answer.trim() : '';
        quelleQuote = (parsed && typeof parsed.quote === 'string') ? parsed.quote : '';
      } catch (e) {
        // Not valid JSON; treat whole output as answer
        antwort = raw.toString().trim();
      }
    } catch (e) {
      // Fallback, if LLM call fails
      antwort = 'Antwort basierend auf den bereitgestellten Ausschnitten.';
    }

    // (Optional safety) After parsing, enforce max length on quote and trim whitespace.
    if (typeof quelleQuote === 'string') {
      quelleQuote = quelleQuote.trim();
      if (quelleQuote.length > 800) {
        quelleQuote = quelleQuote.slice(0, 800);
      }
    }

    // Fallback for quote: if empty, try to take a short substring from the best hit for transparency
    if (!quelleQuote) {
      const best = topHits[0];
      const bestChunk = (best?.content || '').toString().slice(0, 1200);
      quelleQuote = bestChunk.slice(0, 400);
    }

    results.push({ frage, antwort, quelleChunk: quelleQuote });
  }

  // Cleanup: remove this run's docs from index and blob (isolation + ephemeral processing)
  try { await deleteIndexer(indexerName); } catch {}
  if (createdSkillsetName) { try { await req(`/skillsets/${encodeURIComponent(createdSkillsetName)}?api-version=2025-08-01-preview`, 'DELETE'); } catch {} }
  try { await deleteDataSource(dsName); } catch {}
  try { await deleteDocsByPrefix(runPrefixUrl); } catch {}
  try {
    for await (const b of container.listBlobsFlat({ prefix: runPrefix })) {
      const client = container.getBlockBlobClient(b.name);
      await client.deleteIfExists();
    }
  } catch {}

  return results;
}


// Embedded minimal configs for skillset and indexer, will hydrate placeholders at runtime
const EMBEDDED_SKILLSET_CONFIG = {
  name: "__will_be_overridden__",
  description: "Text-only pipeline: Split → Chunk → Embeddings",
  skills: [
    {
      "@odata.type": "#Microsoft.Skills.Text.SplitSkill",
      name: "split-to-pages",
      description: "Split full document text into pages",
      context: "/document",
      defaultLanguageCode: "de",
      textSplitMode: "pages",
      maximumPageLength: 6000,
      pageOverlapLength: 0,
      maximumPagesToTake: 0,
      unit: "characters",
      inputs: [{ name: "text", source: "/document/content", inputs: [] }],
      outputs: [{ name: "textItems", targetName: "pages" }]
    },
    {
      "@odata.type": "#Microsoft.Skills.Text.SplitSkill",
      name: "split-pages-to-chunks",
      description: "Chunk pages into overlapping segments",
      context: "/document/pages/*",
      defaultLanguageCode: "de",
      textSplitMode: "pages",
      maximumPageLength: 900,
      pageOverlapLength: 150,
      maximumPagesToTake: 100000,
      unit: "characters",
      inputs: [{ name: "text", source: "/document/pages/*", inputs: [] }],
      outputs: [{ name: "textItems", targetName: "chunks" }]
    },
{
  "@odata.type": "#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill",
  name: "embed-chunks",
  description: "Compute embeddings for each chunk",
  context: "/document/pages/*/chunks/*",
  resourceUri: "__will_be_overridden__",
  deploymentId: "__will_be_overridden__",
  dimensions: Number(process.env.AZURE_SEARCH_EMBED_DIM || ((process.env.AZURE_OPENAI_EMBED_MODEL_NAME || '').includes('3-large') ? 3072 : 1536)),
  modelName: process.env.AZURE_OPENAI_EMBED_MODEL_NAME || "text-embedding-3-small",
  inputs: [{ name: "text", source: "/document/pages/*/chunks/*", inputs: [] }],
  outputs: [{ name: "embedding", targetName: "chunk_vector" }]
}
  ],
  indexProjections: {
    selectors: [
      {
        targetIndexName: "__will_be_overridden__",
        parentKeyFieldName: "text_document_id",
        sourceContext: "/document/pages/*/chunks/*",
        mappings: [
          { name: 'content',              source: '/document/pages/*/chunks/*', inputs: [] },
          { name: 'content_embedding',    source: '/document/pages/*/chunks/*/chunk_vector', inputs: [] },
          { name: 'document_title',       source: '/document/document_title', inputs: [] },
          { name: 'source_url',           source: '/document/metadata_storage_path', inputs: [] },
          { name: 'metadata_storage_path',source: '/document/metadata_storage_path', inputs: [] },
          { name: 'metadata_storage_name',source: '/document/metadata_storage_name', inputs: [] }
        ]
      }
    ],
    parameters: { projectionMode: "skipIndexingParentDocuments" }
  }
};

const EMBEDDED_INDEXER_CONFIG = {
  name: "__will_be_overridden__",
  description: null,
  dataSourceName: "__will_be_overridden__",
  skillsetName: "__will_be_overridden__",
  targetIndexName: "__will_be_overridden__",
  disabled: false,
  parameters: {
    batchSize: 1,
    maxFailedItems: -1,
    maxFailedItemsPerBatch: 0,
    configuration: {
      allowSkillsetToReadFileData: true,
      dataToExtract: "contentAndMetadata",
      parsingMode: "default",
      failOnUnsupportedContentType: false,
      indexStorageMetadataOnlyForOversizedDocuments: true,
      failOnUnprocessableDocument: false
    }
  },
  fieldMappings: [
    { sourceFieldName: "metadata_storage_name", targetFieldName: "document_title" },
    { sourceFieldName: "metadata_storage_path", targetFieldName: "source_url" },
    { sourceFieldName: "metadata_storage_path", targetFieldName: "text_document_id", mappingFunction: { name: "base64Encode" } }
  ],
  outputFieldMappings: []
};

// ------------------------------------------------------------
// Smoke test runner (executes only when explicitly enabled)
// Usage examples:
//   RUN_DOCS_SMOKE=1 node bot-server/functions/checkliste_dokumente.js
//   RUN_DOCS_SMOKE=1 DOC_URLS="https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf,https://www.orimi.com/pdf-test.pdf" \
//     QUESTIONS="Was steht im Dokument?; Nenne die erste Überschrift." \
//     node bot-server/functions/checkliste_dokumente.js
// ------------------------------------------------------------
async function __runSmokeTest() {
  const defDocs = [
    'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf'
  ];
  const envDocs = (process.env.DOC_URLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const dokumente = envDocs.length ? envDocs : defDocs;

  const defFragen = [
    'Worum geht es im Dokument?'
  ];
  const envQs = (process.env.QUESTIONS || '')
    .split(/;|\n/)
    .map(s => s.trim())
    .filter(Boolean);
  const fragen = envQs.length ? envQs : defFragen;

  console.log('[SMOKE] Using documents:', dokumente);
  console.log('[SMOKE] Using questions:', fragen);

  try {
    const results = await runChecklisteDokumente({ tenantId: process.env.TEST_TENANT_ID || 'demo-tenant', dokumente, fragen });
    console.log('\n[SMOKE] Ergebnisse:');
    for (const r of results) {
      console.log('---');
      console.log('Frage      :', r.frage);
      console.log('Antwort    :', r.antwort);
      console.log('QuelleChunk:', (r.quelleChunk || '').slice(0, 300).replace(/\s+/g, ' ').trim());
    }
    console.log('\n[SMOKE] Fertig.');
  } catch (e) {
    console.error('[SMOKE] Fehler beim Testlauf:', e?.response?.data || e?.message || e);
    process.exitCode = 1;
  }
}

// ESM-safe main check for smoke test
const __isMain = import.meta && import.meta.url === pathToFileURL(process.argv[1]).href;
if (__isMain && process.env.RUN_DOCS_SMOKE === '1') {
  __runSmokeTest();
}
*/




//  ,
//  {
//    "name": "checkliste_dokumente",
//    "description": "Erfasst aus dem Chatverlauf die Links zu übermittelten Dokumenten sowie die Liste der Fragen, auf die in diesen Dokumenten Antworten gefunden werden sollen.",
//    "parameters": {
//      "type": "object",
//      "properties": {
//        "dokumente": {
//          "type": "array",
//          "items": { "type": "string", "format": "uri" },
//          "description": "Vom Verlauf erkannte Links/URLs zu Dokumenten (PDF, DOCX). Bitte aus der Chat-Historie extrahieren."
//        },
//        "fragen": {
//          "type": "array",
//          "items": { "type": "string" },
//          "description": "Fragen, auf die in den übermittelten Dokumenten Antworten gefunden werden sollen. Bitte aus der Chat-Historie extrahieren."
//        }
//      },
//      "required": ["dokumente", "fragen"]
//    }
//  }