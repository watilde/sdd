/**
 * Importance Scorer
 * 各DOMノードに 0.0〜1.0 の重要度スコアを付与する
 *
 * モード:
 * 1. ONNXモード: distiller-v1.onnx を使った推論 (本番)
 * 2. ヒューリスティックモード: ルールベースの推論 (フォールバック / 開発時)
 *
 * ヒューリスティックモデルは学習データなしで動作し、
 * 十分な精度を持つ実用的なフォールバックとして機能する
 */

import { FeatureExtractor } from './FeatureExtractor.js';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODEL_PATH = join(__dirname, '../../models/distiller-v1.onnx');

export class ImportanceScorer {
  constructor(options = {}) {
    this.threshold = options.threshold ?? 0.3;
    this.featureExtractor = new FeatureExtractor(options);
    this.session = null; // ONNXセッション (遅延初期化)
    this.useOnnx = options.useOnnx ?? true;
    this._onnxAvailable = false;
  }

  /**
   * ONNXセッションを初期化（モデルが存在する場合のみ）
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
   * ノードツリー全体にスコアを付与してフィルタリング
   * @param {object} tree - 抽出済みSDDノードツリー
   * @returns {ScoredTree} スコア付きツリー
   */
  async scoreTree(tree) {
    const scoredTree = await this._scoreNode(tree, {});
    return scoredTree;
  }

  /**
   * スコアが閾値以下のノードを枝刈りした「機能的DOMツリー」を返す
   * @param {object} tree
   * @returns {object} 枝刈り済みツリー
   */
  async pruneTree(tree) {
    const scored = await this.scoreTree(tree);
    return this._prune(scored);
  }

  // ---- Private ----

  async _scoreNode(node, parentContext) {
    if (!node) return null;

    // 特徴量を抽出
    const features = this.featureExtractor.extractFeatures(node, parentContext);

    // スコア計算
    let score;
    if (this._onnxAvailable && this.session) {
      score = await this._onnxInfer(features);
    } else {
      score = this._heuristicScore(features, node);
    }

    // 子ノードのコンテキストを構築
    const childContext = {
      isForm: node.tag === 'form' || parentContext.isForm,
      isNav: node.tag === 'nav' || node.role === 'navigation' || parentContext.isNav,
      isTable: node.tag === 'table' || parentContext.isTable,
      isInteractive: node.isInteractive || parentContext.isInteractive,
      ancestorScore: Math.max(score, parentContext.ancestorScore || 0) * 0.7
    };

    // 子ノードを再帰処理
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
      features: undefined, // ストレージ最適化：特徴量は返さない
      children: children?.length > 0 ? children : undefined
    };
  }

  /**
   * ONNXモデルによる推論
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
   * ヒューリスティックスコアリング（ルールベース）
   * 特徴量の加重平均 + ボーナス/ペナルティ
   */
  _heuristicScore(features, node) {
    let score = 0.0;

    // === 基底スコア ===
    // ロール由来の基底スコア（最重要）
    score += features.roleBaseScore * 0.30;

    // タグカテゴリ
    score += features.isHighValueTag * 0.20;
    score += features.isMediumValueTag * 0.08;

    // === インタラクション ===
    score += features.isInteractive * 0.18;
    score += features.isClickable * 0.05;

    // === アクセシビリティ ===
    score += features.hasAriaLabel * 0.06;
    score += features.hasAriaRequired * 0.04;
    score += features.hasTestId * 0.03;
    score += features.hasAriaLive * 0.05;

    // === テキスト ===
    score += features.isActionText * 0.12;
    score += features.isLabelText * 0.04;
    score += features.hasText * 0.03;

    // === 視覚的重み ===
    score += features.fontSizeNorm * 0.06;
    score += features.isBold * 0.03;
    score += features.isAboveFold * 0.04;
    score += features.isLargeElement * 0.02;

    // === 属性ボーナス ===
    score += features.hasHref * 0.05;
    score += features.hasPlaceholder * 0.04;
    score += features.isRequired * 0.05;
    score += features.headingLevel * 0.06;
    score += features.inputType * 0.04;

    // === 親コンテキスト ===
    score += features.parentIsForm * 0.08;
    score += features.parentIsNav * 0.05;
    score += features.ancestorScore * 0.03;

    // === 深さペナルティ ===
    score *= features.depthPenalty;

    // === 特殊ルール（絶対値） ===
    // disabled要素は重要度を大幅に下げる
    if (features.isDisabled) score *= 0.3;

    // コンテナで子もなくテキストもない場合
    if (features.isContainerTag && !features.hasChildren && !features.hasText) {
      score *= 0.1;
    }

    // フォーム内の要素は重要度を上げる
    if (features.parentIsForm && features.isInteractive) {
      score = Math.max(score, 0.7);
    }

    // ナビゲーション内のリンクは重要
    if (features.parentIsNav && features.hasHref) {
      score = Math.max(score, 0.65);
    }

    return Math.max(0.0, Math.min(1.0, score));
  }

  /**
   * 閾値以下のノードを枝刈り（ただし重要な子を持つノードは保持）
   */
  _prune(node) {
    if (!node) return null;

    // 子を先に枝刈り
    let prunedChildren;
    if (node.children && node.children.length > 0) {
      prunedChildren = node.children
        .map(c => this._prune(c))
        .filter(Boolean);
    }

    // スコアが閾値未満でも、重要な子を持つ場合は保持
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
