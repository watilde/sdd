/**
 * Extraction Layer
 * Playwright を使って実際のDOMを取得し、不要要素を除去する
 * - 非表示要素の物理的削除
 * - script/style/svg等のメタデータ除去
 * - アクセシビリティツリー(Role/Aria)ベースの構造解析
 */

import { chromium } from 'playwright';
import { JSDOM } from 'jsdom';

// 除去対象タグ
const REMOVE_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'canvas',
  'iframe', 'object', 'embed', 'link', 'meta',
  'head', 'template', 'slot'
]);

// WAI-ARIA のロールマッピング（タグ名→暗黙的ロール）
const IMPLICIT_ROLES = {
  a: 'link',
  article: 'article',
  aside: 'complementary',
  button: 'button',
  details: 'group',
  dialog: 'dialog',
  figure: 'figure',
  footer: 'contentinfo',
  form: 'form',
  h1: 'heading', h2: 'heading', h3: 'heading',
  h4: 'heading', h5: 'heading', h6: 'heading',
  header: 'banner',
  img: 'img',
  input: 'textbox',
  li: 'listitem',
  main: 'main',
  nav: 'navigation',
  ol: 'list',
  option: 'option',
  p: 'paragraph',
  section: 'region',
  select: 'listbox',
  summary: 'button',
  table: 'table',
  tbody: 'rowgroup',
  td: 'cell',
  textarea: 'textbox',
  th: 'columnheader',
  tr: 'row',
  ul: 'list',
};

// インタラクティブタグ
const INTERACTIVE_TAGS = new Set([
  'a', 'button', 'input', 'select', 'textarea',
  'details', 'summary', 'label'
]);

export class DOMExtractor {
  constructor(options = {}) {
    this.options = {
      timeout: options.timeout || 30000,
      viewport: options.viewport || { width: 1280, height: 800 },
      waitUntil: options.waitUntil || 'networkidle',
      includeHidden: options.includeHidden || false,
      maxDepth: options.maxDepth || 50,
      ...options
    };
  }

  /**
   * URLからDOMを取得して抽出処理を実行
   * @param {string} url
   * @returns {Promise<ExtractedDOM>}
   */
  async extract(url) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: this.options.viewport,
      userAgent: 'Mozilla/5.0 (compatible; SDD/1.0; +https://github.com/watilde/sdd)'
    });

    try {
      const page = await context.newPage();

      // ページ読み込み
      await page.goto(url, {
        timeout: this.options.timeout,
        waitUntil: this.options.waitUntil
      });

      // 動的コンテンツ待機
      await page.waitForTimeout(500);

      // ページメタ情報収集
      const meta = await this._collectPageMeta(page);

      // 可視要素の座標・スタイル情報をブラウザ側で収集
      const rawDOM = await page.content();
      const elementMap = await this._collectElementData(page);

      // DOM解析・クリーニング
      const cleanedTree = this._parseAndClean(rawDOM, elementMap);

      return {
        url,
        title: meta.title,
        description: meta.description,
        lang: meta.lang,
        viewport: this.options.viewport,
        capturedAt: new Date().toISOString(),
        tree: cleanedTree,
        stats: this._computeStats(cleanedTree)
      };

    } finally {
      await browser.close();
    }
  }

  /**
   * HTMLの文字列から直接抽出（テスト・ユニット用）
   * @param {string} html
   * @param {string} [baseUrl]
   * @returns {ExtractedDOM}
   */
  extractFromHTML(html, baseUrl = 'about:blank') {
    const dom = new JSDOM(html, { url: baseUrl });
    const rawDOM = dom.serialize();
    const cleanedTree = this._parseAndClean(rawDOM, new Map());
    return {
      url: baseUrl,
      title: dom.window.document.title || '',
      description: '',
      lang: dom.window.document.documentElement.lang || 'en',
      viewport: this.options.viewport,
      capturedAt: new Date().toISOString(),
      tree: cleanedTree,
      stats: this._computeStats(cleanedTree)
    };
  }

  /**
   * ページ全体のメタ情報を収集
   */
  async _collectPageMeta(page) {
    return await page.evaluate(() => {
      const desc = document.querySelector('meta[name="description"]');
      return {
        title: document.title,
        description: desc ? desc.content : '',
        lang: document.documentElement.lang || 'en'
      };
    });
  }

  /**
   * Playwright経由で各要素の可視性・スタイル・イベント情報を収集
   */
  async _collectElementData(page) {
    const data = await page.evaluate(() => {
      const result = [];
      const allElements = document.querySelectorAll('*');

      allElements.forEach((el, index) => {
        try {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();

          // ユニークIDを付与
          el.setAttribute('data-sdd-id', String(index));

          const isHidden =
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0' ||
            el.hasAttribute('hidden') ||
            el.getAttribute('aria-hidden') === 'true';

          const isOffScreen =
            rect.width === 0 || rect.height === 0 ||
            rect.right < 0 || rect.bottom < 0;

          result.push({
            sddId: index,
            tagName: el.tagName.toLowerCase(),
            isHidden: isHidden || isOffScreen,
            fontSize: parseFloat(style.fontSize) || 14,
            fontWeight: parseInt(style.fontWeight) || 400,
            color: style.color,
            backgroundColor: style.backgroundColor,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            },
            zIndex: parseInt(style.zIndex) || 0,
            hasEventListeners: typeof el.onclick === 'function' ||
              typeof el.onchange === 'function' ||
              el.hasAttribute('onclick') ||
              el.hasAttribute('onchange'),
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            ariaLabelledBy: el.getAttribute('aria-labelledby'),
            ariaDescribedBy: el.getAttribute('aria-describedby'),
            ariaRequired: el.getAttribute('aria-required'),
            ariaExpanded: el.getAttribute('aria-expanded'),
            ariaHidden: el.getAttribute('aria-hidden'),
            tabIndex: el.tabIndex,
            type: el.getAttribute('type'),
            href: el.getAttribute('href'),
            placeholder: el.getAttribute('placeholder'),
            value: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
              ? el.value : null,
            textContent: el.childNodes.length > 0 &&
              Array.from(el.childNodes).some(n => n.nodeType === 3)
              ? el.childNodes[0].textContent.trim().slice(0, 200)
              : null
          });
        } catch (e) {
          // 一部の要素は取得できない場合がある
        }
      });

      return result;
    });

    // Map<sddId, elementData> に変換
    const map = new Map();
    data.forEach(d => map.set(d.sddId, d));
    return map;
  }

  /**
   * HTML文字列をパースしてクリーニング済みのノードツリーを返す
   */
  _parseAndClean(html, elementMap) {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const body = doc.body || doc.documentElement;

    return this._processNode(body, elementMap, 0);
  }

  /**
   * ノードを再帰的に処理してSDDノードツリーを構築
   */
  _processNode(element, elementMap, depth) {
    if (!element || depth > this.options.maxDepth) return null;
    if (element.nodeType !== 1) return null; // Element nodeのみ

    const tagName = element.tagName.toLowerCase();

    // 除去対象タグをスキップ
    if (REMOVE_TAGS.has(tagName)) return null;

    // data-sdd-id から Playwright収集データを取得
    const sddId = parseInt(element.getAttribute('data-sdd-id'));
    const elData = elementMap.get(sddId);

    // 非表示要素のスキップ（Playwright収集データがある場合）
    if (!this.options.includeHidden && elData?.isHidden) return null;

    // テキストコンテンツを抽出（直接の子テキストノードのみ）
    const directText = this._extractDirectText(element);

    // 子ノードを再帰処理
    const children = [];
    for (const child of element.children) {
      const childNode = this._processNode(child, elementMap, depth + 1);
      if (childNode) children.push(childNode);
    }

    // ロールを決定（明示的aria-role > 暗黙的ロール）
    const role = element.getAttribute('role') ||
      elData?.role ||
      IMPLICIT_ROLES[tagName] ||
      null;

    // インタラクション可能性を判定
    const isInteractive = this._isInteractive(element, elData, tagName, role);

    // 空コンテナは最適化（子が1つで自身がdiv/spanの場合）
    // ただしインタラクティブな場合は保持
    if (!isInteractive && children.length === 0 && !directText) {
      return null;
    }

    // SDDノードを構築
    const node = {
      tag: tagName,
      role,
      id: element.getAttribute('id') || null,
      className: this._normalizeClassName(element.getAttribute('class')),
      text: directText,
      attrs: this._extractSemanticAttrs(element, tagName),
      isInteractive,
      isClickable: isInteractive || (elData?.hasEventListeners ?? false),
      visual: elData ? {
        fontSize: elData.fontSize,
        fontWeight: elData.fontWeight,
        rect: elData.rect
      } : null,
      depth,
      children: children.length > 0 ? children : undefined
    };

    // 不要なnullフィールドを削除
    return this._compact(node);
  }

  /**
   * 直接の子テキストノードのみ取得
   */
  _extractDirectText(element) {
    let text = '';
    for (const node of element.childNodes) {
      if (node.nodeType === 3) { // Text node
        text += node.textContent;
      }
    }
    const trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed || null;
  }

  /**
   * インタラクション可能性の判定
   */
  _isInteractive(element, elData, tagName, role) {
    if (INTERACTIVE_TAGS.has(tagName)) return true;
    if (elData?.hasEventListeners) return true;
    if (elData?.tabIndex >= 0) return true;
    if (role && ['button', 'link', 'menuitem', 'tab', 'option',
      'checkbox', 'radio', 'switch', 'combobox'].includes(role)) return true;
    if (element.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  /**
   * セマンティックな属性のみを抽出（クラス名・style等のノイズを除去）
   */
  _extractSemanticAttrs(element, tagName) {
    const attrs = {};
    const semanticAttrs = [
      'href', 'src', 'alt', 'title', 'placeholder',
      'type', 'name', 'value', 'for', 'action', 'method',
      'aria-label', 'aria-labelledby', 'aria-describedby',
      'aria-required', 'aria-expanded', 'aria-selected',
      'aria-checked', 'aria-controls', 'aria-live',
      'aria-invalid', 'aria-multiline', 'aria-haspopup',
      'disabled', 'required', 'readonly', 'checked',
      'selected', 'multiple', 'autocomplete',
      'data-testid', 'data-cy', 'data-test'
    ];

    for (const attr of semanticAttrs) {
      const val = element.getAttribute(attr);
      if (val !== null && val !== '') attrs[attr] = val;
    }

    // heading level
    if (['h1','h2','h3','h4','h5','h6'].includes(tagName)) {
      attrs.level = parseInt(tagName[1]);
    }

    return Object.keys(attrs).length > 0 ? attrs : undefined;
  }

  /**
   * Tailwind等の難読化クラスを除去し、セマンティッククラスのみ保持
   */
  _normalizeClassName(className) {
    if (!className) return null;
    // BEM記法・意味のある長さのクラスのみ残す
    const classes = className.split(/\s+/).filter(c => {
      // Tailwindクラスの特徴：短い、特殊文字含む、数値含む
      if (c.length < 3) return false;
      if (/^[a-z]+-\d+$/.test(c)) return false; // mt-4, px-2 etc
      if (/^(flex|grid|block|inline|hidden|absolute|relative|fixed|sticky)$/.test(c)) return false;
      if (/^(text|bg|border|p|m|w|h|min|max)-./.test(c)) return false;
      return true;
    });
    return classes.length > 0 ? classes.join(' ') : null;
  }

  /**
   * null/undefinedフィールドを削除してオブジェクトを軽量化
   */
  _compact(obj) {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && v !== undefined) {
        result[k] = v;
      }
    }
    return result;
  }

  /**
   * ツリーの統計情報を計算
   */
  _computeStats(tree) {
    let totalNodes = 0;
    let interactiveNodes = 0;
    let maxDepth = 0;

    const traverse = (node, depth = 0) => {
      if (!node) return;
      totalNodes++;
      if (node.isInteractive) interactiveNodes++;
      maxDepth = Math.max(maxDepth, depth);
      if (node.children) {
        node.children.forEach(c => traverse(c, depth + 1));
      }
    };

    traverse(tree);
    return { totalNodes, interactiveNodes, maxDepth };
  }
}
