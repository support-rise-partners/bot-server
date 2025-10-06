#!/usr/bin/env node
/*
  exporter.mjs (ESM)
  Ежемесячная/еженедельная выгрузка контента SharePoint Online в Azure Blob:
  - Документы (docx/xlsx/pptx/pdf) — только новые/изменённые
  - Страницы .aspx => HTML (через headless браузер) — только новые/изменённые
  - Пути SharePoint сайтов берутся из Azure Table Storage 'ExternalSitesUrl' с PartitionKey = 'sharepoint' (поле: path / sitePath / url / href)
  - Внешние публичные ссылки (из Azure Table Storage 'ExternalSitesUrl') — сохраняем как HTML с детекцией изменений
  ⤷ Ручной вход выполняется через `node services/.../sitesExport.js --login` (без noVNC маршрутов)
*/

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import axios from 'axios';
import cron from 'node-cron';
import puppeteer from 'puppeteer';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { BlobServiceClient } from '@azure/storage-blob';
import { TableClient } from '@azure/data-tables';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
// (no unused imports)


/* =========================
   ENV / Конфигурация
   ========================= */
const {
  TENANT_ID,
  CLIENT_ID,
  CLIENT_SECRET,
  SITE_HOST,            // contoso.sharepoint.com
  AZURE_STORAGE_CONNECTION_STRING,
  CONTAINER_NAME        // например: sharepoint-archive
} = process.env;


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Profile directory lives next to this file
const PROFILE_DIR = path.join(__dirname, 'puppeteer-profile');

if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET || !SITE_HOST ||
    !AZURE_STORAGE_CONNECTION_STRING || !CONTAINER_NAME) {
  console.error('❌ Проверьте .env — отсутствуют обязательные переменные.');
  process.exit(1);
}

const TMP_DIR = path.join(process.cwd(), '.tmp'); // локальный кэш
const ALLOWED_DOC_EXT = new Set(['.docx', '.xlsx', '.pptx', '.pdf']);
process.env.TZ = 'Europe/Berlin';

// Универсальный sleep для совместимости со старыми версиями Puppeteer
const sleep = (ms) => new Promise(res => setTimeout(res, ms));


/* =========================
   MSAL (Graph access token)
   ========================= */
const cca = new ConfidentialClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    clientSecret: CLIENT_SECRET,
  }
});
async function getGraphToken() {
  const res = await cca.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default']
  });
  return res.accessToken;
}

/* =========================
   Blob клиент
   ========================= */
const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);

async function ensureContainer() {
  await containerClient.createIfNotExists();
}
function getBlobClient(blobName) {
  return containerClient.getBlockBlobClient(blobName);
}

/* =========================
   Утилиты сравнения изменений
   ========================= */
function normalizeETag(etag = '') {
  return String(etag).replace(/^"+|"+$/g, '');
}
function isChanged(spItem, blobProps) {
  // spItem: { id, eTag, lastModifiedDateTime }
  const spETag = normalizeETag(spItem.eTag || '');
  const spLast = (spItem.lastModifiedDateTime || '').toString();
  const meta = blobProps?.metadata || {};
  const sameETag = meta.spetag && normalizeETag(meta.spetag) === spETag;
  const sameLast = meta.splastmod && meta.splastmod === spLast;
  // «не изменилось», если совпал eTag ИЛИ дата
  return !(sameETag || sameLast);
}
function buildBlobMetadata(spItem) {
  return {
    spid: spItem.id || '',
    spetag: normalizeETag(spItem.eTag || ''),
    splastmod: (spItem.lastModifiedDateTime || '').toString()
  };
}

// ======= Чтение списка внешних ссылок из Azure Table Storage =======
async function fetchExternalUrlsFromTable() {
  const tableName = 'ExternalSitesUrl';
  try {
    const tableClient = TableClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING, tableName);
    // Попробуем создать таблицу (если уже существует — SDK бросит, игнорируем)
    try { await tableClient.createTable(); } catch {}
    const urls = [];
    for await (const entity of tableClient.listEntities()) {
      const u = (entity.url || entity.Url || entity.URL || entity.link || entity.Link || entity.href || entity.Href);
      if (typeof u === 'string' && u.trim()) urls.push(u.trim());
    }
    return urls;
  } catch (e) {
    console.error('Failed to read ExternalSitesUrl table:', e?.message || e);
    return [];
  }
}

// ======= Чтение путей SharePoint сайтов из Azure Table Storage (PartitionKey='sharepoint') =======
async function fetchSharePointPathsFromTable() {
  const tableName = 'ExternalSitesUrl';
  try {
    const tableClient = TableClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING, tableName);
    try { await tableClient.createTable(); } catch {}
    const paths = new Set();
    for await (const entity of tableClient.listEntities({ queryOptions: { filter: `PartitionKey eq 'sharepoint'` } })) {
      // поддерживаем разные варианты имени поля
      const raw =
        entity.path ?? entity.Path ?? entity.sitePath ?? entity.SitePath ??
        entity.url ?? entity.Url ?? entity.URL ?? entity.href ?? entity.Href ?? '';
      if (typeof raw === 'string' && raw.trim()) {
        let p = raw.trim();
        // если указали абсолютный URL, вытащим только path
        try {
          if (p.startsWith('http://') || p.startsWith('https://')) {
            const u = new URL(p);
            if (u.hostname.toLowerCase() !== SITE_HOST.toLowerCase()) {
              // пропускаем чужие хосты
              continue;
            }
            p = u.pathname || '/';
          }
        } catch {}
        if (!p.startsWith('/')) p = '/' + p;
        // нормализуем двойные слэши
        p = p.replace(/\/{2,}/g, '/');
        paths.add(p);
      }
    }
    return Array.from(paths);
  } catch (e) {
    console.error('Не удалось прочитать пути SharePoint из таблицы ExternalSitesUrl:', e?.message || e);
    return [];
  }
}


// ======= Вспомогательные функции для внешних ссылок =======
async function computeFileHash(filePath) {
  const buf = await fs.readFile(filePath);
  const hash = createHash('sha256').update(buf).digest('hex');
  return hash;
}

function safeNameFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    let name = (u.hostname + u.pathname).replace(/\\/g, '/');
    // Replace invalid blob characters
    name = name
      .replace(/^[/.]+/, '')            // leading slashes/dots
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 180);                    // keep it reasonable
    if (!name.endsWith('.html')) name += '.html';
    return name;
  } catch {
    const fallback = rawUrl.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 180) + '.html';
    return fallback;
  }
}
// ======= Загрузка внешних публичных HTML-страниц =======
async function processExternalUrl(rawUrl) {
  if (!rawUrl) return;
  const url = rawUrl.trim();
  if (!url) return;

  // Build blob name and client
  const fileName = safeNameFromUrl(url);
  const blobName = `external_html/${fileName}`;
  const blobClient = getBlobClient(blobName);

  // Temp HTML path
  const htmlPath = path.join(TMP_DIR, 'external_html', fileName);

  // Render page to HTML (external: no profile, no SP waits)
  await renderPageToHtml(url, htmlPath, { useProfile: false, isExternal: true });

  // Compute content hash for change detection
  const contentHash = await computeFileHash(htmlPath);

  // If exists and hash matches -> skip
  const exists = await blobClient.exists();
  if (exists) {
    const props = await blobClient.getProperties();
    const meta = props?.metadata || {};
    if (meta.contenthash === contentHash) {
      await safeUnlink(htmlPath);
      console.log('SKIP (external html unchanged):', blobName);
      return;
    }
  }

  // Upload with metadata (original URL + hash)
  await blobClient.uploadFile(htmlPath, {
    metadata: { sourceurl: url, contenthash: contentHash },
    blobHTTPHeaders: { blobContentType: 'text/html; charset=utf-8' }
  });

  await safeUnlink(htmlPath);
  console.log('UPLOADED (external html):', blobName);
}


/* =========================
   Получение siteId, страниц, файлов
   ========================= */



// Получение siteId по явному пути из SITE_PATHS
async function getSiteIdByPath(sitePath) {
  const token = await getGraphToken();
  const normalized = sitePath && sitePath !== '/' ? sitePath : '/';
  const url = `https://graph.microsoft.com/v1.0/sites/${SITE_HOST}:${normalized}`;
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
  return { id: res.data.id, webUrl: res.data.webUrl || `https://${SITE_HOST}${normalized}` };
}

async function listAllSitePages(siteId) {
  const token = await getGraphToken();
  const pages = [];
  let url = `https://graph.microsoft.com/v1.0/sites/${siteId}/pages?$top=999`;
  while (url) {
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }});
    pages.push(...(res.data.value || []));
    url = res.data['@odata.nextLink'] || null;
  }
  return pages;
}

async function getDriveByName(siteId, libraryDisplayName) {
  const token = await getGraphToken();
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drives`;
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }});
  const drives = res.data.value || [];
  // точное имя → без регистра → fallbacks (EN/DE)
  let drive = drives.find(d => d.name === libraryDisplayName)
        || drives.find(d => (d.name || '').toLowerCase() === (libraryDisplayName || '').toLowerCase());
  if (!drive) {
    const fallbacks = ['Shared Documents', 'Documents', 'Dokumente', 'Freigegebene Dokumente'];
    drive = drives.find(d => fallbacks.includes(d.name))
          || drives.find(d => fallbacks.map(n => n.toLowerCase()).includes((d.name || '').toLowerCase()));
  }
  if (!drive) {
    console.warn('Available libraries (drives):', drives.map(d => d.name).join(', ') || '(none)');
    return null;
  }
  return drive;
}

async function listAllFilesRecursive(driveId) {
  const token = await getGraphToken();
  async function listChildren(itemId) {
    const items = [];
    let url = !itemId
      ? `https://graph.microsoft.com/v1.0/drives/${driveId}/root/children?$top=200`
      : `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/children?$top=200`;
    while (url) {
      const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }});
      items.push(...(res.data.value || []));
      url = res.data['@odata.nextLink'] || null;
    }
    return items;
  }
  const result = [];
  async function walkFolder(item) {
    if (item.folder) {
      const children = await listChildren(item.id);
      for (const ch of children) await walkFolder(ch);
    } else {
      result.push(item);
    }
  }
  const rootChildren = await listChildren(null);
  for (const it of rootChildren) await walkFolder(it);
  return result;
}

/* =========================
   Документы: скачивание → загрузка если изменилось
   ========================= */

// Безопасное удаление файла и директории если она пуста
async function safeUnlink(filePath) {
  try { await fs.unlink(filePath); } catch {}
  try {
    const dir = path.dirname(filePath);
    const entries = await fs.readdir(dir);
    if (!entries.length) {
      await fs.rmdir(dir);
    }
  } catch {}
}

async function downloadFileToTemp(driveId, itemId, name) {
  const token = await getGraphToken();
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`;
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${token}` }
  });
  const filePath = path.join(TMP_DIR, 'docs', name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, res.data);
  return filePath;
}

async function processDocumentItem(driveItem) {
  const ext = path.extname(driveItem.name || '').toLowerCase();
  if (!ALLOWED_DOC_EXT.has(ext)) return;

  const blobName = `docs/${driveItem.name}`;
  const blobClient = getBlobClient(blobName);
  const exists = await blobClient.exists();
  if (exists) {
    const props = await blobClient.getProperties();
    if (!isChanged(driveItem, props)) {
      console.log('SKIP (doc unchanged):', blobName);
      return;
    }
  }
  const filePath = await downloadFileToTemp(driveItem.parentReference.driveId, driveItem.id, driveItem.name);
  const metadata = buildBlobMetadata(driveItem);
  await blobClient.uploadFile(filePath, { metadata });
  // Remove local temp file after successful upload
  await safeUnlink(filePath);
  console.log('UPLOADED (doc changed):', blobName);
}

/* =========================
   Страницы: вспомогательные для рендера
   ========================= */
async function preventNavigation(page) {
  // Блокируем переходы по ссылкам, чтобы при кликах не было навигации
  await page.evaluate(() => {
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      const isHash = href.startsWith('#');
      if (!isHash) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  });
}

async function forceExpandWithCSS(page) {
  // Снимаем clamp/truncate и скрываем верхние панели в печати
  await page.addStyleTag({
    content: `
      * { -webkit-line-clamp: unset !important; line-clamp: unset !important; }
      [style*="-webkit-line-clamp"], [style*="line-clamp"] {
        -webkit-line-clamp: unset !important; line-clamp: unset !important;
      }
      [style*="max-height"] { max-height: none !important; overflow: visible !important; }
      .is-collapsed, .collapsed, .ms-hidden, .is-hidden, .sp-hide, .hidden {
        display: block !important; visibility: visible !important; opacity: 1 !important;
      }
      .ms-Accordion-panel, .Accordion__panel, .accordion-panel {
        display: block !important; height: auto !important; max-height: none !important; overflow: visible !important;
      }
      details, details[open] > * { display: block !important; }
      .ms-Expander, .ms-Expander-content, .CanvasZone, .ControlZone, .ClientSideWebPart {
        height: auto !important; max-height: none !important; overflow: visible !important;
      }
      .read-more, .truncate, .clamped, .text-overflow {
        overflow: visible !important; white-space: normal !important; text-overflow: clip !important;
      }
      /* Спрятать глобальную навигацию в PDF */
      #SuiteNavWrapper, .sp-appBar, header[role="banner"], nav[role="navigation"], .od-SuiteNav {
        display: none !important;
      }
    `
  });
}

async function autoScroll(page) {
  // Доскроллить чтобы догрузить lazy-контент
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 800;
      const timer = setInterval(() => {
        const el = document.scrollingElement || document.documentElement;
        window.scrollBy(0, step);
        total += step;
        if (total >= el.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
}

async function expandAllCollapsibles(page) {
  // Несколько проходов ТОЛЬКО по контентной зоне
  for (let pass = 0; pass < 6; pass++) {
    const changed = await page.evaluate(() => {
      const root = document.querySelector('#spPageCanvasContent')
             || document.querySelector('.CanvasZone')
             || document.querySelector('.SPPageChrome-app')
             || document.body;
      if (!root) return false;
      let didChange = false;

      // 1) <details>
      root.querySelectorAll('details').forEach(d => { if (!d.open) { d.open = true; didChange = true; } });

      // 2) [aria-expanded="false"]
      root.querySelectorAll('[aria-expanded="false"]').forEach(el => {
        if (el.closest('#SuiteNavWrapper, .sp-appBar, nav, header')) return;
        const btn = (el.matches('button, [role="button"]') ? el : el.closest('button,[role="button"]'));
        if (btn) { btn.click(); didChange = true; }
        else { el.setAttribute('aria-expanded', 'true'); didChange = true; }
      });

      // 3) Заголовки аккордеонов/кнопки
      const sel = [
        '.ms-Accordion-header',
        '.ms-AccordionHeader-button',
        '.Accordion__header',
        '.accordion-header',
        'button',
        '[role="button"]'
      ].join(',');
      const keys = ['expand','show more','mehr','anzeigen','aufklappen','weitere','more','open','see more','collapse','weiter'];
      root.querySelectorAll(sel).forEach(el => {
        if (el.closest('#SuiteNavWrapper, .sp-appBar, nav, header')) return;
        const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase().trim();
        if (keys.some(k => txt.includes(k))) { el.click(); didChange = true; }
      });

      // 4) Принудительно раскрыть по классам
      const forceOpen = (node) => {
        if (node && node.style) {
          node.style.display = 'block';
          node.style.maxHeight = 'none';
          node.style.height = 'auto';
          node.style.overflow = 'visible';
        }
        node.classList?.remove('is-collapsed','collapsed','is-hidden','hidden');
        node.classList?.add('is-expanded','expanded');
      };
      root.querySelectorAll('.is-collapsed, .collapsed, .ms-Accordion-panel, .Accordion__panel, .accordion-panel')
        .forEach(p => { forceOpen(p); didChange = true; });

      // 5) read-more
      root.querySelectorAll('[data-automation-id="readMoreButton"], [data-automation-id="expandButton"], [data-automation-id="seeMore"]')
        .forEach(b => { if (!b.closest('#SuiteNavWrapper, .sp-appBar, nav, header')) { b.click(); didChange = true; } });

      // 6) снять inline-клампы
      root.querySelectorAll('[style*="max-height"], [style*="line-clamp"], [style*="-webkit-line-clamp"]').forEach(el => {
        el.style?.removeProperty('max-height');
        el.style?.removeProperty('line-clamp');
        el.style?.removeProperty('-webkit-line-clamp');
        didChange = true;
      });

      return didChange;
    });
    if (!changed) break;
    await sleep(400);
  }
}

async function aggressiveExpand(page) {
  // Проход по контентной зоне + shadow DOM
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const root = document.querySelector('#spPageCanvasContent')
             || document.querySelector('.CanvasZone')
             || document.querySelector('.SPPageChrome-app')
             || document.body;
    if (!root) return;

    function forceOpenNode(node) {
      try {
        node.style && (node.style.display = 'block');
        if (node.style) {
          node.style.maxHeight = 'none';
          node.style.height = 'auto';
          node.style.overflow = 'visible';
          node.style.opacity = '1';
          node.style.visibility = 'visible';
        }
        node.classList?.remove('is-collapsed','collapsed','is-hidden','hidden');
        node.classList?.add('is-expanded','expanded');
        if (node.tagName === 'DETAILS' && !node.open) node.open = true;
        if (node.getAttribute && node.getAttribute('aria-expanded') === 'false') node.setAttribute('aria-expanded','true');
      } catch {}
    }

    function clickIfLooksLikeExpander(el) {
      if (el.closest && el.closest('#SuiteNavWrapper, .sp-appBar, nav, header')) return false; // не трогаем навигацию
      if (el.closest && el.closest('a[href]')) return false; // не кликаем ссылки
      const label = (el.innerText || el.getAttribute?.('aria-label') || '').toLowerCase();
      const keys = ['expand','show more','mehr','anzeigen','aufklappen','more','open','see more','collapse','weiter'];
      if (keys.some(k => label.includes(k))) { el.click(); return true; }
      const aria = (el.getAttribute && (el.getAttribute('aria-expanded') || el.getAttribute('aria-pressed')));
      if (aria === 'false') { el.click(); return true; }
      return false;
    }

    function visit(rootEl) {
      rootEl.querySelectorAll('*').forEach(node => {
        forceOpenNode(node);
        if (node.matches && node.matches('button,[role="button"],.ms-Button,.ms-Accordion-header,.ms-AccordionHeader-button,.accordion-header,.Accordion__header,[data-automation-id="readMoreButton"],[data-automation-id="expandButton"],[data-automation-id="seeMore"]')) {
          clickIfLooksLikeExpander(node);
        }
      });
      rootEl.querySelectorAll('details, [aria-expanded="false"], .ms-Expander-header, .ms-Accordion-header, .Accordion__header')
        .forEach(el => { if (!el.closest('#SuiteNavWrapper, .sp-appBar, nav, header')) el.click(); });
    }

    visit(root);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const shadowHosts = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node && node.shadowRoot) shadowHosts.push(node);
    }
    for (const host of shadowHosts) {
      try { visit(host.shadowRoot); } catch {}
    }

    await sleep(400);
  });
}

/* =========================
   Страницы: рендер в PDF → загрузка если изменилось
   ========================= */
async function renderPageToPdf(pageUrl, outputPath) {
  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };
  launchOpts.userDataDir = PROFILE_DIR; // сохраняем профайл рядом со скриптом

  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
  await page.emulateMediaType('screen');

  await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 120000 });

  // Ждём область контента и блокируем навигацию
  await page.waitForSelector('#spPageCanvasContent, .CanvasZone, .SPPageChrome-app', { timeout: 60000 });
  await preventNavigation(page);
  await sleep(800); // даём время web-parts

  // Раскрыть всё + lazy-load
  await expandAllCollapsibles(page);
  await forceExpandWithCSS(page);
  await autoScroll(page);
  await aggressiveExpand(page);
  await expandAllCollapsibles(page);

  // Дождаться тишины сети после раскрытия (кросс-версийно)
  if (typeof page.waitForNetworkIdle === 'function') {
    try { await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }); } catch {}
  } else {
    await sleep(800);
  }

  // Soften sticky/fixed headers inside content to reduce overlap during screenshots
  await page.addStyleTag({
    content: `
      #spPageCanvasContent * { 
        /* demote sticky/fixed so they scroll with content */
        position: static !important;
      }
    `
  });

  // === Full-length export: try tall single-page; if too tall, stitch screenshots into multi-page PDF ===
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // Measure full content size
  const { scrollWidth, scrollHeight } = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement || document.body;
    return { scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight };
  });

  const pxToIn = (px) => px / 96; // Chrome ~96 dpi
  const widthIn = pxToIn(Math.max(800, Math.min(scrollWidth || 1440, 1920)));
  const heightIn = pxToIn(scrollHeight || 0);

  // 1) Try a single very tall page (no cropping) if within Chrome's hard limit (~200in)
  let generated = false;
  if (heightIn > 0 && heightIn <= 200) {
    try {
      await page.pdf({
        path: outputPath,
        printBackground: true,
        preferCSSPageSize: false,
        margin: { top: '0in', right: '0in', bottom: '0in', left: '0in' },
        width: `${widthIn}in`,
        height: `${heightIn}in`
      });
      generated = true;
    } catch (e) {
      console.warn('Tall single-page PDF failed, will stitch screenshots:', e?.message || e);
    }
  }

  // 2) Fallback: capture by scrolling viewport slices (avoid sticky headers) and stitch into PDF
  if (!generated) {
    // Detect sticky/fixed header height to exclude from screenshots
    const metrics = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement || document.body;
      const total = el ? el.scrollHeight : window.innerHeight;
      // find most prominent fixed/sticky top header
      let headerH = 0;
      try {
        const nodes = Array.from(document.querySelectorAll('*'));
        for (const n of nodes) {
          const cs = getComputedStyle(n);
          if (cs.position === 'fixed' || cs.position === 'sticky') {
            const r = n.getBoundingClientRect();
            if (r.top <= 0 && r.bottom > 0 && r.height < 220 && r.width > 300) {
              headerH = Math.max(headerH, Math.round(r.height));
            }
          }
        }
      } catch {}
      return { totalHeight: total, headerHeight: headerH };
    });

    const vp = await page.viewport();
    const headerH = Math.min(metrics.headerHeight || 0, Math.floor((vp.height || 1200) * 0.4));
    const usableHeight = Math.max(200, (vp.height || 1200) - headerH); // area we capture each time

    const total = metrics.totalHeight || (vp.height || 1200);
    const buffers = [];

    for (let y = 0; y < total; y += usableHeight) {
      // Scroll page so that the next slice is visible in viewport
      await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
      await sleep(160); // let layout settle

      const remaining = Math.max(0, total - y);
      const h = Math.min(usableHeight, remaining);

      const buf = await page.screenshot({
        clip: { x: 0, y: headerH, width: vp.width || 1440, height: h },
        type: 'png'
      });
      buffers.push(buf);
    }

    // Stitch slices: each slice becomes its own PDF page (no cropping, no overlap)
    const pdfDoc = await PDFDocument.create();
    for (const buf of buffers) {
      let img;
      try { img = await pdfDoc.embedPng(buf); } catch { img = await pdfDoc.embedJpg(buf); }
      const w = img.width;
      const h = img.height;
      const p = pdfDoc.addPage([w, h]);
      p.drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    const pdfBytes = await pdfDoc.save();
    await fs.writeFile(outputPath, pdfBytes);
  }

  await browser.close();
}

// Сохранение страницы как ЧИСТЫЙ HTML (внешние ресурсы остаются ссылками)
async function renderPageToHtml(pageUrl, outputPath, opts = {}) {
  const useProfile = opts.useProfile !== false; // по умолчанию – с профилем (для SP), для внешних – без
  const baseOpts = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] };
  let browser;
  try {
    const launchOpts = useProfile ? { ...baseOpts, userDataDir: PROFILE_DIR } : baseOpts;
    browser = await puppeteer.launch(launchOpts);
  } catch (e) {
    const msg = e?.message || '';
    if (useProfile && msg.includes('The browser is already running')) {
      console.warn('Puppeteer profile is locked — retrying without userDataDir');
      browser = await puppeteer.launch(baseOpts);
    } else {
      throw e;
    }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
  await page.emulateMediaType('screen');

  await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 120000 });

  const isExternal = opts.isExternal === true || (new URL(pageUrl).hostname !== SITE_HOST);
  if (!isExternal) {
    // SharePoint page – применяем расширенный пайплайн
    try { await page.waitForSelector('#spPageCanvasContent, .CanvasZone, .SPPageChrome-app', { timeout: 60000 }); } catch {}
    await preventNavigation(page);
    await sleep(800);
    await expandAllCollapsibles(page);
    await forceExpandWithCSS(page);
    await autoScroll(page);
    await aggressiveExpand(page);
    await expandAllCollapsibles(page);
    if (typeof page.waitForNetworkIdle === 'function') {
      try { await page.waitForNetworkIdle({ idleTime: 600, timeout: 20000 }); } catch {}
    } else {
      await sleep(600);
    }
  } else {
    // Внешняя страница – не ждём SP-селекторы, делаем мягкую подготовку
    try { await page.waitForSelector('body', { timeout: 30000 }); } catch {}
    await sleep(400);
    await forceExpandWithCSS(page); // снять клампы/ограничения высоты
    await autoScroll(page);         // догрузить lazy-контент
    await sleep(700);
    if (typeof page.waitForNetworkIdle === 'function') {
      try { await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }); } catch {}
    } else {
      await sleep(500);
    }
  }

  // === Optional: flatten Shadow DOM (for SPA sites like DATEV) ===
  if (opts.flattenShadow) {
    try {
      await page.evaluate(() => {
        function flatten(node) {
          if (!node || !node.querySelectorAll) return;
          // Collect hosts with shadowRoot
          const hosts = Array.from(node.querySelectorAll('*')).filter(n => n.shadowRoot);
          for (const host of hosts) {
            try {
              const wrapper = document.createElement('div');
              // keep some trace of the original host
              const tag = (host.tagName || 'unknown').toLowerCase();
              wrapper.setAttribute('data-shadow-from', tag);
              // copy id/class for styling continuity
              if (host.id) wrapper.id = host.id;
              if (host.className) wrapper.className = host.className;
              // inline the shadow DOM HTML
              wrapper.innerHTML = host.shadowRoot.innerHTML;
              // Replace host with wrapper containing flattened content
              host.replaceWith(wrapper);
            } catch {}
          }
        }
        // Repeat a few times in case of nested shadow DOMs
        for (let i = 0; i < 3; i++) {
          flatten(document);
        }
      });
    } catch (e) {
      console.warn('Flatten shadow DOM failed:', e?.message || e);
    }
  }

  try {
    const html = await page.content();
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, html, 'utf8');
  } finally {
    try { await browser?.close(); } catch {}
  }
}

async function processSitePage(sitePage) {
  // Сохраняем как HTML вместо PDF
  const htmlName = sitePage.name.replace(/\.aspx$/i, '.html');
  const blobName = `pages_html/${htmlName}`;
  const blobClient = getBlobClient(blobName);

  const exists = await blobClient.exists();
  if (exists) {
    const props = await blobClient.getProperties();
    if (!isChanged(sitePage, props)) {
      console.log('SKIP (page html unchanged):', blobName);
      return;
    }
  }

  const htmlPath = path.join(TMP_DIR, 'pages_html', htmlName);
  await renderPageToHtml(sitePage.webUrl, htmlPath);

  const metadata = buildBlobMetadata(sitePage);
  await blobClient.uploadFile(htmlPath, {
    metadata,
    blobHTTPHeaders: { blobContentType: 'text/html; charset=utf-8' }
  });
  // Remove local temp file after successful upload
  await safeUnlink(htmlPath);
  console.log('UPLOADED (page html changed):', blobName);
}

/* =========================
   Один прогон экспорта
   ========================= */
// =========================
// Split runners for SharePoint and External
// =========================
async function runSharePointOnly() {
  // Читаем пути сайтов из Azure Table Storage (PartitionKey = 'sharepoint')
  const sitePaths = await fetchSharePointPathsFromTable();

  if (!sitePaths.length) {
    console.error('В таблице ExternalSitesUrl нет путей SharePoint (PartitionKey = "sharepoint"). Добавьте записи с полем path/sitePath/url/href.');
    return;
  }

  // Проходим по каждому указанному пути
  for (const sitePath of sitePaths) {
    let siteMeta;
    try { siteMeta = await getSiteIdByPath(sitePath); }
    catch (e) { console.error('Resolve site failed:', sitePath, e?.message || e); continue; }

    const siteId = siteMeta.id;
    const siteUrl = siteMeta.webUrl || `https://${SITE_HOST}${sitePath}`;
    console.log('\n-- Processing site --');
    console.log('WebUrl:', siteUrl);
    console.log('Site ID:', siteId);

    // 1) Страницы (SitePages) -> HTML если изменилось
    try {
      const pages = await listAllSitePages(siteId);
      for (const p of pages) {
        p.eTag = p.eTag || p.ETag || p['@microsoft.graph.eTag'] || '';
        p.lastModifiedDateTime = p.lastModifiedDateTime || p.lastModified || p.modified || '';
        await processSitePage(p);
      }
    } catch (e) {
      console.error('Pages export error:', siteUrl, e?.message || e);
    }

    // 2) Документы (Shared Documents)
    try {
      const drive = await getDriveByName(siteId, 'Shared Documents');
      if (drive) {
        const allFiles = await listAllFilesRecursive(drive.id);
        for (const it of allFiles) {
          it.eTag = it.eTag || it.ETag || it['@microsoft.graph.eTag'] || '';
          it.lastModifiedDateTime = it.lastModifiedDateTime || it.fileSystemInfo?.lastModifiedDateTime || '';
          await processDocumentItem(it);
        }
      } else {
        console.warn('Drive "Shared Documents" not found — пропускаю документы.', siteUrl);
      }
    } catch (e) {
      console.error('Docs export error:', siteUrl, e?.message || e);
    }
  }
}

async function runExternalOnly() {
  const externalList = await fetchExternalUrlsFromTable();
  if (externalList.length) {
    console.log('\n-- Processing external URLs (from Table Storage) --');
    for (const url of externalList) {
      try { await processExternalUrl(url); }
      catch (e) { console.error('External URL failed:', url, e?.message || e); }
    }
  } else {
    console.log('\n-- No external URLs found in Table Storage (ExternalSitesUrl) --');
  }
}

// Orchestrator for full export
async function runFullExport() {
  console.log('=== SharePoint Export started ===');
  await ensureContainer();
  await fs.mkdir(TMP_DIR, { recursive: true });

  await runSharePointOnly();
  await runExternalOnly();

  console.log('\n=== SharePoint Export finished ===');
}

/* =========================
   Режим первичного логина в O365 (для cookie профиля)
   ========================= */
async function loginOnceAndSaveCookies() {
  fssync.mkdirSync(PROFILE_DIR, { recursive: true });
  console.log('Откроется браузер. Войдите в O365 (SharePoint). Профиль будет сохранён рядом со скриптом:', PROFILE_DIR);
  const browser = await puppeteer.launch({
    headless: false, // чтобы вы могли ввести логин/пароль/2FA
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  const homeUrl = `https://${SITE_HOST}`;
  await page.goto(homeUrl, { waitUntil: 'networkidle2' });
  console.log('Ожидаю входа... После успешного входа просто закройте окно браузера.');

  // Дождаться закрытия окна браузера пользователем — затем вернуть управление
  await new Promise((resolve) => {
    const done = () => resolve();
    browser.once('disconnected', done);
  });
}

/* =========================
   Планировщик (еженедельно: только внешние ссылки)
   ========================= */
function scheduleWeeklyExternal() {
  // еженедельно по понедельникам в 04:00 (Europe/Berlin)
  cron.schedule('0 0 4 * * 1', async () => {
    try {
      console.log('\n[CRON] Weekly external sync start');
      await ensureContainer();
      await fs.mkdir(TMP_DIR, { recursive: true });
      await runExternalOnly();
      console.log('[CRON] Weekly external sync finished\n');
    } catch (e) {
      console.error('Weekly external export failed:', e);
    }
  });
  console.log('⏰ Еженедельная синхронизация внешних ссылок запланирована: ПН 04:00 (Europe/Berlin).');
}


// =========================
// Entry point (CLI-only modes). When imported, nothing auto-starts.
// =========================
(async () => {
  if (process.argv.includes('--login')) {
    // 1) Открываем браузер для интерактивного входа и ждём закрытия окна
    await loginOnceAndSaveCookies();

    // 2) После закрытия — сразу запускаем выгрузку SharePoint
    console.log('\n[LOGIN] Сессия сохранена. Запускаю выгрузку SharePoint...');
    await ensureContainer();
    await fs.mkdir(TMP_DIR, { recursive: true });
    await runSharePointOnly();
    return;
  }

  if (process.argv.includes('--sharepoint-only')) {
    await ensureContainer();
    await fs.mkdir(TMP_DIR, { recursive: true });
    await runSharePointOnly();
    return;
  }

  if (process.argv.includes('--external-only')) {
    await ensureContainer();
    await fs.mkdir(TMP_DIR, { recursive: true });
    await runExternalOnly();
    return;
  }

  if (process.argv.includes('--standalone')) {
    await runFullExport();
    scheduleWeeklyExternal();
  }
})();

export { scheduleWeeklyExternal as startExternalWeeklyScheduler, runSharePointOnly, runExternalOnly, runFullExport, loginOnceAndSaveCookies };