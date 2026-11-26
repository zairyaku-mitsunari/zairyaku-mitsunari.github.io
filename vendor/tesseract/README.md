# 同梱している文字認識（外部に送らず、端末内で動く）

| ファイル | 出所（npm） | 版 | ライセンス |
|---|---|---|---|
| tesseract.min.js・worker.min.js | tesseract.js | 7.0.0 | Apache-2.0（LICENSE-tesseract.js.md） |
| core/*.wasm.js | tesseract.js-core | 7.0.0 | Apache-2.0（LICENSE-tesseract.js-core.txt） |
| lang/jpn.traineddata.gz | @tesseract.js-data/jpn（4.0.0_best_int） | 1.0.0 | パッケージの表示は MIT（学習データの元は tesseract-ocr/tessdata_best、Apache-2.0） |

取得日 2026-11-25。npm が公開している sha512 と一致することを確認して取り込んだ。中身は変更していない。
内容の確認用の値は `checksums.json`（`scripts/prepare_publish.py` が照合する）。
プログラム内に既定の配信元（cdn.jsdelivr.net）の記述があるが、このアプリは同じ場所のファイルを指定し、
画面の安全設定（CSP）でも外部への接続を禁止している。
