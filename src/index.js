/**
 * Semantic DOM Distiller (SDD) - Main Entry Point
 * Core engine: takes a URL and returns an optimized JSON and Markdown for Amazon Nova Act.
 */

import { DOMExtractor } from './extraction/DOMExtractor.js';
import { ImportanceScorer } from './distillation/ImportanceScorer.js';
import { ActionOrientedTransformer } from './transformation/ActionOrientedTransformer.js';

export class SemanticDOMDistiller {
  constructor(options = {}) {
    this.options = {
      threshold: options.threshold ?? 0.3,
      timeout: options.timeout ?? 30000,
      includeScore: options.includeScore ?? false,
      groupBySection: options.groupBySection ?? true,
      useOnnx: options.useOnnx ?? true,
      ...options
    };

    this.extractor = new DOMExtractor(this.options);
    this.scorer = new ImportanceScorer(this.options);
    this.transformer = new ActionOrientedTransformer(this.options);
    this._initialized = false;
  }

  /**
   * Initialize the engine (load ONNX model, etc.).
   */
  async initialize() {
    if (this._initialized) return;
    await this.scorer.initialize();
    this._initialized = true;
  }

  /**
   * Process a URL and return an Action-oriented JSON.
   * @param {string} url
   * @returns {Promise<SDDResult>}
   */
  async distill(url) {
    await this.initialize();

    const startTime = Date.now();
    console.log(`[SDD] Processing: ${url}`);

    // Step 1: Extraction
    console.log('[SDD] Step 1: Extracting DOM...');
    const extracted = await this.extractor.extract(url);
console.log(`[SDD]   -> ${extracted.stats.totalNodes} nodes extracted`);

    // Step 2: Distillation (Importance Scoring)
    console.log('[SDD] Step 2: Scoring importance...');
    const scored = await this.scorer.pruneTree(extracted.tree);
    const prunedStats = this._countNodes(scored);
console.log(`[SDD]   -> ${prunedStats} nodes after pruning (threshold: ${this.options.threshold})`);

    // Step 3: Transformation
    console.log('[SDD] Step 3: Transforming to Action-oriented JSON...');
    const spec = this.transformer.transform(scored, {
      url: extracted.url,
      title: extracted.title,
      description: extracted.description,
      lang: extracted.lang,
      capturedAt: extracted.capturedAt
    });

    const elapsed = Date.now() - startTime;
    console.log(`[SDD] Done in ${elapsed}ms`);

    return {
      spec,
      markdown: this.transformer.toMarkdown(spec),
      meta: {
        originalNodes: extracted.stats.totalNodes,
        distilledNodes: prunedStats,
        compressionRatio: Math.round((1 - prunedStats / extracted.stats.totalNodes) * 100),
        processingTimeMs: elapsed,
        threshold: this.options.threshold,
        mode: this.scorer._onnxAvailable ? 'onnx' : 'heuristic'
      }
    };
  }

  /**
   * Process HTML directly (for tests and batch processing).
   * @param {string} html
   * @param {string} [baseUrl]
   * @returns {Promise<SDDResult>}
   */
  async distillHTML(html, baseUrl = 'about:blank') {
    await this.initialize();

    const extracted = this.extractor.extractFromHTML(html, baseUrl);
    const scored = await this.scorer.pruneTree(extracted.tree);
    const spec = this.transformer.transform(scored, {
      url: extracted.url,
      title: extracted.title,
      description: extracted.description,
      lang: extracted.lang,
      capturedAt: extracted.capturedAt
    });

    return {
      spec,
      markdown: this.transformer.toMarkdown(spec),
      meta: {
        originalNodes: extracted.stats.totalNodes,
        distilledNodes: this._countNodes(scored),
        compressionRatio: 0,
        processingTimeMs: 0,
        threshold: this.options.threshold,
        mode: 'heuristic'
      }
    };
  }

  _countNodes(node) {
    if (!node) return 0;
    let count = 1;
    if (node.children) {
      node.children.forEach(c => { count += this._countNodes(c); });
    }
    return count;
  }
}

// Default exports
export { DOMExtractor } from './extraction/DOMExtractor.js';
export { ImportanceScorer } from './distillation/ImportanceScorer.js';
export { FeatureExtractor } from './distillation/FeatureExtractor.js';
export { ActionOrientedTransformer } from './transformation/ActionOrientedTransformer.js';

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node src/index.js <url>');
    process.exit(1);
  }

  const sdd = new SemanticDOMDistiller({ threshold: 0.3 });
  sdd.distill(url)
    .then(result => {
      console.log('\n=== ACTION-ORIENTED SPEC ===\n');
      console.log(result.markdown);
      console.log('\n=== META ===\n');
      console.log(JSON.stringify(result.meta, null, 2));
    })
    .catch(err => {
      console.error('[SDD] Error:', err.message);
      process.exit(1);
    });
}
