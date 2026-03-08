#!/bin/bash
# VAD に必要なファイルを public/ にコピー
mkdir -p public/vad

# VAD モデル & worklet
cp node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx public/vad/
cp node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx public/vad/
cp node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js public/vad/

# ONNX Runtime WASM
cp node_modules/onnxruntime-web/dist/*.wasm public/vad/
cp node_modules/onnxruntime-web/dist/*.mjs public/vad/

echo "VAD files copied to public/vad/"
