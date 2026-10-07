import { findUserById, updateUserPlan } from './db.js';

// PayPal API 基础地址（沙箱环境）
const PAYPAL_API = 'https://api-m.sandbox.paypal.com';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// ---------- OAuth 获取 Access Token ----------
async function getPayPalAccessToken(env) {
  const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Failed to get PayPal access token');
  }
  return data.access_token;
}

// ---------- 通用 PayPal API 请求 ----------
async function paypalRequest(env, endpoint, method = 'GET', body = null) {
  const token = await getPayPalAccessToken(env);
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': crypto.randomUUID()
    }
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${PAYPAL_API}${endpoint}`, options);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// ---------- 创建 Checkout Session ----------
export async function handleCreateCheckout(request, env) {
  try {
    const user = await getAuthUser(request, env);
    if (!user) return json({ error: 'Not authenticated' }, 401);

    // 使用你在 PayPal 后台创建好的 Plan ID
    const planId = env.PAYPAL_PLAN_ID_PRO;
    if (!planId) {
      return json({ error: 'PayPal plan not configured.' }, 500);
    }

    // 创建订阅
    const result = await paypalRequest(env, '/v1/billing/subscriptions', 'POST', {
      plan_id: planId,
      custom_id: user.id,  // 用你的用户 ID 关联订阅
      application_context: {
        brand_name: 'AI Music Generator',
        locale: 'en-US',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        return_url: `${env.APP_URL}/dashboard?success=true`,
        cancel_url: `${env.APP_URL}/pricing?canceled=true`
      }
    });

    if (!result.ok) {
      console.error('PayPal create subscription error:', result.data);
      return json({ error: 'Could not create subscription.' }, 500);
    }

    // 找到 approve 链接
    const approveLink = result.data.links?.find(l => l.rel === 'approve');
    if (!approveLink) {
      return json({ error: 'No approval link from PayPal.' }, 500);
    }

    return json({ url: approveLink.href });
  } catch (err) {
    console.error('Checkout error:', err);
    return json({ error: 'Could not create checkout session.' }, 500);
  }
}

// ---------- 处理 PayPal Webhook ----------
export async function handlePayPalWebhook(request, env) {
  try {
    const rawBody = await request.text();
    const headers = request.headers;

    // 收集验证所需字段
    const transmissionId = headers.get('paypal-transmission-id');
    const transmissionTime = headers.get('paypal-transmission-time');
    const transmissionSig = headers.get('paypal-transmission-sig');
    const certUrl = headers.get('paypal-cert-url');
    const authAlgo = headers.get('paypal-auth-algo');

    if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl) {
      return json({ error: 'Missing PayPal signature headers.' }, 400);
    }

    // 调用 PayPal 的 verify-webhook-signature 端点进行验证
    const verifyResult = await paypalRequest(env, '/v1/notifications/verify-webhook-signature', 'POST', {
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: JSON.parse(rawBody)
    });

    if (!verifyResult.ok || verifyResult.data.verification_status !== 'SUCCESS') {
      console.error('Webhook verification failed:', verifyResult.data);
      return json({ error: 'Invalid signature.' }, 401);
    }

    const event = JSON.parse(rawBody);
    console.log('PayPal webhook event:', event.event_type);

    // 处理订阅相关事件
    if (event.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED' || 
        event.event_type === 'BILLING.SUBSCRIPTION.CREATED') {
      const subscription = event.resource;
      const userId = subscription.custom_id;

      if (userId) {
        await updateUserPlan(env, userId, {
          plan: 'pro',
          limit: 100,
          stripeCustomerId: null,
          stripeSubscriptionId: subscription.id
        });
        console.log(`User ${userId} upgraded to Pro`);
      }
    }

    if (event.event_type === 'BILLING.SUBSCRIPTION.CANCELLED' ||
        event.event_type === 'BILLING.SUBSCRIPTION.EXPIRED' ||
        event.event_type === 'BILLING.SUBSCRIPTION.SUSPENDED') {
      const subscription = event.resource;
      const userId = subscription.custom_id;

      if (userId) {
        await updateUserPlan(env, userId, {
          plan: 'free',
          limit: 3,
          stripeCustomerId: null,
          stripeSubscriptionId: null
        });
        console.log(`User ${userId} downgraded to Free`);
      }
    }

    return json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return json({ error: 'Webhook processing failed.' }, 400);
  }
}

// ---------- 获取认证用户（简化版，避免循环依赖）----------
async function getAuthUser(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/session_id=([^;]+)/);
  if (!match) return null;

  const session = await env.DB.prepare(
    'SELECT * FROM sessions WHERE id = ? AND expires_at > ?'
  ).bind(match[1], Date.now()).first();
  if (!session) return null;

  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
}