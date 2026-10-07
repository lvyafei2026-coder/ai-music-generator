import { findUserById, updateUserPlan } from './db.js';

const STRIPE_API = 'https://api.stripe.com/v1';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function stripeRequest(env, endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };
  if (body) {
    options.body = new URLSearchParams(body).toString();
  }
  const res = await fetch(`${STRIPE_API}${endpoint}`, options);
  return res.json();
}

// 创建 Stripe 客户
export async function createStripeCustomer(env, user) {
  const customer = await stripeRequest(env, '/customers', 'POST', {
    email: user.email,
    'metadata[user_id]': user.id
  });
  return customer;
}

// 创建 Checkout Session
export async function handleCreateCheckout(request, env) {
  try {
    const user = await getAuthUser(request, env);
    if (!user) return json({ error: 'Not authenticated' }, 401);

    const body = await request.json();
    const priceId = body.priceId;

    if (!priceId) return json({ error: 'Price ID required' }, 400);

    // 确保有 Stripe 客户
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await createStripeCustomer(env, user);
      customerId = customer.id;
      await env.DB.prepare(
        'UPDATE users SET stripe_customer_id = ? WHERE id = ?'
      ).bind(customerId, user.id).run();
    }

    const session = await stripeRequest(env, '/checkout/sessions', 'POST', {
      customer: customerId,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': 1,
      mode: 'subscription',
      success_url: `${env.APP_URL}/dashboard?success=true`,
      cancel_url: `${env.APP_URL}/pricing?canceled=true`
    });

    return json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    return json({ error: 'Could not create checkout session.' }, 500);
  }
}

// 处理 Stripe Webhook
export async function handleStripeWebhook(request, env) {
  try {
    const body = await request.text();
    const signature = request.headers.get('stripe-signature');

    // 验证签名（简化版，生产环境建议用 Stripe SDK 验证）
    // 这里仅做演示，实际应使用 stripe.webhooks.constructEvent

    const event = JSON.parse(body);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const customerId = session.customer;
      const subscriptionId = session.subscription;

      // 根据 customer_id 找到用户
      const user = await env.DB.prepare(
        'SELECT * FROM users WHERE stripe_customer_id = ?'
      ).bind(customerId).first();

      if (user) {
        await updateUserPlan(env, user.id, {
          plan: 'pro',
          limit: 100, // Pro 计划每月 100 首
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId
        });
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const user = await env.DB.prepare(
        'SELECT * FROM users WHERE stripe_customer_id = ?'
      ).bind(customerId).first();

      if (user) {
        await updateUserPlan(env, user.id, {
          plan: 'free',
          limit: 3,
          stripeCustomerId: customerId,
          stripeSubscriptionId: null
        });
      }
    }

    return json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return json({ error: 'Webhook processing failed.' }, 400);
  }
}

// 获取认证用户（从 auth.js 导入会有循环依赖，这里复制一份简化版）
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