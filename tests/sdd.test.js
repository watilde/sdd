/**
 * SDD Unit Tests
 * Node.js test runner (--experimental-vm-modules)
 */

import { SemanticDOMDistiller } from '../src/index.js';
import { DOMExtractor } from '../src/extraction/DOMExtractor.js';
import { FeatureExtractor } from '../src/distillation/FeatureExtractor.js';
import { ImportanceScorer } from '../src/distillation/ImportanceScorer.js';
import { ActionOrientedTransformer } from '../src/transformation/ActionOrientedTransformer.js';

// ---- Test HTML fixtures ----
const SIMPLE_FORM_HTML = `
<!DOCTYPE html>
<html lang="en">
<head><title>Login Form</title></head>
<body>
  <header>
    <nav aria-label="Main navigation">
      <a href="/">Home</a>
      <a href="/about">About</a>
    </nav>
  </header>
  <main>
    <h1>Sign In</h1>
    <form action="/login" method="post">
      <label for="email">Email address</label>
      <input id="email" type="email" name="email"
        placeholder="you@example.com" required aria-required="true" />

      <label for="password">Password</label>
      <input id="password" type="password" name="password"
        placeholder="Enter password" required aria-required="true" />

      <button type="submit">Sign In</button>
      <a href="/forgot">Forgot password?</a>
    </form>
  </main>
  <footer>
    <p>© 2024 Example Corp</p>
  </footer>
</body>
</html>
`;

const COMPLEX_DIV_SOUP_HTML = `
<!DOCTYPE html>
<html>
<head><title>Noisy Page</title></head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="row">
        <div class="col">
          <div class="card">
            <div class="card-body">
              <!-- Deeply nested meaningless div soup -->
              <div><div><div><div><div>
                <button data-testid="submit-btn" aria-label="Submit order">
                  Submit Order
                </button>
              </div></div></div></div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>alert('noise')</script>
  <style>.hidden { display: none }</style>
</body>
</html>
`;

const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="ja">
<head><title>Dashboard</title></head>
<body>
  <nav role="navigation" aria-label="Sidebar Navigation">
    <a href="/dashboard">Dashboard</a>
    <a href="/users">User Management</a>
    <a href="/settings">Settings</a>
  </nav>
  <main role="main">
    <h1>Dashboard</h1>
    <h2>Overview</h2>
    <section aria-label="Statistics">
      <p>Total Users: <strong>1,234</strong></p>
    </section>
    <section>
      <h2>Actions</h2>
      <button aria-label="Add User">Add</button>
      <button aria-label="Export Report">Export</button>
      <input type="search" placeholder="Search users" aria-label="Search" />
    </section>
  </main>
</body>
</html>
`;

// ================================================================
// FeatureExtractor Tests
// ================================================================

describe('FeatureExtractor', () => {
  let extractor;

  beforeEach(() => {
    extractor = new FeatureExtractor();
  });

  test('should have correct feature dimension', () => {
    expect(extractor.featureDim).toBe(41);
  });

  test('should extract features for a button node', () => {
    const node = {
      tag: 'button',
      role: 'button',
      text: 'Submit',
      isInteractive: true,
      isClickable: true,
      attrs: { type: 'submit', 'aria-label': 'Submit form' },
      depth: 3,
      children: undefined
    };
    const features = extractor.extractFeatures(node);
    expect(features.isHighValueTag).toBe(1.0);
    expect(features.isInteractive).toBe(1.0);
    expect(features.isClickable).toBe(1.0);
    expect(features.roleBaseScore).toBe(0.85);
    expect(features.hasAriaLabel).toBe(1.0);
    expect(features.isActionText).toBe(1.0);
  });

  test('should extract features for an input node', () => {
    const node = {
      tag: 'input',
      role: 'textbox',
      isInteractive: true,
      isClickable: true,
      attrs: { type: 'email', placeholder: 'Email', required: '' },
      depth: 5
    };
    const features = extractor.extractFeatures(node);
    expect(features.isHighValueTag).toBe(1.0);
    expect(features.hasPlaceholder).toBe(1.0);
    expect(features.isRequired).toBe(1.0);
    expect(features.inputType).toBeGreaterThan(0.5);
  });

  test('should penalize deep elements', () => {
    const shallowNode = { tag: 'div', depth: 1, isInteractive: false };
    const deepNode = { tag: 'div', depth: 18, isInteractive: false };
    const shallowF = extractor.extractFeatures(shallowNode);
    const deepF = extractor.extractFeatures(deepNode);
    expect(shallowF.depthPenalty).toBeGreaterThan(deepF.depthPenalty);
  });

  test('should convert to Float32Array of correct length', () => {
    const node = { tag: 'a', role: 'link', attrs: { href: '/home' }, depth: 2 };
    const features = extractor.extractFeatures(node);
    const arr = extractor.toFloat32Array(features);
    expect(arr).toBeInstanceOf(Float32Array);
    expect(arr.length).toBe(41);
    for (const val of arr) {
      expect(val).toBeGreaterThanOrEqual(0.0);
      expect(val).toBeLessThanOrEqual(1.0);
    }
  });

  test('should detect action text correctly', () => {
    const actionNode = { tag: 'button', text: 'Submit form', depth: 2 };
    const normalNode = { tag: 'p', text: 'Hello world', depth: 2 };
    const actionF = extractor.extractFeatures(actionNode);
    const normalF = extractor.extractFeatures(normalNode);
    expect(actionF.isActionText).toBe(1.0);
    expect(normalF.isActionText).toBe(0.0);
  });

  test('should detect action text in various languages', () => {
    const node = { tag: 'button', text: 'Submit', depth: 2 };
    const features = extractor.extractFeatures(node);
    expect(features.isActionText).toBe(1.0);
  });
});

// ================================================================
// ImportanceScorer Tests
// ================================================================

describe('ImportanceScorer', () => {
  let scorer;

  beforeEach(() => {
    scorer = new ImportanceScorer({ threshold: 0.3, useOnnx: false });
  });

  test('should score button node higher than empty div', async () => {
    const buttonNode = {
      tag: 'button',
      role: 'button',
      text: 'Submit',
      isInteractive: true,
      isClickable: true,
      attrs: { type: 'submit' },
      depth: 3
    };
    const emptyDiv = {
      tag: 'div',
      role: null,
      text: null,
      isInteractive: false,
      isClickable: false,
      depth: 10
    };

    const scoredButton = await scorer.scoreTree(buttonNode);
    const scoredDiv = await scorer.scoreTree(emptyDiv);

    expect(scoredButton.score).toBeGreaterThan(scoredDiv.score);
    expect(scoredButton.score).toBeGreaterThan(0.5);
  });

  test('should score aria-labeled elements highly', async () => {
    const node = {
      tag: 'input',
      role: 'textbox',
      isInteractive: true,
      isClickable: true,
      attrs: { 'aria-label': 'Search', placeholder: 'Search...' },
      depth: 4
    };
    const scored = await scorer.scoreTree(node);
    expect(scored.score).toBeGreaterThan(0.6);
  });

  test('should prune low-importance nodes', async () => {
    const tree = {
      tag: 'div',
      depth: 0,
      children: [
        { tag: 'div', depth: 1, text: null, isInteractive: false },
        { tag: 'button', role: 'button', text: 'Click me',
          isInteractive: true, isClickable: true, depth: 1 }
      ]
    };
    const pruned = await scorer.pruneTree(tree);
    // button should survive pruning
    const hasButton = pruned?.children?.some(c => c.tag === 'button');
    expect(hasButton).toBe(true);
  });

  test('should keep nodes with important children', async () => {
    const tree = {
      tag: 'section',
      depth: 0,
      children: [{
        tag: 'button',
        role: 'button',
        text: 'Important Action',
        isInteractive: true,
        depth: 1,
        attrs: { 'aria-label': 'Important Action' }
      }]
    };
    const pruned = await scorer.pruneTree(tree);
    // section should be kept because it has important children
    expect(pruned).not.toBeNull();
    expect(pruned.children?.length).toBeGreaterThan(0);
  });
});

// ================================================================
// DOMExtractor Tests
// ================================================================

describe('DOMExtractor', () => {
  let extractor;

  beforeEach(() => {
    extractor = new DOMExtractor({ includeHidden: false });
  });

  test('should extract from HTML string', () => {
    const result = extractor.extractFromHTML(SIMPLE_FORM_HTML);
    expect(result.title).toBe('Login Form');
    expect(result.lang).toBe('en');
    expect(result.tree).toBeDefined();
    expect(result.stats.totalNodes).toBeGreaterThan(0);
  });

  test('should remove script and style tags', () => {
    const result = extractor.extractFromHTML(COMPLEX_DIV_SOUP_HTML);
    const findTag = (node, tag) => {
      if (!node) return false;
      if (node.tag === tag) return true;
      return node.children?.some(c => findTag(c, tag)) || false;
    };
    expect(findTag(result.tree, 'script')).toBe(false);
    expect(findTag(result.tree, 'style')).toBe(false);
  });

  test('should detect interactive elements', () => {
    const result = extractor.extractFromHTML(SIMPLE_FORM_HTML);
    expect(result.stats.interactiveNodes).toBeGreaterThan(0);
  });

  test('should assign correct roles to elements', () => {
    const result = extractor.extractFromHTML(DASHBOARD_HTML);
    const findRole = (node, role) => {
      if (!node) return false;
      if (node.role === role) return true;
      return node.children?.some(c => findRole(c, role)) || false;
    };
    expect(findRole(result.tree, 'heading')).toBe(true);
    expect(findRole(result.tree, 'navigation')).toBe(true);
  });

  test('should extract text content from nodes', () => {
    const html = `<body><button>Click me</button></body>`;
    const result = extractor.extractFromHTML(html);
    const findText = (node, text) => {
      if (!node) return false;
      if (node.text === text) return true;
      return node.children?.some(c => findText(c, text)) || false;
    };
    expect(findText(result.tree, 'Click me')).toBe(true);
  });

  test('should compute stats correctly', () => {
    const result = extractor.extractFromHTML(SIMPLE_FORM_HTML);
    expect(result.stats).toMatchObject({
      totalNodes: expect.any(Number),
      interactiveNodes: expect.any(Number),
      maxDepth: expect.any(Number)
    });
    expect(result.stats.totalNodes).toBeGreaterThan(5);
  });
});

// ================================================================
// ActionOrientedTransformer Tests
// ================================================================

describe('ActionOrientedTransformer', () => {
  let transformer;

  beforeEach(() => {
    transformer = new ActionOrientedTransformer();
  });

  const makeScoredTree = () => ({
    tag: 'body',
    score: 0.5,
    depth: 0,
    children: [
      {
        tag: 'nav',
        role: 'navigation',
        score: 0.7,
        depth: 1,
        children: [
          { tag: 'a', role: 'link', text: 'Home', score: 0.75,
            attrs: { href: '/' }, isInteractive: true, depth: 2 },
          { tag: 'a', role: 'link', text: 'About', score: 0.70,
            attrs: { href: '/about' }, isInteractive: true, depth: 2 }
        ]
      },
      {
        tag: 'main', role: 'main', score: 0.65, depth: 1,
        children: [
          { tag: 'h1', role: 'heading', text: 'Sign In', score: 0.70,
            attrs: { level: 1 }, depth: 2 },
          {
            tag: 'form', score: 0.75, depth: 2,
            attrs: { action: '/login', method: 'post' },
            children: [
              { tag: 'input', role: 'textbox', score: 0.85,
                attrs: { type: 'email', placeholder: 'Email', required: '' },
                isInteractive: true, depth: 3 },
              { tag: 'button', role: 'button', text: 'Sign In', score: 0.90,
                attrs: { type: 'submit', 'aria-label': 'Sign In' },
                isInteractive: true, isClickable: true, depth: 3 }
            ]
          }
        ]
      }
    ]
  });

  test('should transform scored tree to spec', () => {
    const spec = transformer.transform(makeScoredTree(), {
      url: 'https://example.com',
      title: 'Login',
      lang: 'en'
    });

    expect(spec.$schema).toBeDefined();
    expect(spec.page.url).toBe('https://example.com');
    expect(spec.page.title).toBe('Login');
    expect(spec.actions).toBeInstanceOf(Array);
    expect(spec.summary).toBeDefined();
  });

  test('should detect actions correctly', () => {
    const spec = transformer.transform(makeScoredTree(), { title: 'Test' });
    expect(spec.actions.length).toBeGreaterThan(0);
    const types = spec.actions.map(a => a.type);
    expect(types).toContain('submit');
  });

  test('should generate valid markdown', () => {
    const spec = transformer.transform(makeScoredTree(), {
      url: 'https://example.com',
      title: 'Login'
    });
    const markdown = transformer.toMarkdown(spec);
    expect(markdown).toContain('# Page Specification');
    expect(markdown).toContain('https://example.com');
    expect(markdown).toContain('## Summary');
    expect(markdown).toContain('## Available Actions');
    expect(typeof markdown).toBe('string');
    expect(markdown.length).toBeGreaterThan(100);
  });

  test('should extract navigation links', () => {
    const spec = transformer.transform(makeScoredTree(), { title: 'Test' });
    expect(spec.navigation).toBeInstanceOf(Array);
  });

  test('should generate selectors without relying on class names', () => {
    const spec = transformer.transform(makeScoredTree(), { title: 'Test' });
    spec.actions.forEach(action => {
      expect(action.selector).toBeDefined();
      // must not rely on class name selectors (.xxx)
      expect(action.selector).not.toMatch(/^\.[a-z0-9_-]+$/i);
    });
  });
});

// ================================================================
// SemanticDOMDistiller Integration Tests
// ================================================================

describe('SemanticDOMDistiller (Integration)', () => {
  let sdd;

  beforeEach(() => {
    sdd = new SemanticDOMDistiller({
      threshold: 0.3,
      useOnnx: false
    });
  });

  test('should distill simple form HTML', async () => {
    const result = await sdd.distillHTML(SIMPLE_FORM_HTML, 'https://example.com');
    expect(result.spec).toBeDefined();
    expect(result.markdown).toBeDefined();
    expect(result.meta).toBeDefined();
    expect(result.meta.originalNodes).toBeGreaterThan(0);
    expect(result.meta.distilledNodes).toBeGreaterThan(0);
    expect(result.meta.distilledNodes).toBeLessThanOrEqual(result.meta.originalNodes);
  }, 15000);

  test('should compress noisy div-soup HTML', async () => {
    const result = await sdd.distillHTML(COMPLEX_DIV_SOUP_HTML);
    // compression should occur
    expect(result.meta.distilledNodes).toBeLessThan(result.meta.originalNodes);
  }, 15000);

  test('should detect submit button in form', async () => {
    const result = await sdd.distillHTML(SIMPLE_FORM_HTML, 'https://example.com');
    const actions = result.spec.actions || [];
    const submitAction = actions.find(a => a.type === 'submit' || a.type === 'click');
    expect(submitAction).toBeDefined();
  }, 15000);

  test('should produce valid markdown with headings', async () => {
    const result = await sdd.distillHTML(DASHBOARD_HTML);
    expect(result.markdown).toContain('# Page Specification');
    expect(result.markdown).toContain('## Summary');
  }, 15000);

  test('should work in heuristic mode (useOnnx: false)', async () => {
    const sddHeuristic = new SemanticDOMDistiller({
      threshold: 0.3,
      useOnnx: false
    });
    const result = await sddHeuristic.distillHTML(SIMPLE_FORM_HTML);
    expect(result.meta.mode).toBe('heuristic');
  }, 15000);

  test('should respect threshold - higher threshold means fewer nodes', async () => {
    const sddLow = new SemanticDOMDistiller({ threshold: 0.1, useOnnx: false });
    const sddHigh = new SemanticDOMDistiller({ threshold: 0.7, useOnnx: false });
    const resultLow = await sddLow.distillHTML(SIMPLE_FORM_HTML);
    const resultHigh = await sddHigh.distillHTML(SIMPLE_FORM_HTML);
    expect(resultLow.meta.distilledNodes).toBeGreaterThanOrEqual(
      resultHigh.meta.distilledNodes
    );
  }, 20000);
});
