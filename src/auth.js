import { findUserByEmail, findUserById, createUser, createSession, findSession, deleteSession } from './db.js';

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

    const user = await createUser(env, { id: userId, email, passwordHash });

    // 自动登录
    const sessionId = generateId('ses');
    const expiresAt = Date.now() + SESSION_TTL;
    await createSession(env, { id: sessionId, userId, expiresAt });

    const headers = new Headers();
    setCookie(headers, SESSION_COOKIE, sessionId, SESSION_TTL / 1000);

    return new Response(JSON.stringify({
      success: true,
      user: { id: user.id, email: user.email, plan: user.plan }
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json', ...Object.fromEntries(headers) }
    });
  } catch (err) {
    console.error('Signup error:', err);
    return json({ error: 'Registration failed. Please try again.' }, 500);
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

    const [storedHash, salt] = user.password_hash.split(':');
    const inputHash = await hashPassword(password, salt);
    if (inputHash !== storedHash) {
      return json({ error: 'Invalid email or password.' }, 401);
    }

    const sessionId = generateId('ses');
    const expiresAt = Date.now() + SESSION_TTL;
    await createSession(env, { id: sessionId, userId: user.id, expiresAt });

    const headers = new Headers();
    setCookie(headers, SESSION_COOKIE, sessionId, SESSION_TTL / 1000);

    return new Response(JSON.stringify({
      success: true,
      user: { id: user.id, email: user.email, plan: user.plan, generations_used: user.generations_used, generations_limit: user.generations_limit }
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