/**
 * Feature Extractor
 * Generates input feature vectors for the importance scoring model from SDD nodes.
 *
 * Feature design:
 * - Tag category (one-hot)
 * - Nesting depth (normalized)
 * - Interactivity
 * - Visual weight (font size, area)
 * - Presence of accessibility attributes
 * - Text density
 * - Child element composition
 */

// High-importance tags (hints for the model)
const HIGH_VALUE_TAGS = new Set([
  'button', 'input', 'select', 'textarea', 'a',
  'form', 'nav', 'main', 'h1', 'h2', 'h3', 'table'
]);

const MEDIUM_VALUE_TAGS = new Set([
  'h4', 'h5', 'h6', 'label', 'fieldset', 'legend',
  'article', 'section', 'header', 'footer', 'aside',
  'ul', 'ol', 'li', 'details', 'summary', 'dialog'
]);

// Base scores by ARIA role
const ROLE_BASE_SCORES = {
  button: 0.85,
  link: 0.80,
  textbox: 0.85,
  listbox: 0.80,
  combobox: 0.85,
  checkbox: 0.80,
  radio: 0.80,
  switch: 0.80,
  tab: 0.75,
  menuitem: 0.75,
  heading: 0.70,
  navigation: 0.70,
  main: 0.65,
  form: 0.70,
  table: 0.65,
  row: 0.50,
  cell: 0.45,
  columnheader: 0.60,
  list: 0.45,
  listitem: 0.40,
  img: 0.50,
  banner: 0.55,
  contentinfo: 0.45,
  complementary: 0.40,
  region: 0.40,
  article: 0.50,
  paragraph: 0.40,
  group: 0.35,
  dialog: 0.80,
};

export class FeatureExtractor {
  constructor(options = {}) {
    this.viewportArea = options.viewportArea ||
      (1280 * 800);
    this.maxFontSize = options.maxFontSize || 72;
    this.maxDepth = options.maxDepth || 20;
  }

  /**
   * Generate a feature vector from a single SDD node.
   * @param {object} node - SDD node
   * @param {object} parentContext - Parent context
   * @returns {FeatureVector}
   */
  extractFeatures(node, parentContext = {}) {
    const features = {};

    // === 1. Tag category features ===
    features.isHighValueTag = HIGH_VALUE_TAGS.has(node.tag) ? 1.0 : 0.0;
    features.isMediumValueTag = MEDIUM_VALUE_TAGS.has(node.tag) ? 1.0 : 0.0;
    features.isContainerTag = this._isContainer(node.tag) ? 1.0 : 0.0;

    // === 2. Interaction features ===
    features.isInteractive = node.isInteractive ? 1.0 : 0.0;
    features.isClickable = node.isClickable ? 1.0 : 0.0;
    features.hasTabIndex = (node.attrs?.tabIndex >= 0) ? 1.0 : 0.0;

    // === 3. Accessibility features ===
    features.hasRole = node.role ? 1.0 : 0.0;
    features.roleBaseScore = ROLE_BASE_SCORES[node.role] || 0.0;
    features.hasAriaLabel = node.attrs?.['aria-label'] ? 1.0 : 0.0;
    features.hasAriaLabelledBy = node.attrs?.['aria-labelledby'] ? 1.0 : 0.0;
    features.hasAriaDescribedBy = node.attrs?.['aria-describedby'] ? 1.0 : 0.0;
    features.hasAriaRequired = node.attrs?.['aria-required'] === 'true' ? 1.0 : 0.0;
    features.hasAriaExpanded = node.attrs?.['aria-expanded'] !== undefined ? 1.0 : 0.0;
    features.hasAriaLive = node.attrs?.['aria-live'] ? 1.0 : 0.0;
    features.hasTestId = (
      node.attrs?.['data-testid'] ||
      node.attrs?.['data-cy'] ||
      node.attrs?.['data-test']
    ) ? 1.0 : 0.0;

    // === 4. Text features ===
    const textLen = node.text ? node.text.length : 0;
    features.hasText = textLen > 0 ? 1.0 : 0.0;
    features.textLength = Math.min(textLen / 200, 1.0); // normalized
    features.isLabelText = this._isLabelLike(node.text) ? 1.0 : 0.0;
    features.isActionText = this._isActionText(node.text) ? 1.0 : 0.0;

    // === 5. Structural features ===
    const childCount = node.children?.length || 0;
    features.childCount = Math.min(childCount / 10, 1.0);
    features.hasChildren = childCount > 0 ? 1.0 : 0.0;
    features.isLeaf = childCount === 0 ? 1.0 : 0.0;
    features.depth = Math.min((node.depth || 0) / this.maxDepth, 1.0);
    features.depthPenalty = this._depthPenalty(node.depth || 0);

    // === 6. Visual features ===
    if (node.visual) {
      const { fontSize, fontWeight, rect } = node.visual;
      features.fontSizeNorm = Math.min(fontSize / this.maxFontSize, 1.0);
      features.isBold = fontWeight >= 600 ? 1.0 : 0.0;
      features.areaRatio = rect
        ? Math.min((rect.width * rect.height) / this.viewportArea, 1.0)
        : 0.0;
      features.isAboveFold = (rect && rect.y < 800) ? 1.0 : 0.0;
      features.isLargeElement = (rect && rect.width > 200 && rect.height > 30) ? 1.0 : 0.0;
    } else {
      features.fontSizeNorm = 0.5;
      features.isBold = 0.0;
      features.areaRatio = 0.0;
      features.isAboveFold = 0.5;
      features.isLargeElement = 0.0;
    }

    // === 7. Attribute features ===
    features.hasHref = node.attrs?.href ? 1.0 : 0.0;
    features.hasAlt = node.attrs?.alt ? 1.0 : 0.0;
    features.hasPlaceholder = node.attrs?.placeholder ? 1.0 : 0.0;
    features.isRequired = node.attrs?.required !== undefined ? 1.0 : 0.0;
    features.isDisabled = node.attrs?.disabled !== undefined ? 1.0 : 0.0;
    features.inputType = this._inputTypeScore(node.attrs?.type);
    features.headingLevel = node.attrs?.level
      ? (7 - node.attrs.level) / 6
      : 0.0;

    // === 8. Parent context features ===
    features.parentIsForm = parentContext.isForm ? 1.0 : 0.0;
    features.parentIsNav = parentContext.isNav ? 1.0 : 0.0;
    features.parentIsTable = parentContext.isTable ? 1.0 : 0.0;
    features.parentIsInteractive = parentContext.isInteractive ? 1.0 : 0.0;
    features.ancestorScore = Math.min(parentContext.ancestorScore || 0, 1.0);

    return features;
  }

  /**
   * Convert feature object to Float32Array for ONNX inference.
   */
  toFloat32Array(features) {
    const keys = this.getFeatureKeys();
    const arr = new Float32Array(keys.length);
    keys.forEach((k, i) => { arr[i] = features[k] ?? 0.0; });
    return arr;
  }

  /**
   * Ordered list of feature keys (order must not change).
   */
  getFeatureKeys() {
    return [
      'isHighValueTag', 'isMediumValueTag', 'isContainerTag',
      'isInteractive', 'isClickable', 'hasTabIndex',
      'hasRole', 'roleBaseScore',
      'hasAriaLabel', 'hasAriaLabelledBy', 'hasAriaDescribedBy',
      'hasAriaRequired', 'hasAriaExpanded', 'hasAriaLive', 'hasTestId',
      'hasText', 'textLength', 'isLabelText', 'isActionText',
      'childCount', 'hasChildren', 'isLeaf',
      'depth', 'depthPenalty',
      'fontSizeNorm', 'isBold', 'areaRatio', 'isAboveFold', 'isLargeElement',
      'hasHref', 'hasAlt', 'hasPlaceholder', 'isRequired', 'isDisabled',
      'inputType', 'headingLevel',
      'parentIsForm', 'parentIsNav', 'parentIsTable',
      'parentIsInteractive', 'ancestorScore'
    ];
  }

  /**
   * Number of feature dimensions.
   */
  get featureDim() {
    return this.getFeatureKeys().length;
  }

  // ---- Private helpers ----

  _isContainer(tag) {
    return ['div', 'span', 'p', 'section', 'article',
      'main', 'aside', 'header', 'footer'].includes(tag);
  }

  _depthPenalty(depth) {
    // Reduce score for deeper elements; shallower elements are more important.
    if (depth <= 3) return 1.0;
    if (depth <= 6) return 0.85;
    if (depth <= 10) return 0.65;
    if (depth <= 15) return 0.45;
    return 0.25;
  }

  _isLabelLike(text) {
    if (!text) return false;
    // Label-like text: short and single-line.
    return text.length < 50 && !text.includes('\n');
  }

  _isActionText(text) {
    if (!text) return false;
    const actionWords = [
      'submit', 'send', 'save', 'cancel', 'delete', 'edit', 'update',
      'create', 'add', 'remove', 'search', 'login', 'logout', 'register',
      'sign in', 'sign up', 'sign out', 'confirm', 'approve', 'reject',
      'download', 'upload', 'export', 'import', 'continue', 'next',
      'previous', 'back', 'close', 'open', 'toggle', 'expand', 'collapse',
      // Japanese action words
      '\u9001\u4fe1', '\u4fdd\u5b58', '\u30ad\u30e3\u30f3\u30bb\u30eb', '\u524a\u9664', '\u7de8\u96c6', '\u691c\u7d22', '\u30ed\u30b0\u30a4\u30f3',
      '\u767b\u9332', '\u78ba\u8a8d', '\u6b21\u3078', '\u623b\u308b', '\u9589\u3058\u308b', '\u958b\u304f'
    ];
    const lower = text.toLowerCase();
    return actionWords.some(w => lower.includes(w));
  }

  _inputTypeScore(type) {
    const scores = {
      submit: 1.0, button: 0.9, search: 0.85,
      email: 0.80, password: 0.80, tel: 0.75,
      text: 0.70, number: 0.70, url: 0.70,
      date: 0.70, time: 0.65, file: 0.75,
      checkbox: 0.80, radio: 0.80,
      range: 0.60, color: 0.50,
      hidden: 0.0,
    };
    return scores[type] || 0.5;
  }
}
