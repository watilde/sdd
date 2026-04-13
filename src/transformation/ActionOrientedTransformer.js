/**
 * Transformation Layer
 * スコアリング済みのSDDツリーを「Action-oriented JSON」に変換する
 *
 * 設計思想:
 * - IDやクラス名ではなくセマンティックなラベルを付与
 * - Amazon Nova Act が解釈しやすい構造
 * - 「このボタンは『保存』の役割を持つ」という自然言語的な記述
 * - アクション可能な要素を中心に構造化
 */

export class ActionOrientedTransformer {
  constructor(options = {}) {
    this.options = {
      includeScore: options.includeScore ?? false,
      language: options.language || 'auto',
      groupBySection: options.groupBySection ?? true,
      ...options
    };
  }

  /**
   * スコアリング済みツリーをAction-oriented JSONに変換
   * @param {object} scoredTree
   * @param {object} pageInfo - ページのメタ情報
   * @returns {ActionOrientedSpec}
   */
  transform(scoredTree, pageInfo = {}) {
    const elements = [];
    const sections = [];

    this._collectElements(scoredTree, elements, null);

    const spec = {
      $schema: 'https://github.com/watilde/sdd/schemas/action-spec-v1.json',
      page: {
        title: pageInfo.title || '',
        url: pageInfo.url || '',
        description: pageInfo.description || '',
        lang: pageInfo.lang || 'en',
        capturedAt: pageInfo.capturedAt || new Date().toISOString()
      },
      summary: this._generateSummary(elements, pageInfo),
      actions: this._extractActions(elements),
      forms: this._extractForms(elements),
      navigation: this._extractNavigation(elements),
      content: this._extractContent(elements),
      interactive: this._extractAllInteractive(elements)
    };

    // グルーピングが不要な場合は削除
    if (!this.options.groupBySection) {
      delete spec.forms;
      delete spec.navigation;
      delete spec.content;
    }

    return spec;
  }

  /**
   * Action-oriented JSONをMarkdown仕様書に変換
   * Amazon Nova Act / LLMに渡す形式
   * @param {ActionOrientedSpec} spec
   * @returns {string} Markdown
   */
  toMarkdown(spec) {
    const lines = [];

    lines.push(`# Page Specification: ${spec.page.title}`);
    lines.push('');
    lines.push(`**URL**: \`${spec.page.url}\``);
    if (spec.page.description) {
      lines.push(`**Description**: ${spec.page.description}`);
    }
    lines.push(`**Captured**: ${spec.page.capturedAt}`);
    lines.push('');

    // サマリー
    lines.push('## Summary');
    lines.push('');
    lines.push(spec.summary.description);
    lines.push('');
    lines.push(`- **Interactive elements**: ${spec.summary.interactiveCount}`);
    lines.push(`- **Forms**: ${spec.summary.formCount}`);
    lines.push(`- **Navigation links**: ${spec.summary.navLinkCount}`);
    lines.push(`- **Primary actions**: ${spec.summary.primaryActionCount}`);
    lines.push('');

    // アクション一覧
    if (spec.actions && spec.actions.length > 0) {
      lines.push('## Available Actions');
      lines.push('');
      spec.actions.forEach((action, i) => {
        lines.push(`### ${i + 1}. ${action.label}`);
        lines.push(`- **Type**: ${action.type}`);
        lines.push(`- **Selector**: \`${action.selector}\``);
        if (action.description) lines.push(`- **Description**: ${action.description}`);
        if (action.context) lines.push(`- **Context**: ${action.context}`);
        if (action.params) {
          lines.push('- **Parameters**:');
          action.params.forEach(p => {
            lines.push(`  - \`${p.name}\` (${p.type}${p.required ? ', required' : ''}): ${p.description}`);
          });
        }
        lines.push('');
      });
    }

    // フォーム一覧
    if (spec.forms && spec.forms.length > 0) {
      lines.push('## Forms');
      lines.push('');
      spec.forms.forEach((form, i) => {
        lines.push(`### Form ${i + 1}: ${form.label}`);
        if (form.action) lines.push(`- **Action**: ${form.action}`);
        if (form.method) lines.push(`- **Method**: ${form.method.toUpperCase()}`);
        lines.push('- **Fields**:');
        form.fields.forEach(f => {
          const req = f.required ? ' *(required)*' : '';
          lines.push(`  - \`${f.name || f.label}\` [${f.type}]${req}: ${f.label}`);
          if (f.placeholder) lines.push(`    - Placeholder: "${f.placeholder}"`);
        });
        lines.push('');
      });
    }

    // ナビゲーション
    if (spec.navigation && spec.navigation.length > 0) {
      lines.push('## Navigation');
      lines.push('');
      spec.navigation.forEach(nav => {
        lines.push(`### ${nav.label}`);
        nav.links.forEach(link => {
          lines.push(`- [${link.label}](${link.href || '#'})`);
        });
        lines.push('');
      });
    }

    // コンテンツ構造
    if (spec.content && spec.content.length > 0) {
      lines.push('## Content Structure');
      lines.push('');
      spec.content.forEach(c => {
        const hashes = '#'.repeat(Math.min(c.level + 2, 6));
        lines.push(`${hashes} ${c.text}`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }

  // ---- Private methods ----

  /**
   * ツリーを再帰的に走査して要素リストを収集
   */
  _collectElements(node, elements, parentSection) {
    if (!node) return;

    const element = this._nodeToElement(node, parentSection);
    if (element) elements.push(element);

    // セクション要素の場合は子のコンテキストを更新
    const section = this._getSectionLabel(node) || parentSection;

    if (node.children) {
      node.children.forEach(child => {
        this._collectElements(child, elements, section);
      });
    }
  }

  /**
   * SDDノードを統一Element形式に変換
   */
  _nodeToElement(node, parentSection) {
    const tag = node.tag;
    const role = node.role;
    const attrs = node.attrs || {};
    const text = node.text || '';

    // セレクタ生成（優先順位: aria-label > text > id > type+tag）
    const selector = this._generateSelector(node);
    const label = this._generateLabel(node);

    if (!label && !text && !node.isInteractive) return null;

    return {
      tag,
      role,
      label,
      text: text || null,
      selector,
      isInteractive: node.isInteractive || false,
      isClickable: node.isClickable || false,
      type: attrs.type || null,
      href: attrs.href || null,
      placeholder: attrs.placeholder || null,
      required: attrs.required !== undefined,
      disabled: attrs.disabled !== undefined,
      ariaLabel: attrs['aria-label'] || null,
      ariaRequired: attrs['aria-required'] === 'true',
      ariaExpanded: attrs['aria-expanded'] !== undefined
        ? attrs['aria-expanded'] === 'true' : null,
      section: parentSection,
      score: node.score || 0,
      headingLevel: attrs.level || null,
      formAction: attrs.action || null,
      formMethod: attrs.method || null
    };
  }

  /**
   * セマンティックセレクタを生成
   * IDやクラスに依存せず、役割とコンテキストから生成
   */
  _generateSelector(node) {
    const attrs = node.attrs || {};
    const parts = [];

    // 1. aria-label が最も確実
    if (attrs['aria-label']) {
      return `[aria-label="${attrs['aria-label']}"]`;
    }

    // 2. data-testid
    if (attrs['data-testid']) {
      return `[data-testid="${attrs['data-testid']}"]`;
    }

    // 3. id
    if (node.id) {
      return `#${node.id}`;
    }

    // 4. role + text
    if (node.role && node.text) {
      return `${node.role}:contains("${node.text.slice(0, 30)}")`;
    }

    // 5. タグ + type + placeholder
    if (node.tag === 'input' && attrs.type) {
      if (attrs.placeholder) {
        return `input[type="${attrs.type}"][placeholder="${attrs.placeholder}"]`;
      }
      return `input[type="${attrs.type}"]`;
    }

    // 6. タグ + テキスト
    if (node.text) {
      return `${node.tag}:contains("${node.text.slice(0, 30)}")`;
    }

    // 7. タグ + role
    if (node.role) {
      return `[role="${node.role}"]`;
    }

    return node.tag;
  }

  /**
   * セマンティックラベルを生成
   */
  _generateLabel(node) {
    const attrs = node.attrs || {};

    // aria-label が最優先
    if (attrs['aria-label']) return attrs['aria-label'];

    // alt テキスト
    if (attrs.alt) return attrs.alt;

    // テキストコンテンツ
    if (node.text && node.text.trim()) return node.text.trim();

    // placeholder
    if (attrs.placeholder) return `Input: ${attrs.placeholder}`;

    // role + type で推定
    if (node.role === 'button' && attrs.type === 'submit') return 'Submit Button';
    if (node.role === 'button' && attrs.type === 'reset') return 'Reset Button';

    // href から推定
    if (attrs.href) {
      const href = attrs.href;
      if (href === '/' || href === '#') return 'Home Link';
      const parts = href.split('/').filter(Boolean);
      if (parts.length > 0) return `Link to ${parts[parts.length - 1]}`;
    }

    return null;
  }

  /**
   * セクション判定（ナビ、フォーム、メインコンテンツ等）
   */
  _getSectionLabel(node) {
    const roleMap = {
      navigation: 'Navigation',
      main: 'Main Content',
      form: 'Form',
      banner: 'Header',
      contentinfo: 'Footer',
      complementary: 'Sidebar',
      dialog: 'Dialog',
      region: 'Region',
      search: 'Search',
    };
    if (node.role && roleMap[node.role]) return roleMap[node.role];
    if (node.tag === 'nav') return 'Navigation';
    if (node.tag === 'form') return 'Form';
    if (node.tag === 'main') return 'Main Content';
    if (node.tag === 'header') return 'Header';
    if (node.tag === 'footer') return 'Footer';
    if (node.tag === 'aside') return 'Sidebar';
    return null;
  }

  /**
   * アクション一覧を抽出（ボタン・リンク等）
   */
  _extractActions(elements) {
    return elements
      .filter(el => el.isInteractive || el.isClickable)
      .filter(el => el.score >= 0.4)
      .sort((a, b) => b.score - a.score)
      .map(el => ({
        type: this._getActionType(el),
        label: el.label || el.text || 'Unknown Action',
        selector: el.selector,
        description: this._generateActionDescription(el),
        context: el.section,
        href: el.href,
        params: el.tag === 'form' ? this._extractFormParams(el) : undefined
      }));
  }

  /**
   * アクションタイプを判定
   */
  _getActionType(el) {
    if (el.role === 'link' || el.tag === 'a') return 'navigate';
    if (el.role === 'button' || el.tag === 'button') {
      if (el.type === 'submit') return 'submit';
      return 'click';
    }
    if (['textbox', 'input', 'textarea'].includes(el.role) ||
        ['input', 'textarea'].includes(el.tag)) return 'input';
    if (el.role === 'listbox' || el.tag === 'select') return 'select';
    if (el.role === 'checkbox') return 'check';
    if (el.role === 'radio') return 'radio';
    if (el.isClickable) return 'click';
    return 'interact';
  }

  /**
   * アクションの説明文を生成
   */
  _generateActionDescription(el) {
    const label = el.label || el.text || '';
    const context = el.section ? ` in ${el.section}` : '';
    const type = this._getActionType(el);

    const templates = {
      navigate: `Navigate to ${label}${context}`,
      submit: `Submit ${context} form`,
      click: `Click "${label}"${context}`,
      input: `Enter text into ${label}${el.placeholder ? ` (${el.placeholder})` : ''}`,
      select: `Select an option from ${label}`,
      check: `Toggle checkbox: ${label}`,
      radio: `Select radio option: ${label}`,
      interact: `Interact with ${label}${context}`
    };

    return templates[type] || `${type}: ${label}`;
  }

  /**
   * フォームを抽出
   */
  _extractForms(elements) {
    const formElements = elements.filter(el =>
      el.tag === 'form' || el.section === 'Form'
    );

    const forms = [];
    const processedForms = new Set();

    // フォームをグループ化
    for (const el of elements) {
      if (el.tag === 'form') {
        const formKey = el.selector;
        if (processedForms.has(formKey)) continue;
        processedForms.add(formKey);

        const fields = elements.filter(f =>
          f.section === 'Form' &&
          ['input', 'select', 'textarea'].includes(f.tag) &&
          f !== el
        );

        forms.push({
          label: el.ariaLabel || 'Form',
          selector: el.selector,
          action: el.formAction,
          method: el.formMethod || 'get',
          fields: fields.map(f => ({
            name: f.ariaLabel || f.label || f.placeholder,
            label: f.label || f.placeholder || f.type || 'Field',
            type: f.type || f.tag,
            placeholder: f.placeholder,
            required: f.required || f.ariaRequired,
            selector: f.selector
          }))
        });
      }
    }

    // フォームタグがなくても入力フィールドがある場合
    if (forms.length === 0) {
      const fields = elements.filter(el =>
        ['input', 'select', 'textarea'].includes(el.tag) &&
        el.type !== 'hidden'
      );
      if (fields.length > 0) {
        forms.push({
          label: 'Form (implicit)',
          selector: 'form',
          fields: fields.map(f => ({
            name: f.ariaLabel || f.label || f.placeholder,
            label: f.label || f.placeholder || f.type || 'Field',
            type: f.type || f.tag,
            placeholder: f.placeholder,
            required: f.required || f.ariaRequired,
            selector: f.selector
          }))
        });
      }
    }

    return forms;
  }

  /**
   * ナビゲーションを抽出
   */
  _extractNavigation(elements) {
    const navLinks = elements.filter(el =>
      el.section === 'Navigation' &&
      (el.role === 'link' || el.tag === 'a') &&
      el.label
    );

    if (navLinks.length === 0) {
      // headerやfooter内のリンクも収集
      const allLinks = elements.filter(el =>
        (el.role === 'link' || el.tag === 'a') &&
        el.label &&
        ['Header', 'Footer', 'Sidebar'].includes(el.section)
      );
      if (allLinks.length === 0) return [];

      return [{
        label: 'Site Links',
        links: allLinks.map(l => ({
          label: l.label,
          href: l.href,
          selector: l.selector
        }))
      }];
    }

    return [{
      label: 'Main Navigation',
      links: navLinks.map(l => ({
        label: l.label,
        href: l.href,
        selector: l.selector
      }))
    }];
  }

  /**
   * コンテンツ構造（見出し）を抽出
   */
  _extractContent(elements) {
    return elements
      .filter(el => el.headingLevel && el.text)
      .sort((a, b) => a.headingLevel - b.headingLevel)
      .map(el => ({
        level: el.headingLevel,
        text: el.text,
        selector: el.selector
      }));
  }

  /**
   * 全インタラクティブ要素を抽出
   */
  _extractAllInteractive(elements) {
    return elements
      .filter(el => el.isInteractive)
      .map(el => ({
        type: this._getActionType(el),
        label: el.label || el.text,
        selector: el.selector,
        role: el.role,
        required: el.required,
        disabled: el.disabled
      }));
  }

  /**
   * ページサマリーを生成
   */
  _generateSummary(elements, pageInfo) {
    const interactiveCount = elements.filter(el => el.isInteractive).length;
    const formCount = elements.filter(el => el.tag === 'form').length;
    const navLinkCount = elements.filter(el =>
      el.section === 'Navigation' && el.role === 'link'
    ).length;
    const primaryActionCount = elements.filter(el =>
      el.isInteractive && el.score >= 0.7
    ).length;

    const headings = elements
      .filter(el => el.headingLevel === 1 && el.text)
      .map(el => el.text);

    const description = headings.length > 0
      ? `Page "${pageInfo.title}" with heading "${headings[0]}". `
      : `Page "${pageInfo.title}". `;

    const parts = [];
    if (interactiveCount > 0) parts.push(`${interactiveCount} interactive elements`);
    if (formCount > 0) parts.push(`${formCount} form(s)`);
    if (navLinkCount > 0) parts.push(`${navLinkCount} navigation links`);

    return {
      description: description + (parts.length > 0
        ? `Contains ${parts.join(', ')}.`
        : 'Mostly static content.'),
      interactiveCount,
      formCount,
      navLinkCount,
      primaryActionCount
    };
  }

  _extractFormParams(el) {
    return undefined; // 個別フォームフィールドから収集するため省略
  }
}
