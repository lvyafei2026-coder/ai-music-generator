export async function findUserByEmail(env, email) {
  return env.DB.prepare(
    'SELECT * FROM users WHERE email = ?'
  ).bind(email.toLowerCase()).first();
}

export async function findUserById(env, id) {
  return env.DB.prepare(
    'SELECT * FROM users WHERE id = ?'
  ).bind(id).first();
}

export async function createUser(env, { id, email, passwordHash }) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, plan, generations_limit, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 'free', 3, 0, ?, ?)`
  ).bind(id, email.toLowerCase(), passwordHash, now, now).run();
  return findUserById(env, id);
}

export async function updateUserPlan(env, userId, { plan, limit, stripeCustomerId, stripeSubscriptionId }) {
  await env.DB.prepare(
    `UPDATE users SET plan = ?, generations_limit = ?, stripe_customer_id = ?, stripe_subscription_id = ?, updated_at = ? WHERE id = ?`
  ).bind(plan, limit, stripeCustomerId || null, stripeSubscriptionId || null, Date.now(), userId).run();
}

export async function incrementUsage(env, userId) {
  await env.DB.prepare(
    'UPDATE users SET generations_used = generations_used + 1, updated_at = ? WHERE id = ?'
  ).bind(Date.now(), userId).run();
}

export async function decrementUsage(env, userId) {
  await env.DB.prepare(
    'UPDATE users SET generations_used = MAX(0, generations_used - 1), updated_at = ? WHERE id = ?'
  ).bind(Date.now(), userId).run();
}

export async function createSession(env, { id, userId, expiresAt }) {
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  ).bind(id, userId, expiresAt, Date.now()).run();
}

export async function findSession(env, sessionId) {
  return env.DB.prepare(
    'SELECT * FROM sessions WHERE id = ? AND expires_at > ?'
  ).bind(sessionId, Date.now()).first();
}

export async function deleteSession(env, sessionId) {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

export async function createMusicTask(env, { id, userId, prompt, lyrics, isInstrumental, audioDuration }) {
  await env.DB.prepare(
    `INSERT INTO music_tasks (id, user_id, prompt, lyrics, is_instrumental, audio_duration, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(id, userId, prompt, lyrics || null, isInstrumental ? 1 : 0, audioDuration || null, Date.now()).run();
}

export async function getMusicTask(env, taskId, userId) {
  return env.DB.prepare(
    'SELECT * FROM music_tasks WHERE id = ? AND user_id = ?'
  ).bind(taskId, userId).first();
}

export async function updateMusicTask(env, taskId, updates) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(taskId);
  await env.DB.prepare(
    `UPDATE music_tasks SET ${fields.join(', ')} WHERE id = ?`
  ).bind(...values).run();
}

export async function listUserTasks(env, userId, limit = 20) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM music_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(userId, limit).all();
  return results || [];
}