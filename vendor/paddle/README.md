# 高精度の文字認識のモデル（外部に送らず、端末内で動く）

| ファイル | 出所（Hugging Face の PaddlePaddle 公式） | 版（コミット） | ライセンス |
|---|---|---|---|
| det.onnx（文字のある場所を探す） | PaddlePaddle/PP-OCRv6_small_det_onnx の inference.onnx | 28fe5895c24f | Apache-2.0 |
| rec.onnx（文字を読む） | PaddlePaddle/PP-OCRv6_small_rec_onnx の inference.onnx | b8f84f0b80c5 | Apache-2.0 |
| rec.yml（読める文字の一覧と設定） | PaddlePaddle/PP-OCRv6_small_rec_onnx の inference.yml | b8f84f0b80c5 | Apache-2.0 |

取得日 2026-11-27。det.onnx と rec.onnx は、配布元が公開している SHA-256 と一致することを確認して取り込んだ。中身は変更していない（名前だけ変更）。
ライセンス本文は LICENSE-PaddleOCR.txt（github.com/PaddlePaddle/PaddleOCR）。
内容の確認用の値は `checksums.json`（`scripts/prepare_publish.py` が照合する）。
