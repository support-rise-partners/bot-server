import { SearchIndexClient, SearchIndexerClient, SearchClient, AzureKeyCredential } from '@azure/search-documents';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

// Werte aus .env (exakt wie in deiner Umgebung benannt)
const AZURE_SEARCH_ENDPOINT = (process.env.AZURE_SEARCH_ENDPOINT || '').trim();
const AZURE_SEARCH_API_KEY = (process.env.AZURE_SEARCH_API_KEY || '').trim();
const AZURE_OPENAI_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || '').trim();
const AZURE_OPENAI_EMBED_DEPLOYMENT = (process.env.AZURE_OPENAI_EMBED_DEPLOYMENT || '').trim();
const AZURE_STORAGE_CONNECTION_STRING = (process.env.AZURE_STORAGE_CONNECTION_STRING || '').trim();

const OPENAI_ENDPOINT   = (process.env.OPENAI_ENDPOINT || '').trim();
const OPENAI_KEY        = (process.env.OPENAI_KEY || '').trim();
const OPENAI_DEPLOYMENT = (process.env.OPENAI_DEPLOYMENT || 'gpt-4o').trim();
const OPENAI_VERSION    = (process.env.OPENAI_VERSION || '2024-12-01-preview').trim();

function ensureHttpsEndpoint(url, varName) {
  if (!url) throw new Error(`Env-Variable ${varName} ist nicht gesetzt`);
  if (!/^https?:\/\//i.test(url)) throw new Error(`Env-Variable ${varName} muss mit https:// beginnen`);
  return url.replace(/\/$/, '');
}

const SEARCH_ENDPOINT = ensureHttpsEndpoint(AZURE_SEARCH_ENDPOINT, 'AZURE_SEARCH_ENDPOINT');

const API_MGMT  = '2025-08-01-preview';

const embeddingDimensions = 1536;

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function parseJsonSafe(raw) {
  const s = typeof raw === 'string' ? raw.trim() : String(raw || '');
  const fenced = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(fenced); } catch {}
  const m = s.match(/\{[\s\S]*\}$/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

import crypto from 'node:crypto';

function buildAcsName(prefix, sessionId) {
  // 1) Normalisieren
  let slug = (sessionId || '').toString().toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')     // nur a-z0-9-
    .replace(/-{2,}/g, '-')          // mehrere - zu einem
    .replace(/^-+|-+$/g, '');        // trim -

  // 2) Hash für Eindeutigkeit
  const hash = crypto.createHash('sha1').update(String(sessionId || 'sess')).digest('hex').slice(0, 8);

  // 3) Max-Länge beachten: insgesamt <=128
  //   finale Form: `${prefix}${slug}-${hash}`
  const maxTotal = 128;
  const fixed = `${prefix}`; // prefix wie "ds-", "ss-", "idx-", "idxr-"
  const tail = `-${hash}`;
  const maxSlugLen = Math.max(1, maxTotal - fixed.length - tail.length);
  if (slug.length > maxSlugLen) slug = slug.slice(0, maxSlugLen);

  // Wenn slug nach Kürzung leer ist, nutze 's'
  if (!slug) slug = 's';

  // 4) Zusammensetzen (Prefix enthält nur a-z0-9- und endet nicht mit - in unseren Aufrufen)
  let name = `${fixed}${slug}${tail}`;

  // Sicherheits-Trim, falls doch mal ein - am Ende landet
  name = name.replace(/^-+|-+$/g, '');

  return name;
}

function resourceNames(sessionId) {
  return {
    dataSourceName: buildAcsName('ds-', sessionId),
    skillsetName: buildAcsName('ss-', sessionId),
    indexName: buildAcsName('idx-', sessionId),
    indexerName: buildAcsName('idxr-', sessionId),
    prefix: `runs/${sessionId}/`
  };
}

async function uploadSessionBlobsFromUrls(sessionId, urls) {
  if (!AZURE_STORAGE_CONNECTION_STRING) throw new Error('AZURE_STORAGE_CONNECTION_STRING ist nicht gesetzt');
  const { prefix } = resourceNames(sessionId);
  const blobService = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
  const container = blobService.getContainerClient('chat-temp-docs');
  await container.createIfNotExists();
  const uploaded = [];
  let i = 0;
  for (const url of urls || []) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download fehlgeschlagen: ${url} -> ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (/\.\w{2,5}(?:$|\?)/.exec(url) || [''])[0].split('?')[0] || '';
    const blobName = `${prefix}${String(++i).padStart(3,'0')}${ext || ''}`;
    const blockBlob = container.getBlockBlobClient(blobName);
    await blockBlob.uploadData(buf, { blobHTTPHeaders: { blobContentType: res.headers.get('content-type') || undefined } });
    uploaded.push(blobName);
  }
  return { container: 'chat-temp-docs', uploaded, prefix };
}

const credential = AZURE_SEARCH_API_KEY
  ? new AzureKeyCredential(AZURE_SEARCH_API_KEY)
  : new DefaultAzureCredential();

const indexClient = new SearchIndexClient(SEARCH_ENDPOINT, credential);
const indexerClient = new SearchIndexerClient(SEARCH_ENDPOINT, credential);

async function createOrUpdateTempIndex(sessionId) {
  const { indexName } = resourceNames(sessionId);
  const name = indexName;

  const definition = {
    name,
    fields: [
      { name: 'content_id',        type: 'Edm.String', searchable: true, filterable: false, retrievable: true, stored: true, sortable: true, facetable: false, key: true, analyzer: 'keyword', synonymMaps: [] },
      { name: 'text_document_id',  type: 'Edm.String', searchable: false, filterable: true,  retrievable: true, stored: true, sortable: false, facetable: false, key: false, synonymMaps: [] },
      { name: 'document_title',    type: 'Edm.String', searchable: true,  filterable: false, retrievable: true, stored: true, sortable: false, facetable: false, key: false, synonymMaps: [] },
      { name: 'content_text',      type: 'Edm.String', searchable: true,  filterable: false, retrievable: true, stored: true, sortable: false, facetable: false, key: false, synonymMaps: [] },
      { name: 'source_url',        type: 'Edm.String', searchable: false, filterable: true,  retrievable: true, stored: true, sortable: false, facetable: false, key: false, synonymMaps: [] },
      { name: 'content_embedding', type: 'Collection(Edm.Single)', searchable: true, filterable: false, retrievable: true, stored: true, sortable: false, facetable: false, key: false, dimensions: embeddingDimensions, vectorSearchProfile: 'risy-knowledge-rag-text-profile', synonymMaps: [] }
    ],
    scoringProfiles: [],
    suggesters: [],
    analyzers: [],
    normalizers: [],
    tokenizers: [],
    tokenFilters: [],
    charFilters: [],
    similarity: { '@odata.type': '#Microsoft.Azure.Search.BM25Similarity' },
    semantic: {
      defaultConfiguration: 'risy-knowledge-rag-semantic',
      configurations: [
        {
          name: 'risy-knowledge-rag-semantic',
          flightingOptIn: false,
          rankingOrder: 'BoostedRerankerScore',
          prioritizedFields: {
            titleField: { fieldName: 'document_title' },
            prioritizedContentFields: [ { fieldName: 'content_text' } ],
            prioritizedKeywordsFields: []
          }
        }
      ]
    },
    vectorSearch: {
      algorithms: [
        {
          name: 'risy-knowledge-rag-hnsw',
          kind: 'hnsw',
          hnswParameters: { metric: 'cosine', m: 4, efConstruction: 400, efSearch: 500 }
        }
      ],
      profiles: [
        {
          name: 'risy-knowledge-rag-text-profile',
          algorithm: 'risy-knowledge-rag-hnsw',
          vectorizer: 'risy-knowledge-rag-text-vectorizer'
        }
      ],
      vectorizers: [
        {
          name: 'risy-knowledge-rag-text-vectorizer',
          kind: 'azureOpenAI',
          azureOpenAIParameters: {
            resourceUri: AZURE_OPENAI_ENDPOINT,
            deploymentId: AZURE_OPENAI_EMBED_DEPLOYMENT,
            modelName: AZURE_OPENAI_EMBED_DEPLOYMENT
          }
        }
      ],
      compressions: []
    }
  };

  try {
    await indexClient.createOrUpdateIndex(definition);
  } catch (error) {
    console.error('Error creating or updating index:', error);
    throw error;
  }
}

async function ensureSkillset(sessionId) {
  const { skillsetName, indexName: targetIndexName } = resourceNames(sessionId);

  const body = {
    name: skillsetName,
    description: 'Stable text-only pipeline: Split -> Chunk -> Embeddings (uses /document/content from indexer)',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
        name: 'split-to-pages',
        description: 'Split full document text into pages',
        context: '/document',
        defaultLanguageCode: 'de',
        textSplitMode: 'pages',
        maximumPageLength: 6000,
        pageOverlapLength: 0,
        maximumPagesToTake: 0,
        unit: 'characters',
        inputs: [ { name: 'text', source: '/document/content', inputs: [] } ],
        outputs: [ { name: 'textItems', targetName: 'pages' } ]
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
        name: 'split-pages-to-chunks',
        description: 'Chunk pages into overlapping segments',
        context: '/document/pages/*',
        defaultLanguageCode: 'de',
        textSplitMode: 'pages',
        maximumPageLength: 2000,
        pageOverlapLength: 200,
        maximumPagesToTake: 100000,
        unit: 'characters',
        inputs: [ { name: 'text', source: '/document/pages/*', inputs: [] } ],
        outputs: [ { name: 'textItems', targetName: 'chunks' } ]
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill',
        name: 'embed-chunks',
        description: 'Compute embeddings for each chunk',
        context: '/document/pages/*/chunks/*',
        resourceUri: AZURE_OPENAI_ENDPOINT,
        deploymentId: AZURE_OPENAI_EMBED_DEPLOYMENT,
        dimensions: 1536,
        modelName: AZURE_OPENAI_EMBED_DEPLOYMENT,
        inputs: [ { name: 'text', source: '/document/pages/*/chunks/*', inputs: [] } ],
        outputs: [ { name: 'embedding', targetName: 'chunk_vector' } ]
      }
    ],
    indexProjections: {
      selectors: [
        {
          targetIndexName,
          parentKeyFieldName: 'text_document_id',
          sourceContext: '/document/pages/*/chunks/*',
          mappings: [
            { name: 'content_text',      source: '/document/pages/*/chunks/*', inputs: [] },
            { name: 'content_embedding', source: '/document/pages/*/chunks/*/chunk_vector', inputs: [] },
            { name: 'document_title',    source: '/document/document_title', inputs: [] },
            { name: 'source_url',        source: '/document/metadata_storage_path', inputs: [] }
          ]
        }
      ],
      parameters: { projectionMode: 'skipIndexingParentDocuments' }
    }
  };

  try {
    await indexerClient.createOrUpdateSkillset(body);
  } catch (error) {
    console.error('Error creating or updating skillset:', error);
    throw error;
  }
}

async function ensureDataSource(sessionId) {
  const { dataSourceName, prefix } = resourceNames(sessionId);

  const body = {
    name: dataSourceName,
    description: 'Data source for temporary chat session documents',
    type: 'azureblob',
    credentials: { connectionString: AZURE_STORAGE_CONNECTION_STRING },
    container: { name: 'chat-temp-docs', query: prefix }
    // Hinweis: dataDeletionDetectionPolicy ausgelassen, da die verwendete SDK-Version/Api-Version
    // den Typ '#Microsoft.Azure.Search.NativeBlobSoftDeleteDeletionDetectionPolicy' nicht kennt.
    // Für temporäre Sessions ist die Lösch-Erkennung nicht zwingend nötig.
  };

  try {
    // Try to create or update data source
    await indexerClient.createOrUpdateDataSourceConnection(body);
  } catch (error) {
    console.error('Error creating or updating data source:', error);
    throw error;
  }
}

async function ensureIndexer(sessionId) {
  const { indexerName, dataSourceName, skillsetName, indexName: targetIndexName } = resourceNames(sessionId);

  const body = {
    name: indexerName,
    description: null,
    dataSourceName,
    skillsetName,
    targetIndexName,
    disabled: false,
    schedule: null,
    parameters: {
      batchSize: 1,
      maxFailedItems: -1,
      maxFailedItemsPerBatch: 0,
      configuration: {
        allowSkillsetToReadFileData: true,
        dataToExtract: 'contentAndMetadata',
        parsingMode: 'default',
        failOnUnsupportedContentType: false,
        indexStorageMetadataOnlyForOversizedDocuments: true,
        failOnUnprocessableDocument: false
      }
    },
    fieldMappings: [
      { sourceFieldName: 'metadata_storage_name', targetFieldName: 'document_title' },
      { sourceFieldName: 'metadata_storage_path', targetFieldName: 'source_url' },
      { sourceFieldName: 'metadata_storage_path', targetFieldName: 'text_document_id', mappingFunction: { name: 'base64Encode' } }
    ],
    outputFieldMappings: []
  };

  try {
    await indexerClient.createOrUpdateIndexer(body);
  } catch (error) {
    console.error('Error creating or updating indexer:', error);
    throw error;
  }
}

async function runIndexerAndWait(sessionId, { timeoutMs = 300000, pollMs = 2000 } = {}) {
  const { indexerName } = resourceNames(sessionId);
  await indexerClient.runIndexer(indexerName);
  const started = Date.now();
  for (;;) {
    const status = await indexerClient.getIndexerStatus(indexerName);
    const last = status?.lastResult;
    if (last?.status === 'success') return last;
    if (last?.status === 'transientFailure' || last?.status === 'error') {
      throw new Error(`Indexer-Fehler: ${last?.errorMessage || 'unbekannt'}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error('Indexer timeout');
    await delay(pollMs);
  }
}

async function vectorSearchTopK(sessionId, { text, k = 3, select = ['document_title','content_text'] }) {
  const { indexName } = resourceNames(sessionId);
  const searchClient = new SearchClient(SEARCH_ENDPOINT, indexName, credential);
  const results = [];
  const iter = searchClient.search('', {
    top: k,
    select,
    vectorQueries: [{ kind: 'text', fields: 'content_embedding', text, k }]
  });
  for await (const r of iter.results) {
    results.push(r.document);
  }
  return results;
}

async function simpleChatCompletion(systemPromptText, userPromptText) {
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_EMBED_DEPLOYMENT) {
    // Если нет эмбеддингового деплоймента — используем обычный чат по OPENAI_* (как у тебя в .env)
    if (!OPENAI_ENDPOINT || !OPENAI_KEY) throw new Error('OPENAI_ENDPOINT/OPENAI_KEY nicht gesetzt');
    const url = `${OPENAI_ENDPOINT}/openai/deployments/${OPENAI_DEPLOYMENT}/chat/completions?api-version=${OPENAI_VERSION}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': OPENAI_KEY },
      body: JSON.stringify({
        messages: [ { role: 'system', content: systemPromptText }, { role: 'user', content: userPromptText } ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      })
    });
    if (!resp.ok) throw new Error(`OpenAI Chat Fehler: ${resp.status}`);
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content || '';
  }
  // Фоллбек: если хотите, можно здесь поддержать другой Azure OpenAI чат-деплоймент
  throw new Error('Bitte konfiguriere OPENAI_* für Chat Completion.');
}

export default async function checkliste_dokumente(sessionId, userName, args = {}) {
  const dokumente = Array.isArray(args?.dokumente) ? args.dokumente : [];
  const fragen    = Array.isArray(args?.fragen) ? args.fragen : [];

  if (!dokumente.length) {
    const msg = 'Keine Dokumente übermittelt — bitte hänge PDF/DOCX-Links an.';
    console.log([]);
    return [];
  }

  // 1) Upload in Blob unter runs/<sessionId>/
  await uploadSessionBlobsFromUrls(sessionId, dokumente);

  // 2) Temporäre Ressourcen anlegen (DataSource -> Index -> Skillset -> Indexer)
  await ensureDataSource(sessionId);
  await createOrUpdateTempIndex(sessionId);
  await ensureSkillset(sessionId);
  await ensureIndexer(sessionId);

  // 3) Indexer starten und auf Abschluss warten
  await runIndexerAndWait(sessionId, { timeoutMs: 300000, pollMs: 2000 });

  // 4) Для каждой Frage: векторный поиск -> чат-форматирование
  const results = [];
  const SYSTEM = 'Du bist ein sachlicher Assistent. Antworte präzise in Deutsch. Antworte als JSON {"answer": string, "quote": string}.';

  for (const frage of fragen) {
    const chunks = await vectorSearchTopK(sessionId, { text: frage, k: 3 });
    if (!chunks.length) {
      results.push({ frage, antwort: 'Keine fundierte Antwort in den Dokumenten gefunden.', zitat: '' });
      continue;
    }
    const context = chunks.map((c, i) => `# Chunk ${i+1} — ${c.document_title}\n${c.content_text}`).join('\n\n');
    const USER = `Frage: ${frage}\n\nKontext (relevante Chunks):\n${context}\n\nFormatiere die Antwort als JSON.`;
    const raw = await simpleChatCompletion(SYSTEM, USER);
    const parsed = parseJsonSafe(raw);
    const antwort = parsed?.answer || (typeof raw === 'string' ? raw : '');
    const zitat   = parsed?.quote  || (chunks[0]?.content_text || '').slice(0, 600);
    results.push({ frage, antwort, zitat });
  }

  // 5) Вывод в консоль ТОЛЬКО массива результатов
  console.log(results);
  return results;
}

export {
  createOrUpdateTempIndex,
  ensureSkillset,
  ensureDataSource,
  ensureIndexer,
  resourceNames,
  uploadSessionBlobsFromUrls,
  runIndexerAndWait,
  vectorSearchTopK
};