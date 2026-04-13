/**
 * SDD Demo Server
 * 任意のURLを仕様書（Markdown）に変換するWebインターフェース
 */

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SemanticDOMDistiller } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// SDD インスタンス（サーバー起動時に初期化）
const sdd = new SemanticDOMDistiller({
  threshold: 0.3,
  timeout: 30000,
  useOnnx: true
});

let initialized = false;
(async () => {
  await sdd.initialize();
  initialized = true;
  console.log('[SDD Demo] Engine initialized');
})();

// ---- API Routes ----

/**
 * POST /api/distill
 * Body: { url: string, options?: { threshold?: number } }
 * Response: { spec, markdown, meta }
 */
app.post('/api/distill', async (req, res) => {
  if (!initialized) {
    return res.status(503).json({ error: 'Engine is initializing, please retry' });
  }

  const { url, options = {} } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  // URLバリデーション
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs are supported' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  // スロットリング（Demo用：1リクエスト/5秒）
  const threshold = Math.max(0.1, Math.min(0.9,
    parseFloat(options.threshold) || 0.3
  ));

  try {
    const localSdd = new SemanticDOMDistiller({
      threshold,
      timeout: 25000,
      useOnnx: true
    });
    await localSdd.initialize();

    const result = await localSdd.distill(url);
    res.json({
      success: true,
      url,
      spec: result.spec,
      markdown: result.markdown,
      meta: result.meta
    });
  } catch (err) {
    console.error('[SDD Demo] Error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message || 'Distillation failed'
    });
  }
});

/**
 * POST /api/distill/html
 * Body: { html: string, baseUrl?: string }
 * HTML文字列を直接処理
 */
app.post('/api/distill/html', async (req, res) => {
  if (!initialized) {
    return res.status(503).json({ error: 'Engine is initializing' });
  }

  const { html, baseUrl } = req.body;
  if (!html) return res.status(400).json({ error: 'html is required' });

  try {
    const result = await sdd.distillHTML(html, baseUrl);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    initialized,
    version: '0.1.0',
    mode: sdd.scorer?._onnxAvailable ? 'onnx' : 'heuristic'
  });
});

// Static files (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[SDD Demo] Server running at http://localhost:${PORT}`);
});
