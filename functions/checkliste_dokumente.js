import { SearchIndexClient, SearchIndexerClient, AzureKeyCredential } from '@azure/search-documents';
import { DefaultAzureCredential } from '@azure/identity';

// Werte aus .env (exakt wie in deiner Umgebung benannt)
const AZURE_SEARCH_ENDPOINT = (process.env.AZURE_SEARCH_ENDPOINT || '').trim();
const AZURE_SEARCH_API_KEY = (process.env.AZURE_SEARCH_API_KEY || '').trim();
const AZURE_OPENAI_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || '').trim();
const AZURE_OPENAI_EMBED_DEPLOYMENT = (process.env.AZURE_OPENAI_EMBED_DEPLOYMENT || '').trim();
const AZURE_STORAGE_CONNECTION_STRING = (process.env.AZURE_STORAGE_CONNECTION_STRING || '').trim();

function ensureHttpsEndpoint(url, varName) {
  if (!url) throw new Error(`Env-Variable ${varName} ist nicht gesetzt`);
  if (!/^https?:\/\//i.test(url)) throw new Error(`Env-Variable ${varName} muss mit https:// beginnen`);
  return url.replace(/\/$/, '');
}

const SEARCH_ENDPOINT = ensureHttpsEndpoint(AZURE_SEARCH_ENDPOINT, 'AZURE_SEARCH_ENDPOINT');

const API_MGMT  = '2025-08-01-preview';

const embeddingDimensions = 1536;

function buildAcsName(prefix, sessionId) {
  // Replace non-alphanumeric characters with dashes and lowercase
  const safeSessionId = sessionId.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return `${prefix}${safeSessionId}`;
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
    container: { name: 'chat-temp-docs', query: prefix },
    dataDeletionDetectionPolicy: { '@odata.type': '#Microsoft.Azure.Search.NativeBlobSoftDeleteDeletionDetectionPolicy' }
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

export {
  createOrUpdateTempIndex,
  ensureSkillset,
  ensureDataSource,
  ensureIndexer,
  resourceNames
};