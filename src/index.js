import { handleSignup, handleLogin, handleLogout, handleMe, handleVerifyEmail, handleResendVerification, getCurrentUser } from './auth.js';
import { handleCreateCheckout, handlePayPalWebhook } from './billing.js';
import { MusicGenerationWorkflow } from './music.js';
import { createMusicTask, getMusicTask, listUserTasks, incrementUsage } from './db.js';

export { MusicGenerationWorkflow };

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

    // 内部重写：无扩展名的页面路径 → .html 文件
    const pageRoutes = ['/dashboard', '/login', '/pricing', '/index', '/verify-email'];
    const lastSegment = path.split('/').pop();
    
    if (pageRoutes.includes('/' + lastSegment)) {
      const newUrl = new URL(request.url);
      newUrl.pathname = path + '.html';
      return env.ASSETS.fetch(new Request(newUrl, request));
    }
    
    // 静态资源
    return env.ASSETS.fetch(request);
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
  if (path.endsWith('/api/music-webhook') && method === 'POST') {
    return handleMusicWebhook(request, env);
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
  try {
    const user = await getCurrentUser(request, env);
    if (!user) {
      return json({ error: 'Please sign in first.' }, 401);
    }

    // 检查用量
    if (user.generations_used >= user.generations_limit) {
      return json({
        error: 'You have reached your generation limit. Upgrade to Pro for more.',
        code: 'LIMIT_REACHED',
        used: user.generations_used,
        limit: user.generations_limit
      }, 403);
    }

    // 频率限制
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.AI_RATE_LIMITER.limit({ key: 'music:' + ip });
    if (!success) {
      return json({ error: 'Too many requests. Please wait a minute.' }, 429);
    }

    const body = await request.json();
    const prompt = (body.prompt || '').trim();
    const lyrics = (body.lyrics || '').trim();
    const isInstrumental = !!body.isInstrumental;

    if (!prompt || prompt.length < 5) {
      return json({ error: 'Please describe the music you want (at least 5 characters).' }, 400);
    }
    if (prompt.length > 500) {
      return json({ error: 'Description must be under 500 characters.' }, 400);
    }

    const taskId = crypto.randomUUID();

    await createMusicTask(env, { id: taskId, userId: user.id, prompt, lyrics, isInstrumental });
    await incrementUsage(env, user.id);

    // 触发 Workflow
    await env.MUSIC_WORKFLOW.create({
      id: taskId,
      params: {
        taskId,
        userId: user.id,
        prompt,
        lyrics,
        isInstrumental
      }
    });

    return json({ taskId, status: 'pending' });
  } catch (err) {
    console.error('Generate error:', err);
    return json({ error: 'Could not start generation. Please try again.' }, 500);
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
        audioUrl: `/api/audio/${task.audio_key}`,
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
        status: t.status,
        audioUrl: t.audio_key && t.status === 'completed' ? `/api/audio/${t.audio_key}` : null,
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

async function handleMusicWebhook(request, env) {
  try {
    const body = await request.json();
    console.log('Music webhook received:', JSON.stringify(body).slice(0, 500));

    const runId = body.id || body.run_id;
    if (!runId) {
      console.error('No run_id in webhook body');
      return json({ received: true });
    }

    // 找到对应的任务
    const task = await env.DB.prepare(
      'SELECT * FROM music_tasks WHERE run_id = ?'
    ).bind(runId).first();

    if (!task) {
      console.error('No task found for runId:', runId);
      return json({ received: true });
    }

    // 提取音频数据
    const audioHex = body.result?.audio || body.audio;
    if (!audioHex) {
      console.error('No audio data in webhook:', JSON.stringify(body).slice(0, 500));
      await env.DB.prepare(
        `UPDATE music_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`
      ).bind('No audio data in webhook', Date.now(), task.id).run();
      return json({ received: true });
    }

    // 将 hex 字符串转为二进制
    const len = audioHex.length;
    const bytes = new Uint8Array(len / 2);
    for (let i = 0; i < len; i += 2) {
      bytes[i / 2] = parseInt(audioHex.substr(i, 2), 16);
    }

    // 存入 R2
    const key = `music/${task.user_id}/${task.id}.mp3`;
    await env.AUDIO.put(key, bytes, {
      httpMetadata: { contentType: 'audio/mpeg' }
    });

    // 更新任务状态为完成
    await env.DB.prepare(
      `UPDATE music_tasks SET status = 'completed', audio_key = ?, updated_at = ? WHERE id = ?`
    ).bind(key, Date.now(), task.id).run();

    console.log('Music task completed:', task.id);
    return json({ received: true });
  } catch (err) {
    console.error('Music webhook error:', err);
    return json({ error: 'Webhook processing failed' }, 500);
  }
}