# 文字認識を動かすソフト（ONNX Runtime Web）

| ファイル | 出所（npm） | 版 | ライセンス |
|---|---|---|---|
| ort.wasm.min.mjs・ort-wasm-simd-threaded.mjs・ort-wasm-simd-threaded.wasm | onnxruntime-web の dist/ | 1.31.1 | MIT（LICENSE-onnxruntime.txt。github.com/microsoft/onnxruntime の v1.31.1） |

取得日 2026-11-27。npm が公開している sha512 と一致することを確認して取り込んだ。中身は変更していない。
内容の確認用の値は `checksums.json`（`scripts/prepare_publish.py` が照合する）。
このアプリは同じ場所のファイルだけを使い、画面の安全設定（CSP）でも外部への接続を禁止している。
