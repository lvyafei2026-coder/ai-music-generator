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

// ==================== 邀请返利 ====================
export async function findUserByInviteCode(env, code) {
  return env.DB.prepare(
    'SELECT * FROM users WHERE invite_code = ?'
  ).bind(code).first();
}

export async function getInviteStats(env, userId) {
  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) as c FROM invites WHERE inviter_id = ?'
  ).bind(userId).first();
  const bonusRow = await env.DB.prepare(
    'SELECT COALESCE(bonus_generations, 0) as b FROM users WHERE id = ?'
  ).bind(userId).first();
  return {
    count: (countRow && countRow.c) || 0,
    bonus: (bonusRow && bonusRow.b) || 0
  };
}

// ==================== 邀请返利 v2 ====================

// 注册时：检查邀请人是否还能拿返利，插一条 pending 记录
export async function createPendingInvite(env, { id, inviterId, inviteeId }) {
  await env.DB.prepare(
    `INSERT INTO invites (id, inviter_id, invitee_id, bonus_given, reward_status, created_at)
     VALUES (?, ?, ?, 0, 'pending', ?)`
  ).bind(id, inviterId, inviteeId, Date.now()).run();
}

// 检查邀请人是否还有返利名额
export async function canInviterEarnMore(env, inviterId) {
  const row = await env.DB.prepare(
    'SELECT invite_reward_count FROM users WHERE id = ?'
  ).bind(inviterId).first();
  const used = (row && row.invite_reward_count) || 0;
  return used < 5;
}

// 生成成功后：查找这个用户是否有 pending 邀请记录，有就发放
export async function grantInviteRewardIfPending(env, inviteeId) {
  // 找 pending 记录
  const invite = await env.DB.prepare(
    `SELECT * FROM invites WHERE invitee_id = ? AND reward_status = 'pending' LIMIT 1`
  ).bind(inviteeId).first();

  if (!invite) return { granted: false };

  // 再次确认邀请人还有名额（防止并发时超额）
  const inviter = await env.DB.prepare(
    'SELECT invite_reward_count FROM users WHERE id = ?'
  ).bind(invite.inviter_id).first();

  if (!inviter) {
    // 邀请人不存在（被删了？），标记为 granted 但不发
    await env.DB.prepare(
      `UPDATE invites SET reward_status = 'granted', bonus_given = 0 WHERE id = ?`
    ).bind(invite.id).run();
    return { granted: false };
  }

  if ((inviter.invite_reward_count || 0) >= 5) {
    // 邀请人名额已满，标记为 granted 但不发
    await env.DB.prepare(
      `UPDATE invites SET reward_status = 'granted', bonus_given = 0 WHERE id = ?`
    ).bind(invite.id).run();
    return { granted: false, reason: 'inviter_limit_reached' };
  }

  // 发放
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET bonus_generations = bonus_generations + 2, updated_at = ? WHERE id = ?`
    ).bind(now, invite.inviter_id),
    env.DB.prepare(
      `UPDATE users SET bonus_generations = bonus_generations + 2, updated_at = ? WHERE id = ?`
    ).bind(now, inviteeId),
    env.DB.prepare(
      `UPDATE users SET invite_reward_count = invite_reward_count + 1, updated_at = ? WHERE id = ?`
    ).bind(now, invite.inviter_id),
    env.DB.prepare(
      `UPDATE invites SET reward_status = 'granted', bonus_given = 1 WHERE id = ?`
    ).bind(invite.id)
  ]);

  return { granted: true, inviterId: invite.inviter_id };
}