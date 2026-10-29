import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const OCR_ENDPOINT = process.env.UNLIMITED_OCR_ENDPOINT || '';
const OCR_MODEL = process.env.UNLIMITED_OCR_MODEL || 'Unlimited-OCR-2';
const OCR_API_KEY = process.env.UNLIMITED_OCR_API_KEY || '';
const BAIDU_API_KEY = process.env.BAIDU_API_KEY || '';
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY || '';
const BAIDU_BASE_URL = process.env.BAIDU_BASE_URL || 'https://aip.baidubce.com';
const BAIDU_POLL_MS = Math.max(5000, Number(process.env.BAIDU_POLL_MS || 5000));
const BAIDU_TIMEOUT_MS = Math.max(60000, Number(process.env.BAIDU_TIMEOUT_MS || 900000));
let baiduToken = {value:'', expiresAt:0};
const feedbackDir = path.join(ROOT, 'feedback');
const publicDir = path.join(ROOT, 'public');

const readBody = req => new Promise((resolve, reject) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { body += chunk; if (body.length > 80_000_000) reject(new Error('Request too large')); });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

function json(res, status, value) {
  const data = JSON.stringify(value, null, 2);
  res.writeHead(status, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'});
  res.end(data);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {windowsHide:true}); let stderr = '';
    child.stderr.on('data', x => stderr += x); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `${command} failed (${code})`)));
  });
}

async function pdfPages(pdfPath, dir) {
  const prefix = path.join(dir, 'page');
  await run(process.env.PDFTOPPM || 'pdftoppm', ['-png', '-r', '160', pdfPath, prefix]);
  return (await fs.readdir(dir)).filter(x => /^page-\d+\.png$/i.test(x)).sort().map(x => path.join(dir, x));
}

function dataImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${Buffer.from(require('node:fs').readFileSync(filePath)).toString('base64')}`;
}

function demoPage(page, filename) {
  return { page_number: page, layers: [
    { layer: 0, type: 'page', text: `Demo result for ${filename} · page ${page}` },
    { layer: 1, type: 'layout', text: 'Connect UNLIMITED_OCR_ENDPOINT to replace this demo.' },
    { layer: 2, type: 'text', text: 'Human review is enabled. Edit this field and save feedback.' }
  ], raw_text: 'Demo mode: no OCR endpoint configured.', fields: [] };
}

async function formPost(url, values, timeoutMs=120000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams(values);
    const response = await fetch(url, {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body, signal:controller.signal});
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { throw new Error(`Baidu returned non-JSON (${response.status}): ${text.slice(0,500)}`); }
    if (!response.ok) throw new Error(`Baidu HTTP ${response.status}: ${data.error_msg || text}`);
    if (data.error_code && Number(data.error_code) !== 0) throw new Error(`Baidu ${data.error_code}: ${data.error_msg || 'request failed'}`);
    return data;
  } finally { clearTimeout(timer); }
}

async function getBaiduToken() {
  if (!BAIDU_API_KEY || !BAIDU_SECRET_KEY) throw new Error('BAIDU_API_KEY and BAIDU_SECRET_KEY are required for Baidu Cloud mode');
  if (baiduToken.value && Date.now() < baiduToken.expiresAt) return baiduToken.value;
  const url = `${BAIDU_BASE_URL}/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(BAIDU_API_KEY)}&client_secret=${encodeURIComponent(BAIDU_SECRET_KEY)}`;
  const response = await fetch(url, {method:'GET'}); const data = await response.json();
  if (!response.ok || data.error) throw new Error(`Baidu token error: ${data.error_description || data.error || response.status}`);
  baiduToken = {value:data.access_token, expiresAt:Date.now() + Math.max(60000, (Number(data.expires_in || 2592000)-300)*1000)};
  return baiduToken.value;
}

function normalizeBaiduResult(result, filename) {
  const pages = Array.isArray(result.pages) ? result.pages.map((page, index) => {
    const layers = (page.layouts || []).map((layout, i) => ({layer:i, type:layout.type || 'text', subtype:layout.sub_type || '', text:layout.text || layout.merge_text || '', bbox:layout.position || undefined, polygon:layout.polygon || undefined}));
    (page.tables || []).forEach(table => layers.push({layer:layers.length, type:'table', text:table.markdown || table.table_html || '', bbox:table.position || undefined, table}));
    return {page_number:Number(page.page_num ?? index), page_angle:page.page_angle || 0, layers, raw_text:page.text || page.markdown || '', markdown:page.markdown || '', fields:[], meta:page.meta || {}};
  }) : [];
  return {document:{filename:result.file_name || filename, pages}, baidu_result:result};
}

async function callBaiduCloud(filePath, filename, options={}) {
  const token = await getBaiduToken();
  const fileData = (await fs.readFile(filePath)).toString('base64');
  const taskUrl = `${BAIDU_BASE_URL}/rest/2.0/brain/online/v2/unlimited-ocr-parser/task?access_token=${encodeURIComponent(token)}`;
  const submitted = await formPost(taskUrl, {file_data:fileData, file_name:filename, angle_adjust:String(options.angle_adjust ?? true), angle_mode:options.angle_mode || 'direction'});
  const taskId = submitted.result?.task_id;
  if (!taskId) throw new Error('Baidu did not return task_id');
  const queryUrl = `${BAIDU_BASE_URL}/rest/2.0/brain/online/v2/unlimited-ocr-parser/task/query?access_token=${encodeURIComponent(token)}`;
  const started = Date.now(); let status;
  while (Date.now() - started < BAIDU_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, BAIDU_POLL_MS));
    const queried = await formPost(queryUrl, {task_id:taskId}, 120000); status = queried.result || {};
    if (status.status === 'failed') throw new Error(`Baidu task failed: ${status.task_error || 'unknown error'} (task ${taskId})`);
    if (status.status === 'success') {
      if (!status.parse_result_url) throw new Error(`Baidu task succeeded without parse_result_url (task ${taskId})`);
      const resultResponse = await fetch(status.parse_result_url); if (!resultResponse.ok) throw new Error(`Baidu result download failed: ${resultResponse.status}`);
      const result = await resultResponse.json(); return {...normalizeBaiduResult(result, filename), mode:'baidu-cloud-unlimited-ocr-2', baidu_task:{task_id:taskId, status:status.status, cost_page_num:status.cost_page_num, markdown_url:status.markdown_url}};
    }
  }
  throw new Error(`Baidu task timed out after ${Math.round(BAIDU_TIMEOUT_MS/1000)} seconds; task_id=${taskId}`);
}

function parseModelText(text, pageCount, filename) {
  const cleaned = String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return { document: { filename, pages: parsed }, raw_model_output: text };
    if (parsed.pages) return { document: parsed, raw_model_output: text };
    return { document: { filename, pages: [{ page_number: 1, layers: [{layer:0,type:'json', data:parsed}], raw_text: '' }] }, raw_model_output: text };
  } catch {}
  const chunks = String(text || '').split(/<PAGE>/i).filter(Boolean);
  const pages = Array.from({length: pageCount}, (_, i) => ({page_number:i+1, layers:[{layer:0,type:'text',text:chunks[i] || text}], raw_text:chunks[i] || text, fields:[]}));
  return { document: { filename, pages }, raw_model_output: text, parse_warning: 'Model output was not JSON; preserved as per-page text layers.' };
}

async function callOCR(imagePaths, filename, template, options) {
  if (!OCR_ENDPOINT) return { document:{filename, pages:imagePaths.map((_,i)=>demoPage(i+1, filename))}, mode:'demo', raw_model_output:'' };
  const images = await Promise.all(imagePaths.map(async p => ({type:'image_url', image_url:{url:`data:image/png;base64,${(await fs.readFile(p)).toString('base64')}`}})));
  const instruction = `Parse this document page by page and layer by layer. Return JSON only with {"filename":string,"pages":[{"page_number":number,"layers":[{"layer":number,"type":string,"text":string,"bbox":[number,number,number,number]?}],"raw_text":string,"fields":object[]}]}. Preserve reading order, headings, paragraphs, tables, form labels, handwritten text, checkbox state and coordinates when visible. Use the supplied template as semantic guidance but do not invent values. Template:\n${JSON.stringify(template || {}, null, 2)}`;
  const payload = {model:OCR_MODEL, messages:[{role:'user',content:[...images,{type:'text',text:instruction}]}], temperature:0, max_tokens: Math.max(8000, imagePaths.length*8000), stream:false, skip_special_tokens:false};
  const response = await fetch(OCR_ENDPOINT, {method:'POST', headers:{'content-type':'application/json', ...(OCR_API_KEY ? {authorization:`Bearer ${OCR_API_KEY}`} : {})}, body:JSON.stringify(payload)});
  if (!response.ok) throw new Error(`OCR endpoint ${response.status}: ${await response.text()}`);
  const result = await response.json();
  const text = result.choices?.[0]?.message?.content || result.output_text || result.text || JSON.stringify(result);
  return {...parseModelText(text, imagePaths.length, filename), mode:'unlimited-ocr-2'};
}

async function parseDocument(input) {
  const id = crypto.randomUUID(); const dir = await fs.mkdtemp(path.join(os.tmpdir(), `uocr-${id}-`));
  try {
    const ext = path.extname(input.filename || '').toLowerCase() || '.bin'; const source = path.join(dir, `source${ext}`);
    await fs.writeFile(source, Buffer.from(input.data_base64, 'base64'));
    const cloudMode = Boolean(BAIDU_API_KEY && BAIDU_SECRET_KEY);
    const images = cloudMode ? [source] : (ext === '.pdf' ? await pdfPages(source, dir) : [source]);
    const out = cloudMode ? await callBaiduCloud(source, input.filename || 'upload', input.options || {}) : await callOCR(images, input.filename || 'upload', input.template, input.options || {});
    out.meta = {request_id:id, filename:input.filename, page_count:out.document?.pages?.length || images.length, provider:cloudMode ? 'baidu-cloud' : (OCR_ENDPOINT ? 'openai-compatible' : 'demo'), endpoint_configured:Boolean(OCR_ENDPOINT || cloudMode), generated_at:new Date().toISOString()};
    return out;
  } finally { await fs.rm(dir, {recursive:true, force:true}); }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, {ok:true, provider:BAIDU_API_KEY && BAIDU_SECRET_KEY ? 'baidu-cloud' : OCR_ENDPOINT ? 'openai-compatible' : 'demo', endpoint_configured:Boolean(OCR_ENDPOINT || (BAIDU_API_KEY && BAIDU_SECRET_KEY)), model:OCR_MODEL});
    if (req.method === 'POST' && req.url === '/api/parse') return json(res, 200, await parseDocument(JSON.parse(await readBody(req))));
    if (req.method === 'POST' && req.url === '/api/feedback') { const body = JSON.parse(await readBody(req)); await fs.mkdir(feedbackDir,{recursive:true}); await fs.appendFile(path.join(feedbackDir,'dataset.jsonl'), JSON.stringify({...body, saved_at:new Date().toISOString()})+'\n'); return json(res,200,{ok:true, path:'feedback/dataset.jsonl'}); }
    if (req.method === 'GET') { const rel = req.url === '/' ? '/index.html' : req.url; const file = path.resolve(publicDir, '.' + rel); if (!file.startsWith(path.resolve(publicDir))) return json(res,403,{error:'forbidden'}); const data = await fs.readFile(file); const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'}; res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream'}); return res.end(data); }
    return json(res,404,{error:'not found'});
  } catch (e) { return json(res, 400, {error:e.message}); }
});
server.listen(PORT, () => console.log(`Unlimited OCR 2 workbench: http://localhost:${PORT}`));
