/**
 * Importance Scorer
 * Assigns an importance score between 0.0 and 1.0 to each DOM node.
 *
 * Modes:
 * 1. ONNX mode: inference using sdd-distiller-v1.onnx (production)
 * 2. Heuristic mode: rule-based scoring (fallback / development)
 *
 * The heuristic model operates without training data and serves as
 * a practical fallback with sufficient accuracy.
 */

import { FeatureExtractor } from './FeatureExtractor.js';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODEL_PATH = join(__dirname, '../../models/sdd-distiller-v1.onnx');

export class ImportanceScorer {
  constructor(options = {}) {
    this.threshold = options.threshold ?? 0.3;
    this.featureExtractor = new FeatureExtractor(options);
    this.session = null; // ONNX session (lazy initialization)
    this.useOnnx = options.useOnnx ?? true;
    this._onnxAvailable = false;
  }

  /**
   * Initialize the ONNX session (only if the model file exists).
   */
  async initialize() {
    if (!this.useOnnx) return;
    if (!existsSync(MODEL_PATH)) {
      console.warn('[SDD] ONNX model not found, using heuristic mode');
      return;
    }
    try {
      const { InferenceSession } = await import('onnxruntime-node');
      this.session = await InferenceSession.create(MODEL_PATH);
      this._onnxAvailable = true;
      console.log('[SDD] ONNX model loaded:', MODEL_PATH);
    } catch (e) {
      console.warn('[SDD] Failed to load ONNX model:', e.message);
    }
  }

  /**
   * Score every node in the tree.
   * @param {object} tree - Extracted SDD node tree
   * @returns {ScoredTree} Scored tree
   */
  async scoreTree(tree) {
    const scoredTree = await this._scoreNode(tree, {});
    return scoredTree;
  }

  /**
   * Return a pruned "functional DOM tree" with nodes below the threshold removed.
   * @param {object} tree
   * @returns {object} Pruned tree
   */
  async pruneTree(tree) {
    const scored = await this.scoreTree(tree);
    return this._prune(scored);
  }

  // ---- Private ----

  async _scoreNode(node, parentContext) {
    if (!node) return null;

    // Extract features
    const features = this.featureExtractor.extractFeatures(node, parentContext);

    // Compute score
    let score;
    if (this._onnxAvailable && this.session) {
      score = await this._onnxInfer(features);
    } else {
      score = this._heuristicScore(features, node);
    }

    // Build child context
    const childContext = {
      isForm: node.tag === 'form' || parentContext.isForm,
      isNav: node.tag === 'nav' || node.role === 'navigation' || parentContext.isNav,
      isTable: node.tag === 'table' || parentContext.isTable,
      isInteractive: node.isInteractive || parentContext.isInteractive,
      ancestorScore: Math.max(score, parentContext.ancestorScore || 0) * 0.7
    };

    // Recursively score children
    let children;
    if (node.children && node.children.length > 0) {
      const scoredChildren = await Promise.all(
        node.children.map(c => this._scoreNode(c, childContext))
      );
      children = scoredChildren.filter(Boolean);
    }

    return {
      ...node,
      score: Math.round(score * 1000) / 1000,
      features: undefined, // Omit features from output to save memory
      children: children?.length > 0 ? children : undefined
    };
  }

  /**
   * Run inference using the ONNX model.
   */
  async _onnxInfer(features) {
    try {
      const { Tensor } = await import('onnxruntime-node');
      const inputArray = this.featureExtractor.toFloat32Array(features);
      const tensor = new Tensor('float32', inputArray, [1, inputArray.length]);
      const results = await this.session.run({ input: tensor });
      const output = results.output?.data || results[Object.keys(results)[0]]?.data;
      return Math.max(0, Math.min(1, output[0]));
    } catch (e) {
      console.warn('[SDD] ONNX inference failed:', e.message);
      return this._heuristicScore(features, {});
    }
  }

  /**
   * Heuristic scoring (rule-based).
   * Weighted average of features plus bonuses/penalties.
   */
  _heuristicScore(features, node) {
    let score = 0.0;

    // === Base score ===
    // Role-derived base score (highest weight)
    score += features.roleBaseScore * 0.30;

    // Tag category
    score += features.isHighValueTag * 0.20;
    score += features.isMediumValueTag * 0.08;

    // === Interaction ===
    score += features.isInteractive * 0.18;
    score += features.isClickable * 0.05;

    // === Accessibility ===
    score += features.hasAriaLabel * 0.06;
    score += features.hasAriaRequired * 0.04;
    score += features.hasTestId * 0.03;
    score += features.hasAriaLive * 0.05;

    // === Text ===
    score += features.isActionText * 0.12;
    score += features.isLabelText * 0.04;
    score += features.hasText * 0.03;

    // === Visual weight ===
    score += features.fontSizeNorm * 0.06;
    score += features.isBold * 0.03;
    score += features.isAboveFold * 0.04;
    score += features.isLargeElement * 0.02;

    // === Attribute bonuses ===
    score += features.hasHref * 0.05;
    score += features.hasPlaceholder * 0.04;
    score += features.isRequired * 0.05;
    score += features.headingLevel * 0.06;
    score += features.inputType * 0.04;

    // === Parent context ===
    score += features.parentIsForm * 0.08;
    score += features.parentIsNav * 0.05;
    score += features.ancestorScore * 0.03;

    // === Depth penalty ===
    score *= features.depthPenalty;

    // === Special rules (absolute overrides) ===
    // Significantly reduce importance of disabled elements
    if (features.isDisabled) score *= 0.3;

    // Container with no children and no text
    if (features.isContainerTag && !features.hasChildren && !features.hasText) {
      score *= 0.1;
    }

    // Boost interactive elements inside a form
    if (features.parentIsForm && features.isInteractive) {
      score = Math.max(score, 0.7);
    }

    // Links inside navigation are important
    if (features.parentIsNav && features.hasHref) {
      score = Math.max(score, 0.65);
    }

    return Math.max(0.0, Math.min(1.0, score));
  }

  /**
   * Prune nodes below the threshold (but retain nodes with important children).
   */
  _prune(node) {
    if (!node) return null;

    // Prune children first
    let prunedChildren;
    if (node.children && node.children.length > 0) {
      prunedChildren = node.children
        .map(c => this._prune(c))
        .filter(Boolean);
    }

    // Keep node if it has important children, even if its own score is below threshold
    const hasImportantChildren = prunedChildren?.some(c => c.score >= this.threshold);

    if (node.score < this.threshold && !hasImportantChildren) {
      return null;
    }

    return {
      ...node,
      children: prunedChildren?.length > 0 ? prunedChildren : undefined
    };
  }
}
