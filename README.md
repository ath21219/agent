# my-agent フォルダ構成と主要ファイルの役割

本プロジェクト(`my-agent`)は、Next.jsをベースとした、音声認識(VAD/STT)・音声合成(TTS)・3Dアバター(VRM)連携を目的としたAIエージェント機能を実装したWebフロントエンド・アプリケーションです。

以下は、`my-agent` 内のGit管理対象（トラッキング対象）となっている主要なファイルとフォルダの役割のまとめです。

## 📁 `src/` (ソースコード)
アプリケーションの主要なUIとロジックを構成するディレクトリです。

### `src/app/` (Next.js App Router)
- **`page.tsx`**: アプリケーションのメイン画面（ルートページ）となるReactコンポーネント。
- **`layout.tsx`**: サイト全体の共通レイアウト（HTML構造やメタ情報）を定義するファイル。
- **`globals.css`**: アプリケーション全体のグローバルスタイル定義（TailwindCSSのインポートなど）。
- **`api/stt/route.ts`**: 音声データを受け取り、サーバーサイドで音声認識(Speech-to-Text)処理を行うためのAPIルート。
- **`api/tts/route.ts`**: テキストデータを受け取り、サーバーサイドで音声合成(Text-to-Speech)処理を行うためのAPIルート。
- **`api/llm/chat/completions/route.ts`**: テキストプロンプトを受け取り、LLM(大規模言語モデル)の推論ストリームを返すためのAPIルート。
- **`favicon.ico`**: サイトのファビコン（アイコン）。

### `src/components/` (Reactコンポーネント)
- **`VRMScene.tsx`**: 3Dアバター（VRMファイル）を描画し、アニメーションなどの制御を行うためのコンポーネント。
- **`VoiceInput.tsx`**: ユーザーのマイクから音声入力を受け付け、VAD（Voice Activity Detection: 音声区間検出）を実行するためのコンポーネント。

### `src/lib/` (コアロジック・ユーティリティ)
- **`agent.ts`**: エージェント（アバター）の全体的な状態管理やインタラクションの振る舞いを司るモジュール。
- **`lipsync.ts`**: 再生される音声データに同期して、3Dアバターの口の動き（リップシンク）を計算・反映するモジュール。
- **`tts.ts`**: アプリケーションからのテキストデータを音声として生成（Text-to-Speech）するための連携モジュール。
- **`vision.ts`**: ユーザーのカメラ画像等を解析し、画像ベースの認識(Vision)処理を行うためのモジュール。

## 📁 `public/` (静的アセット)
ブラウザから直接アクセス可能な静的ファイルを配置するディレクトリです。

- **`models/`**: アプリ内でレンダリングされるAIエージェントの3Dアバターモデル本体の格納先パス。
- **`vad/`**: VAD（音声区間検出）をブラウザ上でローカル実行するために必要なファイル群（各種WASM、JSライブラリ、ONNX推論モデルの `silero_vad_legacy.onnx`, `silero_vad_v5.onnx`等）の格納先パス。
- **各種SVG画像 (`file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, `window.svg`)**: UI上で使用されるアイコンなどの静的画像ファイル。

## 📁 `scripts/` (ビルド・開発補助スクリプト)
- **`copy-vad-files.sh`**: 必要なVAD関連ファイル（WASMやONNXモデル）等を、パッケージ(node_modules)から `public/vad/` 配下へ自動的にコピー・配置するためのシェルスクリプト。

## 📄 各種設定ファイル (ルートディレクトリ)
プロジェクトの動作やビルドプロセスを制御する重要な設定ファイル群です。

- **`package.json` / `package-lock.json`**: プロジェクト全体のNPM依存関係（パッケージ）と、実行可能なスクリプトコマンドの定義。
- **`next.config.ts`**: Next.js固有のビルド設定やルーティング等の設定を記述するTypeScriptファイル。
- **`tsconfig.json`**: TypeScriptのコンパイラ設定ファイル（型チェックの厳密さや出力形式の指定）。
- **`eslint.config.mjs`**: ESLintの設定ファイル。TypeScriptやReactコードの静的解析（文法・スタイルチェック）ルールを定義。
- **`postcss.config.mjs`**: CSSの変換処理を行うPostCSSの設定ファイル（主にTailwindCSSなどを機能させるために使用）。
- **`.gitignore`**: Gitのバージョン管理から除外するファイル・ディレクトリ（`node_modules`やビルド成果物など）を指定。
- **`README.md`**: `my-agent` プロジェクト自体の概要や開発開始手順などを記載したドキュメント。
