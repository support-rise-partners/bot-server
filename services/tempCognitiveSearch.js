

/**
 * tempCognitiveSearch.js
 * 
 * Erstellt temporäre Azure Cognitive Search Ressourcen, lädt Blobs hoch, startet Indexer,
 * führt reinen Vektor-Suchlauf durch und räumt Ressourcen auf.
 * 
 * Erwartet, dass das Skillset "chat-temp-skillset" existiert (permanent)
 * und indexProjections in den Index "chat-temp" (oder einen übergebenen) verwendet.
 * 
 * ENV (mindestens):
 *  AZURE_SEARCH_ENDPOINT=https://<service>.search.windows.net
 *  AZURE_SEARCH_API_KEY=<admin oder query key, siehe unten>
 *  AZURE_OPENAI_ENDPOINT=https://<your-openai>.openai.azure.com
 *  AZURE_OPENAI_EMBED_DEPLOYMENT=text-embedding-ada-002
 *  AZURE_STORAGE_CONNECTION_STRING=...
 *  BLOB_CONTAINER=chat-temp-docs   (Standard)
 * 
 * API-Versionen:
 *  - Verwaltung (Indizes/Skillset/Indexer): 2023-11-01
 *  - Suche (Vektor): 2025-08-01-preview
 */

import crypto from 'crypto';
import axios from 'axios';
import { BlobServiceClient } from '@azure/storage-blob';

// Umgebungsvariablen und Konfiguration
const SEARCH_ENDPOINT = process.env.AZURE_SEARCH_ENDPOINT;     // z.B. https://risysuchebasis.search.windows.net
const SEARCH_API_KEY  = process.env.AZURE_SEARCH_API_KEY;      // Admin-Key (auch für Query geeignet)
const API_MGMT  = '2023-11-01';
const API_QUERY = '2025-08-01-preview';

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const BLOB_CONTAINER = 'chat-temp-docs';

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_EMBED_DEPLOYMENT = process.env.AZURE_OPENAI_EMBED_DEPLOYMENT;

// Axios-Clients für Management und Suche
const mgmt = axios.create({
  baseURL: SEARCH_ENDPOINT,
  headers: { 'api-key': SEARCH_API_KEY, 'Content-Type': 'application/json' },
  params: { 'api-version': API_MGMT }
});
const queryClient = axios.create({
  baseURL: `${SEARCH_ENDPOINT}/indexes`,
  headers: { 'api-key': SEARCH_API_KEY, 'Content-Type': 'application/json' },
  params: { 'api-version': API_QUERY }
});

// Gemeinsame Fehler-Logging-Hilfsfunktion
function logAxiosError(err, label = 'request') {
  const status = err?.response?.status;
  const headers = err?.response?.headers;
  const data = err?.response?.data;
  const msg = err?.message || String(err);
  console.error(`[ACS ${label}] Fehler:`, msg);
  if (status) console.error(`[ACS ${label}] Status:`, status);
  if (headers) console.error(`[ACS ${label}] Headers:`, headers);
  if (data) console.error(`[ACS ${label}] Body:`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
}

// Hilfsfunktionen
function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

// Sanitizer für Azure Cognitive Search Ressourcennamen (Session-IDs)
function sanitizeForAcsName(input) {
  const raw = String(input || '').toLowerCase();
  // Ersetze alle Nicht-[a-z0-9-] durch '-'
  let s = raw.replace(/[^a-z0-9-]+/g, '-');
  // Doppelte Bindestriche zusammenfassen
  s = s.replace(/-+/g, '-');
  // Trim führende/abschließende '-'
  s = s.replace(/^-+/, '').replace(/-+$/, '');
  if (!s) s = 's';
  // Hash-Suffix zur Kollisionsvermeidung
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  // Grundname plus Hash, getrennt mit '-'
  let name = `${s}-${hash}`;
  // Max. 128 Zeichen
  if (name.length > 128) {
    // Kürze Grundname, sodass insgesamt 128 bleibt
    const keep = 128 - (hash.length + 1);
    name = `${s.slice(0, Math.max(1, keep))}-${hash}`;
    name = name.replace(/-+$/, '');
  }
  // Sicherheits-Trim, falls nach Kürzung '-' vorn/hinten entstanden
  name = name.replace(/^-+/, '').replace(/-+$/, '');
  // Leere Namen vermeiden
  if (!name) name = hash;
  return name;
}

function buildAcsName(prefix, sessionId) {
  const sid = sanitizeForAcsName(sessionId);
  const max = 128;
  let name = `${prefix}${sid}`;
  if (name.length > max) {
    const keep = Math.max(1, max - prefix.length);
    name = `${prefix}${sid.slice(0, keep)}`;
  }
  // Sicherheit: keine Bindestriche am Anfang/Ende
  name = name.replace(/^-+/, '').replace(/-+$/, '');
  return name;
}

function resourceNames(sessionId) {
  return {
    dataSourceName: buildAcsName('ds-', sessionId),
    skillsetName:   buildAcsName('ss-', sessionId),
    indexName:      buildAcsName('idx-', sessionId),
    indexerName:    buildAcsName('idxr-', sessionId),
    prefix:         `runs/${sessionId}/` // Präfix im Blob darf original bleiben
  };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Lädt Dateien in Blob Storage hoch (pro Sitzung)
async function uploadSessionBlobsFromUrls({ sessionId, urls, container = BLOB_CONTAINER, prefix }) {
  requireEnv('AZURE_STORAGE_CONNECTION_STRING');

  const bs = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
  const cont = bs.getContainerClient(container);
  await cont.createIfNotExists();

  const folder = prefix || resourceNames(sessionId).prefix;
  const results = [];

  for (const url of urls) {
    const fileName = (url.split('?')[0].split('/').pop() || `file-${Date.now()}`);
    const blobName = `${folder}${fileName}`;
    const block = cont.getBlockBlobClient(blobName);

    if (url.startsWith('https://') && url.includes('.blob.core.') && url.includes('?')) {
      // Serverseitiges Kopieren per SAS
      await block.beginCopyFromURL(url);
    } else {
      const resp = await axios.get(url, { responseType: 'arraybuffer' });
      const contentType = resp.headers['content-type'] || 'application/octet-stream';
      await block.uploadData(resp.data, { blobHTTPHeaders: { blobContentType: contentType } });
    }
    results.push({ url, blobPath: `${container}/${blobName}` });
  }

  return { container, prefix: folder, items: results };
}

// Erstellt oder aktualisiert Datenquelle mit Sitzungs-Präfix
async function ensureDataSource({ sessionId, container = BLOB_CONTAINER, prefix }) {
  requireEnv('AZURE_STORAGE_CONNECTION_STRING');
  const { dataSourceName } = resourceNames(sessionId);
  const effectivePrefix = prefix || resourceNames(sessionId).prefix;

  const body = {
    name: dataSourceName,
    description: 'Data source for temporary chat session documents',
    type: 'azureblob',
    credentials: {
      // Authentifizierung nur noch über Connection String
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING
    },
    container: {
      name: container,
      query: effectivePrefix // Filter für Sitzungsordner
    },
    dataDeletionDetectionPolicy: {
      '@odata.type': '#Microsoft.Azure.Search.NativeBlobSoftDeleteDeletionDetectionPolicy'
    }
  };

  try {
    await mgmt.put(`/datasources/${encodeURIComponent(dataSourceName)}`, body);
  } catch (err) {
    logAxiosError(err, 'PUT /datasources');
    throw err;
  }
  return dataSourceName;
}

// Erstellt oder aktualisiert temporären Index für diese Sitzung
async function createOrUpdateTempIndex({ sessionId, indexName, embeddingDimensions = 1536 }) {
  const { indexName: defaultIndex } = resourceNames(sessionId);
  const name = indexName || defaultIndex;

  const definition = {
    name,
    fields: [
      { name: 'content_id',        type: 'Edm.String', key: true, analyzer: 'keyword', searchable: true, retrievable: true, filterable: false, sortable: true, facetable: false },
      { name: 'text_document_id',  type: 'Edm.String', searchable: false, filterable: true, retrievable: true },
      { name: 'document_title',    type: 'Edm.String', searchable: true,  filterable: false, retrievable: true },
      { name: 'content_text',      type: 'Edm.String', searchable: true,  filterable: false, retrievable: true },
      { name: 'source_url',        type: 'Edm.String', searchable: false, filterable: true, retrievable: true },
      { name: 'content_embedding', type: 'Collection(Edm.Single)', retrievable: true, searchable: true, dimensions: embeddingDimensions, vectorSearchProfile: 'risy-knowledge-rag-text-profile' }
    ],
    similarity: { '@odata.type': '#Microsoft.Azure.Search.BM25Similarity' },
    semantic: {
      defaultConfiguration: 'risy-knowledge-rag-semantic',
      configurations: [
        {
          name: 'risy-knowledge-rag-semantic',
          // rankingOrder: 'BoostedRerankerScore', // Removed for API version 2023-11-01
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
    await mgmt.put(`/indexes/${encodeURIComponent(name)}`, definition);
  } catch (err) {
    logAxiosError(err, 'PUT /indexes');
    throw err;
  }
  return name;
}

// Aktualisiert Skillset (setzt Selector auf Zielindex)
async function ensureSkillset({ sessionId, targetIndexName }) {
  const { skillsetName } = resourceNames(sessionId);

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
    await mgmt.put(`/skillsets/${encodeURIComponent(skillsetName)}`, body);
  } catch (err) {
    logAxiosError(err, 'PUT /skillsets');
    throw err;
  }
  return skillsetName;
}

// Erstellt temporären Indexer (ohne Zeitplan) für Sitzungsindex
async function ensureIndexer({ sessionId, targetIndexName }) {
  const { indexerName, dataSourceName, skillsetName } = resourceNames(sessionId);

  const body = {
    name: indexerName,
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
      { sourceFieldName: 'metadata_storage_name', targetFieldName: 'document_title', mappingFunction: null },
      { sourceFieldName: 'metadata_storage_path', targetFieldName: 'source_url', mappingFunction: null },
      { sourceFieldName: 'metadata_storage_path', targetFieldName: 'text_document_id', mappingFunction: { name: 'base64Encode', parameters: null } }
    ],
    outputFieldMappings: []
  };

  try {
    await mgmt.put(`/indexers/${encodeURIComponent(indexerName)}`, body);
  } catch (err) {
    logAxiosError(err, 'PUT /indexers');
    throw err;
  }
  return indexerName;
}

// Startet Indexer und wartet auf Abschluss (Polling)
async function runIndexerAndWait({ sessionId, timeoutMs = 10 * 60 * 1000, pollMs = 3000 }) {
  const { indexerName } = resourceNames(sessionId);
  try { await mgmt.post(`/indexers/${encodeURIComponent(indexerName)}/run`); }
  catch (err) { logAxiosError(err, 'POST /indexers/run'); throw err; }

  const start = Date.now();
  while (true) {
    let data;
    try {
      ({ data } = await mgmt.get(`/indexers/${encodeURIComponent(indexerName)}/status`));
    } catch (err) {
      logAxiosError(err, 'GET /indexers/status');
      throw err;
    }
    const st = data?.lastResult?.status;
    if (st === 'success') return data;
    if (st === 'transientFailure' || st === 'error') {
      const err = new Error(`Indexer ${indexerName} failed: ${st}`);
      err.details = data;
      throw err;
    }
    if (Date.now() - start > timeoutMs) {
      const err = new Error(`Indexer ${indexerName} timed out`);
      err.details = data;
      throw err;
    }
    await sleep(pollMs);
  }
}

// Führt reinen Vektor-Suchlauf durch (standardmäßig auf Sitzungsindex)
async function vectorSearchTopK({ sessionId, indexName, text, k = 3, select = 'document_title,content_text,source_url,text_document_id' }) {
  const { indexName: defaultIndex } = resourceNames(sessionId);
  const effectiveIndex = indexName || defaultIndex;
  const body = {
    count: true,
    top: k,
    select,
    vectorQueries: [
      { kind: 'text', fields: 'content_embedding', text, k }
    ]
  };
  let data;
  try {
    ({ data } = await queryClient.post(`/${encodeURIComponent(effectiveIndex)}/docs/search`, body));
  } catch (err) {
    logAxiosError(err, 'POST /indexes/docs/search');
    throw err;
  }
  return (data.value || []).map(v => ({
    score: v['@search.score'],
    document_title: v.document_title,
    content_text: v.content_text,
    source_url: v.source_url,
    text_document_id: v.text_document_id
  }));
}

// Entfernt Indexer, Index, Skillset, Datenquelle und Blobs für die Sitzung
async function cleanupSessionResources({ sessionId, deleteIndex = true, deleteDataSource = true, deleteBlobs = true }) {
  const { indexerName, dataSourceName, indexName, prefix, skillsetName } = resourceNames(sessionId);

  // Indexer löschen
  await mgmt.delete(`/indexers/${encodeURIComponent(indexerName)}`).catch(() => {});

  // Skillset löschen
  await mgmt.delete(`/skillsets/${encodeURIComponent(skillsetName)}`).catch(() => {});

  // Index löschen (Achtung: Gemeinsamen Index nicht immer löschen!)
  if (deleteIndex) {
    await mgmt.delete(`/indexes/${encodeURIComponent(indexName)}`).catch(() => {});
  }

  // Datenquelle löschen
  if (deleteDataSource) {
    await mgmt.delete(`/datasources/${encodeURIComponent(dataSourceName)}`).catch(() => {});
  }

  // Blobs im Sitzungsordner löschen (inkl. Directory-Marker)
  if (deleteBlobs) {
    if (!AZURE_STORAGE_CONNECTION_STRING) return;
    const bs = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
    const cont = bs.getContainerClient(BLOB_CONTAINER);
    // Alle Blobs unter dem Präfix entfernen (virtueller Ordner wird damit vollständig gelöscht)
    for await (const item of cont.listBlobsFlat({ prefix })) {
      await cont.deleteBlob(item.name).catch(() => {});
    }
    // Optionalen Directory-Marker (z.B. ein Blob mit genau dem Präfixnamen) entfernen
    try {
      const markerName = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
      const marker = cont.getBlockBlobClient(markerName);
      await marker.deleteIfExists();
    } catch {}
  }
}

// Orchestrator: Führt alle Schritte für eine Sitzung mit dynamischen Namen aus
async function prepareAndIndexSession({ sessionId, urls, container = BLOB_CONTAINER }) {
  const names = resourceNames(sessionId);
  console.debug('[ACS resourceNames]', names);

  // 1) Dateien hochladen
  await uploadSessionBlobsFromUrls({ sessionId, urls, container, prefix: names.prefix });

  // 2) Datenquelle mit Präfix (pro Sitzung)
  await ensureDataSource({ sessionId, container, prefix: names.prefix });

  // 3) Temporärer Index pro Sitzung
  await createOrUpdateTempIndex({ sessionId, indexName: names.indexName });

  // 4) Skillset (konstanter Name, Selector wird auf Sitzungsindex gesetzt)
  await ensureSkillset({ sessionId, targetIndexName: names.indexName });

  // 5) Temporärer Indexer pro Sitzung, zeigt auf Sitzungsindex
  await ensureIndexer({ sessionId, targetIndexName: names.indexName });

  // 6) Indexer ausführen und warten
  await runIndexerAndWait({ sessionId });

  return { ...names };
}

export {
  uploadSessionBlobsFromUrls,
  ensureDataSource,
  createOrUpdateTempIndex,
  ensureSkillset,
  ensureIndexer,
  runIndexerAndWait,
  vectorSearchTopK,
  cleanupSessionResources,
  prepareAndIndexSession
};