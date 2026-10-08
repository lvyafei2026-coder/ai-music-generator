-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  generations_used INTEGER NOT NULL DEFAULT 0,
  generations_limit INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);

-- 音乐生成任务表
CREATE TABLE IF NOT EXISTS music_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  lyrics TEXT,
  is_instrumental INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  audio_key TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_user ON music_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON music_tasks(status);

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 增加邮箱验证状态字段
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- 创建邮箱验证令牌表
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verify_tokens_user ON email_verification_tokens(user_id);

ALTER TABLE music_tasks ADD COLUMN run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON music_tasks(run_id);