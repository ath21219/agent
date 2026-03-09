-- agent/db/init.sql

-- pgvector 拡張
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── 会話ログ ───
CREATE TABLE chat_texts (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT        NOT NULL DEFAULT 'default',
    role            TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT        NOT NULL,
    token_estimate  INT         NOT NULL DEFAULT 0,
    embedding       vector(768),                        -- ruri-v3-310m = 768次元
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── パーソナル要素（fact 抽出結果）───
CREATE TABLE personal_elements (
    id              BIGSERIAL PRIMARY KEY,
    summary         TEXT        NOT NULL,               -- 例: "ユーザーは猫を2匹飼っている"
    importance      REAL        NOT NULL DEFAULT 0.5,   -- 0.0〜1.0
    embedding       vector(768),
    source_chat_ids BIGINT[]    NOT NULL DEFAULT '{}',  -- chat_texts.id への参照
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 会話要約（バッチ生成）───
CREATE TABLE conversation_summaries (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT        NOT NULL DEFAULT 'default',
    summary         TEXT        NOT NULL,
    chat_id_from    BIGINT      NOT NULL,               -- 要約対象の開始 chat_texts.id
    chat_id_to      BIGINT      NOT NULL,               -- 要約対象の終了 chat_texts.id
    embedding       vector(768),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── インデックス ───
-- HNSW: コサイン距離で近傍検索
CREATE INDEX idx_chat_texts_embedding
    ON chat_texts USING hnsw (embedding vector_cosine_ops);

CREATE INDEX idx_personal_elements_embedding
    ON personal_elements USING hnsw (embedding vector_cosine_ops);

CREATE INDEX idx_conversation_summaries_embedding
    ON conversation_summaries USING hnsw (embedding vector_cosine_ops);

-- 時系列クエリ用
CREATE INDEX idx_chat_texts_session_created
    ON chat_texts (session_id, created_at);

CREATE INDEX idx_conversation_summaries_session
    ON conversation_summaries (session_id, created_at);
