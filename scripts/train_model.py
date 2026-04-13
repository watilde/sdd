#!/usr/bin/env python3
"""
SDD Distiller Model Training Script
====================================
DOMノードの重要度を予測するモデルを訓練して ONNX 形式でエクスポートする

特徴量 (41次元):
  isHighValueTag, isMediumValueTag, isContainerTag,
  isInteractive, isClickable, hasTabIndex,
  hasRole, roleBaseScore,
  hasAriaLabel, hasAriaLabelledBy, hasAriaDescribedBy,
  hasAriaRequired, hasAriaExpanded, hasAriaLive, hasTestId,
  hasText, textLength, isLabelText, isActionText,
  childCount, hasChildren, isLeaf,
  depth, depthPenalty,
  fontSizeNorm, isBold, areaRatio, isAboveFold, isLargeElement,
  hasHref, hasAlt, hasPlaceholder, isRequired, isDisabled,
  inputType, headingLevel,
  parentIsForm, parentIsNav, parentIsTable,
  parentIsInteractive, ancestorScore

ラベル:
  0.0 ~ 1.0 の重要度スコア（連続値回帰）
"""

import numpy as np
import json
import os
import sys
from pathlib import Path

# --- 依存ライブラリチェック ---
try:
    from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import Pipeline
    from sklearn.model_selection import train_test_split, cross_val_score
    from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
    import skl2onnx
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
except ImportError:
    print("Required packages not found. Install with:")
    print("  pip install scikit-learn skl2onnx numpy")
    sys.exit(1)

# ---- 設定 ----
SCRIPT_DIR = Path(__file__).parent
ROOT_DIR = SCRIPT_DIR.parent
MODEL_DIR = ROOT_DIR / "models"
DATA_DIR = ROOT_DIR / "data"
MODEL_DIR.mkdir(exist_ok=True)
DATA_DIR.mkdir(exist_ok=True)

FEATURE_KEYS = [
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
]
FEATURE_DIM = len(FEATURE_KEYS)

print(f"[SDD Training] Feature dimension: {FEATURE_DIM}")


# ================================================================
# データ生成（合成データ）
# 実際の学習では aria-*属性が正しいサイトのクロールデータを使用する
# ================================================================

def generate_synthetic_dataset(n_samples: int = 50000, seed: int = 42) -> tuple:
    """
    ヒューリスティックルールを教師として合成データを生成する
    実際の学習では:
    1. StorybookサイトのDOM → aria-* が正しく設定されたコンポーネント
    2. WCAG準拠サイトのクロールデータ
    などを使う
    """
    rng = np.random.default_rng(seed)
    X = np.zeros((n_samples, FEATURE_DIM), dtype=np.float32)
    y = np.zeros(n_samples, dtype=np.float32)

    for i in range(n_samples):
        f = {}

        # タグカテゴリ（排他的）
        tag_roll = rng.random()
        f['isHighValueTag']   = 1.0 if tag_roll < 0.20 else 0.0
        f['isMediumValueTag'] = 1.0 if 0.20 <= tag_roll < 0.40 else 0.0
        f['isContainerTag']   = 1.0 if tag_roll >= 0.40 else 0.0

        # インタラクション
        f['isInteractive'] = float(rng.random() < 0.25)
        f['isClickable']   = float(f['isInteractive'] or rng.random() < 0.1)
        f['hasTabIndex']   = float(f['isInteractive'] and rng.random() < 0.7)

        # アクセシビリティ
        f['hasRole']           = float(f['isHighValueTag'] or rng.random() < 0.3)
        role_scores = [0.85, 0.80, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25, 0.0]
        f['roleBaseScore']     = float(rng.choice(role_scores)) if f['hasRole'] else 0.0
        f['hasAriaLabel']      = float(f['hasRole'] and rng.random() < 0.5)
        f['hasAriaLabelledBy'] = float(f['hasRole'] and rng.random() < 0.3)
        f['hasAriaDescribedBy']= float(rng.random() < 0.15)
        f['hasAriaRequired']   = float(f['isInteractive'] and rng.random() < 0.4)
        f['hasAriaExpanded']   = float(f['isInteractive'] and rng.random() < 0.2)
        f['hasAriaLive']       = float(rng.random() < 0.05)
        f['hasTestId']         = float(rng.random() < 0.15)

        # テキスト
        f['hasText']      = float(rng.random() < 0.6)
        f['textLength']   = float(rng.beta(0.5, 2)) if f['hasText'] else 0.0
        f['isLabelText']  = float(f['hasText'] and rng.random() < 0.4)
        f['isActionText'] = float(f['isInteractive'] and rng.random() < 0.5)

        # 構造
        child_count = rng.integers(0, 15)
        f['childCount']  = float(min(child_count / 10, 1.0))
        f['hasChildren'] = float(child_count > 0)
        f['isLeaf']      = float(child_count == 0)
        depth = rng.integers(0, 20)
        f['depth']        = float(min(depth / 20, 1.0))
        depth_penalties = {0:1.0, 1:1.0, 2:1.0, 3:1.0, 4:0.85, 5:0.85, 6:0.85,
                           7:0.65, 8:0.65, 9:0.65, 10:0.65}
        f['depthPenalty'] = depth_penalties.get(depth, 0.25 if depth > 15 else 0.45)

        # 視覚
        f['fontSizeNorm']    = float(rng.beta(2, 5))
        f['isBold']          = float(rng.random() < 0.25)
        f['areaRatio']       = float(rng.beta(0.3, 3))
        f['isAboveFold']     = float(rng.random() < 0.6)
        f['isLargeElement']  = float(f['areaRatio'] > 0.05)

        # 属性
        f['hasHref']       = float(f['isHighValueTag'] and rng.random() < 0.6)
        f['hasAlt']        = float(rng.random() < 0.1)
        f['hasPlaceholder']= float(f['isInteractive'] and rng.random() < 0.5)
        f['isRequired']    = float(f['isInteractive'] and rng.random() < 0.3)
        f['isDisabled']    = float(rng.random() < 0.05)
        f['inputType']     = float(rng.choice([0.0, 0.5, 0.7, 0.8, 0.9, 1.0]))
        f['headingLevel']  = float(rng.choice([0.0]*8 + [0.83, 0.67, 0.5, 0.33]))

        # 親コンテキスト
        f['parentIsForm']        = float(f['isInteractive'] and rng.random() < 0.3)
        f['parentIsNav']         = float(rng.random() < 0.15)
        f['parentIsTable']       = float(rng.random() < 0.1)
        f['parentIsInteractive'] = float(f['isInteractive'] and rng.random() < 0.2)
        f['ancestorScore']       = float(rng.beta(2, 3))

        # ---- 正解スコア計算（ヒューリスティックモデルを教師とする） ----
        score = _heuristic_score(f)

        # わずかなノイズを加えて汎化を促進
        score += rng.normal(0, 0.03)
        score = float(np.clip(score, 0.0, 1.0))

        # X, y に格納
        for j, key in enumerate(FEATURE_KEYS):
            X[i, j] = f.get(key, 0.0)
        y[i] = score

    return X, y


def _heuristic_score(f: dict) -> float:
    """FeatureExtractor と対応するヒューリスティックスコア"""
    score = 0.0
    score += f['roleBaseScore']   * 0.30
    score += f['isHighValueTag']  * 0.20
    score += f['isMediumValueTag']* 0.08
    score += f['isInteractive']   * 0.18
    score += f['isClickable']     * 0.05
    score += f['hasAriaLabel']    * 0.06
    score += f['hasAriaRequired'] * 0.04
    score += f['hasTestId']       * 0.03
    score += f['hasAriaLive']     * 0.05
    score += f['isActionText']    * 0.12
    score += f['isLabelText']     * 0.04
    score += f['hasText']         * 0.03
    score += f['fontSizeNorm']    * 0.06
    score += f['isBold']          * 0.03
    score += f['isAboveFold']     * 0.04
    score += f['isLargeElement']  * 0.02
    score += f['hasHref']         * 0.05
    score += f['hasPlaceholder']  * 0.04
    score += f['isRequired']      * 0.05
    score += f['headingLevel']    * 0.06
    score += f['inputType']       * 0.04
    score += f['parentIsForm']    * 0.08
    score += f['parentIsNav']     * 0.05
    score += f['ancestorScore']   * 0.03
    score *= f['depthPenalty']
    if f['isDisabled']:        score *= 0.3
    if f['isContainerTag'] and not f['hasChildren'] and not f['hasText']:
        score *= 0.1
    if f['parentIsForm'] and f['isInteractive']:
        score = max(score, 0.7)
    if f['parentIsNav'] and f['hasHref']:
        score = max(score, 0.65)
    return float(np.clip(score, 0.0, 1.0))


# ================================================================
# 訓練
# ================================================================

def train(n_samples: int = 50000):
    print(f"\n[SDD Training] Generating {n_samples} synthetic samples...")
    X, y = generate_synthetic_dataset(n_samples)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.15, random_state=42
    )
    print(f"[SDD Training] Train: {len(X_train)}, Test: {len(X_test)}")

    # ---- モデル定義 ----
    # GradientBoosting: ヒューリスティックよりも汎化性能が高い
    model = Pipeline([
        ('scaler', StandardScaler()),
        ('regressor', GradientBoostingRegressor(
            n_estimators=200,
            max_depth=5,
            learning_rate=0.05,
            subsample=0.8,
            min_samples_leaf=10,
            random_state=42,
            verbose=0
        ))
    ])

    print("[SDD Training] Training GradientBoostingRegressor...")
    model.fit(X_train, y_train)

    # ---- 評価 ----
    y_pred = model.predict(X_test)
    y_pred = np.clip(y_pred, 0.0, 1.0)

    mse  = mean_squared_error(y_test, y_pred)
    mae  = mean_absolute_error(y_test, y_pred)
    r2   = r2_score(y_test, y_pred)
    rmse = np.sqrt(mse)

    print(f"\n[SDD Training] === Evaluation Results ===")
    print(f"  RMSE : {rmse:.4f}")
    print(f"  MAE  : {mae:.4f}")
    print(f"  R²   : {r2:.4f}")

    # 閾値精度（分類タスクとして評価）
    threshold = 0.3
    y_pred_binary = (y_pred >= threshold).astype(int)
    y_true_binary = (y_test >= threshold).astype(int)
    accuracy = np.mean(y_pred_binary == y_true_binary)
    print(f"  Threshold accuracy (t={threshold}): {accuracy:.4f}")

    # Feature importance
    regressor = model.named_steps['regressor']
    importances = regressor.feature_importances_
    top_features = sorted(zip(FEATURE_KEYS, importances),
                          key=lambda x: x[1], reverse=True)[:10]
    print(f"\n[SDD Training] Top 10 Feature Importances:")
    for feat, imp in top_features:
        bar = '█' * int(imp * 50)
        print(f"  {feat:<25} {bar} {imp:.4f}")

    # ---- ONNX エクスポート ----
    print(f"\n[SDD Training] Exporting to ONNX...")
    initial_type = [('input', FloatTensorType([None, FEATURE_DIM]))]
    onnx_model = convert_sklearn(model, initial_types=initial_type,
                                  target_opset=17)

    output_path = MODEL_DIR / "sdd-distiller-v1.onnx"
    with open(output_path, "wb") as f:
        f.write(onnx_model.SerializeToString())
    size_kb = output_path.stat().st_size / 1024
    print(f"[SDD Training] Model saved: {output_path} ({size_kb:.1f} KB)")

    # ---- メタデータ保存 ----
    meta = {
        "version": "1.0.0",
        "feature_keys": FEATURE_KEYS,
        "feature_dim": FEATURE_DIM,
        "model_type": "GradientBoostingRegressor",
        "n_estimators": 200,
        "training_samples": n_samples,
        "metrics": {
            "rmse": float(rmse),
            "mae": float(mae),
            "r2": float(r2),
            "threshold_accuracy": float(accuracy)
        },
        "top_features": [{"name": k, "importance": float(v)}
                         for k, v in top_features]
    }
    meta_path = MODEL_DIR / "sdd-distiller-v1-meta.json"
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"[SDD Training] Metadata saved: {meta_path}")

    return model, meta


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Train SDD distiller model")
    parser.add_argument("--samples", type=int, default=50000,
                        help="Number of training samples")
    args = parser.parse_args()
    train(n_samples=args.samples)
    print("\n[SDD Training] Complete! Run the demo with: node demo/server.js")
