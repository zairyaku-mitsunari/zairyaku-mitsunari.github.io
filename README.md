# 財略三成（Web版）

個人用の出納帳アプリです。記録は利用者の端末の中だけに保存し、このサイトには送りません。

文字認識に PaddleOCR の PP-OCRv6 モデル（Apache-2.0）と ONNX Runtime Web（MIT）を同梱し、予備として Tesseract.js（Apache-2.0）を同梱しています。
詳しくは `vendor/paddle/README.md`・`vendor/ort/README.md`・`vendor/tesseract/README.md`。
日本語PDFの読み取りに Adobe の対応表（BSD 3条項）を同梱しています。詳しくは `vendor/adobe/README.md`。
画面の題字は、筆文字フォント Yuji Syuku（SIL Open Font License 1.1）の字形を図形にしたものです。

画像と文章の無断利用はご遠慮ください。
