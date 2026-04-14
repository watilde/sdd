/**
 * Extraction Layer
 * Fetches the real DOM via Playwright and removes unnecessary elements.
 * - Physically removes hidden elements
 * - Removes metadata tags (script/style/svg etc.)
 * - Analyzes structure based on accessibility tree (Role/Aria)
 */

import { chromium } from 'playwright';
import { JSDOM } from 'jsdom';

// Tags to remove
const REMOVE_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'canvas',
  'iframe', 'object', 'embed', 'link', 'meta',
  'head', 'template', 'slot'
]);

// WAI-ARIA implicit role mapping (tag name -> implicit role)
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

// Interactive tags
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
   * Fetch DOM from URL and run extraction.
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

      // Load page
      await page.goto(url, {
        timeout: this.options.timeout,
        waitUntil: this.options.waitUntil
      });

      // Wait for dynamic content
      await page.waitForTimeout(500);

      // Collect page meta information
      const meta = await this._collectPageMeta(page);

      // Collect element coordinates and style data in browser context
      const rawDOM = await page.content();
      const elementMap = await this._collectElementData(page);

      // Parse and clean DOM
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
   * Extract directly from an HTML string (for tests and batch processing).
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
   * Collect page-level metadata.
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
   * Collect visibility, style, and event data for each element via Playwright.
   */
  async _collectElementData(page) {
    const data = await page.evaluate(() => {
      const result = [];
      const allElements = document.querySelectorAll('*');

      allElements.forEach((el, index) => {
        try {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();

          // Assign a unique ID
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
          // Some elements may not be accessible
        }
      });

      return result;
    });

    // Convert to Map<sddId, elementData>
    const map = new Map();
    data.forEach(d => map.set(d.sddId, d));
    return map;
  }

  /**
   * Parse HTML string and return a cleaned node tree.
   */
  _parseAndClean(html, elementMap) {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const body = doc.body || doc.documentElement;

    return this._processNode(body, elementMap, 0);
  }

  /**
   * Recursively process nodes to build the SDD node tree.
   */
  _processNode(element, elementMap, depth) {
    if (!element || depth > this.options.maxDepth) return null;
    if (element.nodeType !== 1) return null; // Element nodes only

    const tagName = element.tagName.toLowerCase();

    // Skip tags that should be removed
    if (REMOVE_TAGS.has(tagName)) return null;

    // Retrieve Playwright-collected data via data-sdd-id
    const sddId = parseInt(element.getAttribute('data-sdd-id'));
    const elData = elementMap.get(sddId);

    // Skip hidden elements (when Playwright data is available)
    if (!this.options.includeHidden && elData?.isHidden) return null;

    // Extract text content (direct child text nodes only)
    const directText = this._extractDirectText(element);

    // Recursively process children
    const children = [];
    for (const child of element.children) {
      const childNode = this._processNode(child, elementMap, depth + 1);
      if (childNode) children.push(childNode);
    }

    // Determine role (explicit aria-role takes priority over implicit role)
    const role = element.getAttribute('role') ||
      elData?.role ||
      IMPLICIT_ROLES[tagName] ||
      null;

    // Determine interactivity
    const isInteractive = this._isInteractive(element, elData, tagName, role);

    // Optimize empty containers (div/span with no children)
    // but keep them if they are interactive
    if (!isInteractive && children.length === 0 && !directText) {
      return null;
    }

    // Build SDD node
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

    // Remove null fields to reduce payload
    return this._compact(node);
  }

  /**
   * Get direct child text nodes only.
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
   * Determine whether a node is interactive.
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
   * Extract only semantic attributes (remove noise such as class names and style).
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
   * Remove obfuscated classes (e.g. Tailwind utilities) and keep only semantic class names.
   */
  _normalizeClassName(className) {
    if (!className) return null;
    // Keep only BEM-style or meaningfully-named classes
    const classes = className.split(/\s+/).filter(c => {
      // Tailwind class characteristics: short, contains special chars or numbers
      if (c.length < 3) return false;
      if (/^[a-z]+-\d+$/.test(c)) return false; // mt-4, px-2 etc
      if (/^(flex|grid|block|inline|hidden|absolute|relative|fixed|sticky)$/.test(c)) return false;
      if (/^(text|bg|border|p|m|w|h|min|max)-./.test(c)) return false;
      return true;
    });
    return classes.length > 0 ? classes.join(' ') : null;
  }

  /**
   * Remove null/undefined fields to reduce object size.
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
   * Compute statistics for the node tree.
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
