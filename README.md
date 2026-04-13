# Semantic DOM Distiller (SDD)

> DOM-to-Specification preprocessing engine optimized for multimodal AI like Amazon Nova Act

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)

## Overview

Modern websites have extremely complex and obfuscated DOM structures. Feeding raw DOM to LLMs causes:
- **Token cost explosion** — thousands of meaningless `<div>` tags
- **Degraded reasoning accuracy** — noise overwhelms signal

SDD solves this with a 3-stage pipeline:

```
URL → [① Extraction] → [② Distillation] → [③ Transformation] → Action-oriented JSON / Markdown
```

## Architecture

### ① Extraction Layer
- **Tech**: Playwright + jsdom
- Removes invisible elements using computed styles
- Strips `script`, `style`, `svg` and other metadata
- Simplifies structure based on WAI-ARIA accessibility tree (Role/Aria)

### ② Intelligent Distillation Layer
- **Tech**: onnxruntime-node (`distiller-v1.onnx`)
- Scores each DOM node from **0.0 to 1.0** based on:
  - Tag type, nesting depth, child composition
  - Interactivity (`isClickable`, `hasEventListeners`)
  - Visual weight (font size, area ratio)
  - Accessibility attributes (aria-label, aria-required, etc.)
- Prunes nodes below threshold → **Functional DOM Tree**

### ③ Transformation Layer
- Converts to **Action-oriented JSON** interpretable by Amazon Nova Act
- Assigns **semantic labels** (not class names): "This button has the role of 'Save'"
- Outputs both JSON spec and Markdown specification document

## Quick Start

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Train the ONNX model (requires Python + scikit-learn)
pip install scikit-learn skl2onnx numpy
python3 scripts/train_model.py

# Run CLI on a URL
node src/index.js https://example.com

# Start Demo UI
node demo/server.js
```

## Demo UI

After running `node demo/server.js`, open http://localhost:3000

Features:
- 🔗 Enter any URL → get Markdown specification
- 🎚️ Adjustable pruning threshold
- 📊 Compression ratio visualization
- 🎯 Action detection panel (click, input, navigate, submit)
- 📋 One-click copy for Markdown / JSON output

## SDK Usage

```javascript
import { SemanticDOMDistiller } from './src/index.js';

const sdd = new SemanticDOMDistiller({
  threshold: 0.3,   // Importance pruning threshold (0.0–1.0)
  timeout: 30000,   // Page load timeout (ms)
  useOnnx: true     // Use ONNX model (falls back to heuristic if not found)
});

// Process a URL
const result = await sdd.distill('https://example.com');

console.log(result.markdown);  // Markdown specification
console.log(result.spec);      // Action-oriented JSON
console.log(result.meta);
// {
//   originalNodes: 2847,
//   distilledNodes: 143,
//   compressionRatio: 94,   // % reduction
//   processingTimeMs: 4231,
//   mode: 'onnx'            // or 'heuristic'
// }

// Process raw HTML (no browser needed)
const result2 = await sdd.distillHTML(htmlString, 'https://base.url');
```

## Output Format

### Action-oriented JSON
```json
{
  "$schema": "https://github.com/watilde/sdd/schemas/action-spec-v1.json",
  "page": { "title": "Login", "url": "https://example.com/login" },
  "summary": {
    "description": "Page 'Login' with heading 'Sign In'. Contains 4 interactive elements, 1 form(s).",
    "interactiveCount": 4,
    "formCount": 1,
    "primaryActionCount": 2
  },
  "actions": [
    {
      "type": "submit",
      "label": "Sign In",
      "selector": "[aria-label=\"Sign In\"]",
      "description": "Submit Form form"
    },
    {
      "type": "input",
      "label": "Input: you@example.com",
      "selector": "input[type=\"email\"][placeholder=\"you@example.com\"]",
      "description": "Enter text into Input: you@example.com (you@example.com)"
    }
  ],
  "forms": [...],
  "navigation": [...],
  "content": [...]
}
```

### Markdown Specification
```markdown
# Page Specification: Login

**URL**: `https://example.com/login`

## Summary
Page "Login" with heading "Sign In". Contains 4 interactive elements, 1 form(s).

## Available Actions
### 1. Sign In
- **Type**: submit
- **Selector**: `[aria-label="Sign In"]`
- **Description**: Submit Form form

## Forms
### Form 1: Form
- **Action**: /login
- **Method**: POST
- **Fields**:
  - `email` [email] *(required)*: Input: you@example.com
  - `password` [password] *(required)*: Input: Enter password
```

## Feature Vector (41 dimensions)

| Category | Features |
|----------|---------|
| Tag | isHighValueTag, isMediumValueTag, isContainerTag |
| Interaction | isInteractive, isClickable, hasTabIndex |
| Accessibility | hasRole, roleBaseScore, hasAriaLabel, hasAriaRequired, hasAriaLive, hasTestId |
| Text | hasText, textLength, isLabelText, isActionText |
| Structure | childCount, hasChildren, isLeaf, depth, depthPenalty |
| Visual | fontSizeNorm, isBold, areaRatio, isAboveFold, isLargeElement |
| Attributes | hasHref, hasAlt, hasPlaceholder, isRequired, isDisabled, inputType, headingLevel |
| Parent context | parentIsForm, parentIsNav, parentIsTable, parentIsInteractive, ancestorScore |

## Model Training

```bash
# Train with default 50k samples
python3 scripts/train_model.py

# Train with larger dataset
python3 scripts/train_model.py --samples 200000
```

Training strategy:
1. **Synthetic data**: Heuristic rules as teacher signal (bootstrap)
2. **Real data** (future): Crawl Storybook / accessible sites with proper `aria-*` attributes
3. **ONNX export**: ~200KB model via `skl2onnx` (GradientBoostingRegressor)

## Technical Challenges

- **Obfuscation**: Tailwind CSS / CSS Modules class names are ignored; function identified from structural DNA
- **Dynamic DOM**: Modal/dropdown appearing on interaction catalogued as "latent features"
- **Lightweight**: Target <500KB model, runs in browser extension / CI/CD pipeline

## Roadmap

- [ ] `distiller-v1.onnx` upload to Hugging Face Hub
- [ ] npm package `sdd` publish
- [ ] Real training dataset from Storybook crawls
- [ ] Dynamic DOM capture (modals, dropdowns)
- [ ] Browser extension (Chrome/Firefox)
- [ ] CI/CD integration (GitHub Actions)

## License

MIT © watilde
