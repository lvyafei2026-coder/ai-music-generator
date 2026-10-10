import { findUserByEmail, findUserById, createUser, createSession, findSession, deleteSession, findUserByInviteCode, createInvite, addBonusGenerations } from './db.js';

const SESSION_COOKIE = 'session_id';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天

// 密码哈希（使用 Web Crypto API）
async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateSalt() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateId(prefix) {
  const array = new Uint8Array(12);
  crypto.getRandomValues(array);
  return prefix + '_' + Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function setCookie(headers, name, value, maxAge) {
  headers.append('Set-Cookie',
    `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
  );
}

// 新增：发送验证邮件
async function sendVerificationEmail(env, email, token) {
  const verifyUrl = `${env.APP_URL}/verify-email?token=${token}`;
  
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'AI Music Generator <noreply@toolara.dev>',
      to: [email],
      subject: 'Verify your email address',
      html: `
        <h2>Welcome to AI Music Generator!</h2>
        <p>Please click the link below to verify your email address:</p>
        <a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#0f766e;color:#fff;text-decoration:none;border-radius:8px;">Verify Email</a>
        <p>This link expires in 1 hour.</p>
      `
    })
  });
  
  if (!res.ok) {
    const error = await res.text();
    console.error('Resend error:', error);
    throw new Error('Failed to send verification email');
  }
}

// 注册
export async function handleSignup(request, env) {
  try {
    const body = await request.json();
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';

    if (!email || !email.includes('@')) {
      return json({ error: 'Please enter a valid email.' }, 400);
    }
    if (password.length < 8) {
      return json({ error: 'Password must be at least 8 characters.' }, 400);
    }

    const existing = await findUserByEmail(env, email);
    if (existing) {
      return json({ error: 'An account with this email already exists.' }, 409);
    }

    const salt = generateSalt();
    const passwordHash = await hashPassword(password, salt) + ':' + salt;
    const userId = generateId('usr');

    // 创建用户（email_verified 默认为 0）
    const user = await createUser(env, { id: userId, email, passwordHash });

    // 生成验证令牌（1小时有效期）
    const token = crypto.randomUUID();
    const expiresAt = Date.now() + 3600 * 1000;
    await env.DB.prepare(
      'INSERT INTO email_verification_tokens (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).bind(token, userId, expiresAt, Date.now()).run();

    // 发送验证邮件
    await sendVerificationEmail(env, email, token);

    // 处理邀请返利（仅当 refCode 有效）
    if (refCode) {
      try {
        const inviter = await findUserByInviteCode(env, refCode);
        if (inviter && inviter.id !== userId) {
          await createInvite(env, {
            id: generateId('inv'),
            inviterId: inviter.id,
            inviteeId: userId
          });
          // 双方各 +2
          await addBonusGenerations(env, inviter.id, 2);
          await addBonusGenerations(env, userId, 2);
          console.log('[Signup] Invite bonus applied:', inviter.id, '<-', userId);
        }
      } catch (e) {
        console.error('[Signup] Invite processing failed:', e.message);
      }
    }

    // 不直接登录，返回提示信息
    return json({
      success: true,
      message: 'Account created. Please check your email to verify your account.',
      requiresVerification: true
    }, 201);
  } catch (err) {
    console.error('Signup error:', err);
    return json({ error: 'Registration failed. Please try again.' }, 500);
  }
}

// 新增：验证邮箱
export async function handleVerifyEmail(request, env, url) {
  try {
    const token = url.searchParams.get('token');
    if (!token) {
      return json({ error: 'Missing verification token.' }, 400);
    }

    // 查找令牌
    const tokenRecord = await env.DB.prepare(
      'SELECT * FROM email_verification_tokens WHERE token = ? AND expires_at > ? AND used_at IS NULL'
    ).bind(token, Date.now()).first();

    if (!tokenRecord) {
      return json({ error: 'Invalid or expired verification link.' }, 400);
    }

    // 标记用户为已验证
    await env.DB.prepare(
      'UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?'
    ).bind(Date.now(), tokenRecord.user_id).run();

    // 标记令牌为已使用
    await env.DB.prepare(
      'UPDATE email_verification_tokens SET used_at = ? WHERE token = ?'
    ).bind(Date.now(), token).run();

    return json({ success: true, message: 'Email verified successfully.' });
  } catch (err) {
    console.error('Verify email error:', err);
    return json({ error: 'Verification failed. Please try again.' }, 500);
  }
}

// 登录
export async function handleLogin(request, env) {
  try {
    const body = await request.json();
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';

    if (!email || !password) {
      return json({ error: 'Email and password are required.' }, 400);
    }

    const user = await findUserByEmail(env, email);
    if (!user) {
      return json({ error: 'Invalid email or password.' }, 401);
    }

    // 校验密码
    const [storedHash, salt] = user.password_hash.split(':');
    const inputHash = await hashPassword(password, salt);
    if (inputHash !== storedHash) {
      return json({ error: 'Invalid email or password.' }, 401);
    }

    // 校验邮箱验证状态
    if (!user.email_verified) {
      return json({
        error: 'Please verify your email before signing in. Check your inbox for the verification link.',
        code: 'EMAIL_NOT_VERIFIED'
      }, 403);
    }

    const sessionId = generateId('ses');
    const expiresAt = Date.now() + SESSION_TTL;
    await createSession(env, { id: sessionId, userId: user.id, expiresAt });

    const headers = new Headers();
    setCookie(headers, SESSION_COOKIE, sessionId, SESSION_TTL / 1000);

    return new Response(JSON.stringify({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        generations_used: user.generations_used,
        generations_limit: user.generations_limit
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...Object.fromEntries(headers) }
    });
  } catch (err) {
    console.error('Login error:', err);
    return json({ error: 'Login failed. Please try again.' }, 500);
  }
}

// 登出
export async function handleLogout(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (match) {
    await deleteSession(env, match[1]);
  }
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
    }
  });
}

// 获取当前用户
export async function getCurrentUser(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;

  const session = await findSession(env, match[1]);
  if (!session) return null;

  const user = await findUserById(env, session.user_id);
  return user || null;
}

export async function handleMe(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) {
    return json({ error: 'Not authenticated' }, 401);
  }
  return json({
    user: {
      id: user.id,
      email: user.email,
      plan: user.plan,
      generations_used: user.generations_used,
      generations_limit: user.generations_limit
    }
  });
}

export async function handleResendVerification(request, env) {
  try {
    const body = await request.json();
    const email = (body.email || '').trim().toLowerCase();

    const user = await findUserByEmail(env, email);
    if (!user || user.email_verified) {
      return json({ message: 'If this email exists and is unverified, a new link has been sent.' });
    }

    const token = crypto.randomUUID();
    const expiresAt = Date.now() + 3600 * 1000;
    await env.DB.prepare(
      'INSERT INTO email_verification_tokens (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).bind(token, user.id, expiresAt, Date.now()).run();

    await sendVerificationEmail(env, email, token);
    return json({ message: 'Verification email resent. Please check your inbox.' });
  } catch (err) {
    console.error('Resend verification error:', err);
    return json({ error: 'Could not resend verification email.' }, 500);
  }
}