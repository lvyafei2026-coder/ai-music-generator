import { handleSignup, handleLogin, handleLogout, handleMe, handleVerifyEmail, handleResendVerification, getCurrentUser } from './auth.js';
import { handleCreateCheckout, handlePayPalWebhook } from './billing.js';
import { createMusicTask, getMusicTask, listUserTasks, incrementUsage, getInviteStats } from './db.js';
import queueConsumer from './queue-consumer.js';
import { handleLyrics } from './lyrics.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');

    // API 路由
    if (path.includes('/api/')) {
      return handleApi(request, env, url);
    }

    // 公开分享页：/share/:id 或 /share/:id/ 都重写到 /share.html
    const shareMatch = path.match(/^\/share\/[^/]+\/?$/);
    if (shareMatch) {
      const newUrl = new URL(request.url);
      newUrl.pathname = '/share.html';
      return env.ASSETS.fetch(new Request(newUrl, request));
    }

    // 内部重写：无扩展名的页面路径 → .html 文件
    const pageRoutes = ['/dashboard', '/login', '/pricing', '/index', '/verify-email', '/enterprise'];
    const lastSegment = path.split('/').pop();
    
    if (pageRoutes.includes('/' + lastSegment)) {
      const newUrl = new URL(request.url);
      newUrl.pathname = path + '.html';
      return env.ASSETS.fetch(new Request(newUrl, request));
    }
    
    // 静态资源
    return env.ASSETS.fetch(request);
  },

  async queue(batch, env, ctx) {
    return queueConsumer.queue(batch, env, ctx);
  }
};

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/$/, '');
  const method = request.method;

  // ==================== 认证相关 ====================
  if (path.endsWith('/api/auth/signup') && method === 'POST') {
    return handleSignup(request, env);
  }
  if (path.endsWith('/api/auth/login') && method === 'POST') {
    return handleLogin(request, env);
  }
  if (path.endsWith('/api/auth/logout') && method === 'POST') {
    return handleLogout(request, env);
  }
  if (path.endsWith('/api/auth/me') && method === 'GET') {
    return handleMe(request, env);
  }
  if (path.endsWith('/api/auth/verify-email') && method === 'GET') {
    return handleVerifyEmail(request, env, url);
  }
  if (path.endsWith('/api/auth/resend-verification') && method === 'POST') {
    return handleResendVerification(request, env);
  }

  // ==================== 支付相关（PayPal 沙箱） ====================
  if (path.endsWith('/api/billing/checkout') && method === 'POST') {
    return handleCreateCheckout(request, env);
  }
  if (path.endsWith('/api/billing/webhook') && method === 'POST') {
    return handlePayPalWebhook(request, env);
  }

  // ==================== 公开分享 ====================
  if (path.includes('/api/share/audio/') && method === 'GET') {
    return handleShareAudio(request, env, url);
  }
  if (path.includes('/api/share/') && method === 'GET') {
    return handleShareGet(request, env, url);
  }

  // ==================== AI 歌词 ====================
  if (path.endsWith('/api/lyrics') && method === 'POST') {
    return handleLyrics(request, env);
  }

  // ==================== 音乐生成相关 ====================
  if (path.endsWith('/api/generate') && method === 'POST') {
    return handleGenerate(request, env);
  }
  if (path.includes('/api/task/') && method === 'GET') {
    return handleGetTask(request, env, url);
  }
  if (path.endsWith('/api/tasks') && method === 'GET') {
    return handleListTasks(request, env);
  }
  if (path.includes('/api/audio/') && method === 'GET') {
    return handleGetAudio(request, env, url);
  }

  return json({ error: 'Not found' }, 404);
}

// ==================== 音乐生成 ====================
async function handleGenerate(request, env) {
  console.log('[Generate] Request received');
  try {
    const user = await getCurrentUser(request, env);
    if (!user) {
      console.log('[Generate] Not authenticated');
      return json({ error: 'Please sign in first.' }, 401);
    }
    console.log('[Generate] User authenticated:', user.id);

    // 检查用量
    const bonus = user.bonus_generations || 0;
    const totalLimit = (user.generations_limit || 0) + bonus;
    if (user.generations_used >= totalLimit) {
      return json({
        error: 'You have reached your generation limit. Upgrade to Pro for more.',
        code: 'LIMIT_REACHED',
        used: user.generations_used,
        limit: totalLimit
      }, 403);
    }

    // 频率限制
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.AI_RATE_LIMITER.limit({ key: 'music:' + ip });
    if (!success) {
      console.log('[Generate] Rate limited:', ip);
      return json({ error: 'Too many requests. Please wait a minute.' }, 429);
    }

    const body = await request.json();
    const prompt = (body.prompt || '').trim();
    const lyrics = (body.lyrics || '').trim();
    const isInstrumental = !!body.isInstrumental;
    const rawDuration = parseInt(body.audioDuration, 10) || 120;
    const isPro = user.plan === 'pro';
    const maxDuration = isPro ? 120 : 60;
    if (rawDuration > maxDuration) {
      return json({
        error: isPro
          ? 'Maximum duration is 120 seconds.'
          : 'Free plan allows up to 60 seconds. Upgrade for up to 120 seconds.',
        code: 'DURATION_LIMIT',
        maxAllowed: maxDuration
      }, 403);
    }
    const audioDuration = Math.min(Math.max(rawDuration, 10), maxDuration);

    console.log('[Generate] Payload:', { promptLength: prompt.length, hasLyrics: !!lyrics, isInstrumental });

    if (!prompt || prompt.length < 5) {
      console.log('[Generate] Prompt too short');
      return json({ error: 'Please describe the music you want (at least 5 characters).' }, 400);
    }
    if (prompt.length > 500) {
      console.log('[Generate] Prompt too long');
      return json({ error: 'Description must be under 500 characters.' }, 400);
    }

    const taskId = crypto.randomUUID();
    console.log('[Generate] Creating task:', taskId);

    await createMusicTask(env, { id: taskId, userId: user.id, prompt, lyrics, isInstrumental, audioDuration });
    console.log('[Generate] Task created in D1');

    await incrementUsage(env, user.id);
    console.log('[Generate] Usage incremented');

    // 推入 Queue
    console.log('[Generate] Sending to Queue...');
    await env.MUSIC_QUEUE.send({
      taskId,
      userId: user.id,
      prompt,
      lyrics,
      isInstrumental,
      audioDuration
    });
    console.log('[Generate] Queue send completed:', taskId);

    return json({ taskId, status: 'pending' });
  } catch (err) {
    console.error('[Generate] Fatal error:', {
      message: err.message,
      name: err.name,
      stack: err.stack
    });
    return json({ error: 'Could not start generation. Please try again.', detail: err.message }, 500);
  }
}

async function handleGetTask(request, env, url) {
  try {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: 'Not authenticated' }, 401);

    const taskId = url.pathname.split('/').pop();
    const task = await getMusicTask(env, taskId, user.id);
    if (!task) return json({ error: 'Task not found' }, 404);

    if (task.status === 'completed' && task.audio_key) {
      return json({
        taskId: task.id,
        status: task.status,
        audioUrl: `/music/api/audio/${task.audio_key}`,
        prompt: task.prompt
      });
    }

    return json({
      taskId: task.id,
      status: task.status,
      error: task.error || null
    });
  } catch (err) {
    console.error('Get task error:', err);
    return json({ error: 'Could not load task.' }, 500);
  }
}

async function handleListTasks(request, env) {
  try {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: 'Not authenticated' }, 401);

    const tasks = await listUserTasks(env, user.id);
    return json({
      tasks: tasks.map(t => ({
        id: t.id,
        prompt: t.prompt,
        lyrics: t.lyrics || null,
        isInstrumental: t.is_instrumental === 1,
        duration: t.audio_duration || null,
        status: t.status,
        audioUrl: t.audio_key && t.status === 'completed' ? `/music/api/audio/${t.audio_key}` : null,
        error: t.error || null,
        createdAt: t.created_at
      }))
    });
  } catch (err) {
    console.error('List tasks error:', {
      message: err.message,
      code: err.code,
      name: err.name,
      stack: err.stack
    });
    return json({ error: 'Could not load tasks.', detail: err.message }, 500);
  }
}

async function handleGetAudio(request, env, url) {
  try {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: 'Not authenticated' }, 401);

    const key = url.pathname.split('/api/audio/')[1];
    if (!key) return json({ error: 'Invalid audio key' }, 400);

    const task = await env.DB.prepare(
      'SELECT * FROM music_tasks WHERE audio_key = ? AND user_id = ?'
    ).bind(key, user.id).first();
    if (!task) return json({ error: 'Audio not found' }, 404);

    const object = await env.AUDIO.get(key);
    if (!object) return json({ error: 'Audio file not found' }, 404);

    return new Response(object.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'private, max-age=3600'
      }
    });
  } catch (err) {
    console.error('Get audio error:', err);
    return json({ error: 'Could not load audio.' }, 500);
  }
}

// ==================== 公开分享 ====================
async function handleShareGet(request, env, url) {
  try {
    const taskId = url.pathname.split('/').pop();
    if (!taskId) return json({ error: 'Missing task id' }, 400);

    const task = await env.DB.prepare(
      'SELECT * FROM music_tasks WHERE id = ?'
    ).bind(taskId).first();

    if (!task) return json({ error: 'Not found' }, 404);
    if (task.status !== 'completed' || !task.audio_key) {
      return json({ error: 'This song is not ready yet' }, 404);
    }

    return json({
      id: task.id,
      prompt: task.prompt || '',
      lyrics: task.lyrics || null,
      isInstrumental: task.is_instrumental === 1,
      duration: task.audio_duration || null,
      audioUrl: '/music/api/share/audio/' + task.audio_key,
      createdAt: task.created_at
    });
  } catch (err) {
    console.error('Share get error:', err);
    return json({ error: 'Could not load song.' }, 500);
  }
}

async function handleShareAudio(request, env, url) {
  try {
    const key = url.pathname.split('/api/share/audio/')[1];
    if (!key) return json({ error: 'Invalid audio key' }, 400);

    // 只放行在 music_tasks 里存在、且已完成的任务
    const task = await env.DB.prepare(
      'SELECT * FROM music_tasks WHERE audio_key = ? AND status = ?'
    ).bind(key, 'completed').first();
    if (!task) return json({ error: 'Audio not found' }, 404);

    const object = await env.AUDIO.get(key);
    if (!object) return json({ error: 'Audio file not found' }, 404);

    return new Response(object.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=86400'
      }
    });
  } catch (err) {
    console.error('Share audio error:', err);
    return json({ error: 'Could not load audio.' }, 500);
  }
}
