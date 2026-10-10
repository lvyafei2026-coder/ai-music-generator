import { updateUserPlan } from './db.js';

const PAYPAL_API = 'https://api-m.sandbox.paypal.com';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function sendOwnerNotification(env, subject, htmlBody) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'AI Music Generator <noreply@toolara.dev>',
        to: ['lvyafei2026@gmail.com'],
        subject: subject,
        html: htmlBody
      })
    });
    if (!res.ok) {
      console.error('Owner notification failed:', await res.text());
    }
  } catch (err) {
    console.error('Owner notification error:', err.message);
  }
}

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
  if (!data.access_token) throw new Error('Failed to get PayPal access token');
  return data.access_token;
}

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
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${PAYPAL_API}${endpoint}`, options);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// Plan 类型 → 环境变量名 & 用户 plan 值 & 首数限制
const PLAN_MAP = {
  'lite': { envKey: 'PAYPAL_PLAN_ID_LITE', planName: 'lite', limit: 10 },
  '1m':   { envKey: 'PAYPAL_PLAN_ID_1M',   planName: 'pro',  limit: 20 },
  '3m':   { envKey: 'PAYPAL_PLAN_ID_3M',   planName: 'pro',  limit: 20 },
  '6m':   { envKey: 'PAYPAL_PLAN_ID_6M',   planName: 'pro',  limit: 20 },
  '1y':   { envKey: 'PAYPAL_PLAN_ID_1Y',   planName: 'pro',  limit: 20 }
};

export async function handleCreateCheckout(request, env) {
  try {
    const user = await getAuthUser(request, env);
    if (!user) return json({ error: 'Not authenticated' }, 401);

    let body = {};
    try { body = await request.json(); } catch (e) {}
    const planType = (body.planType || '1y').toLowerCase();

    const cfg = PLAN_MAP[planType];
    if (!cfg) return json({ error: 'Invalid plan type.' }, 400);

    const planId = env[cfg.envKey];
    if (!planId) {
      return json({ error: 'PayPal plan not configured.' }, 500);
    }

    // custom_id 传 user.id|planType，Webhook 里解析
    const customId = user.id + '|' + planType;

    const result = await paypalRequest(env, '/v1/billing/subscriptions', 'POST', {
      plan_id: planId,
      custom_id: customId,
      application_context: {
        brand_name: 'AI Music Generator',
        locale: 'en-US',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        return_url: `${env.APP_URL}/dashboard.html?success=true`,
        cancel_url: `${env.APP_URL}/pricing.html?canceled=true`
      }
    });

    if (!result.ok) {
      console.error('PayPal create subscription error:', result.data);
      return json({ error: 'Could not create subscription.' }, 500);
    }

    const approveLink = result.data.links?.find(l => l.rel === 'approve');
    if (!approveLink) return json({ error: 'No approval link from PayPal.' }, 500);

    return json({ url: approveLink.href });
  } catch (err) {
    console.error('Checkout error:', err);
    return json({ error: 'Could not create checkout session.' }, 500);
  }
}

async function verifySubscription(env, subscriptionId) {
  const token = await getPayPalAccessToken(env);
  const res = await fetch(
    `${PAYPAL_API}/v1/billing/subscriptions/${subscriptionId}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.status === 'ACTIVE';
}

export async function handlePayPalWebhook(request, env) {
  try {
    const rawBody = await request.text();
    const headers = request.headers;

    const transmissionId = headers.get('paypal-transmission-id');
    const transmissionTime = headers.get('paypal-transmission-time');
    const transmissionSig = headers.get('paypal-transmission-sig');
    const certUrl = headers.get('paypal-cert-url');
    const authAlgo = headers.get('paypal-auth-algo');

    if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl) {
      return json({ error: 'Missing PayPal signature headers.' }, 400);
    }

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

    // ---------- 订阅激活 / 付款成功 ----------
    if (event.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED' ||
        event.event_type === 'PAYMENT.SALE.COMPLETED') {
      const resource = event.resource;

      const subscriptionId = resource.billing_agreement_id || resource.id;
      let customId = resource.custom || resource.custom_id;

      // 从订阅详情里反查 custom_id
      if (!customId && subscriptionId) {
        try {
          const token = await getPayPalAccessToken(env);
          const subRes = await fetch(
            `${PAYPAL_API}/v1/billing/subscriptions/${subscriptionId}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
          );
          const subData = await subRes.json();
          customId = subData.custom_id;
        } catch (err) {
          console.error('Failed to fetch subscription:', err);
        }
      }

      if (customId) {
        const parts = String(customId).split('|');
        const userId = parts[0];
        const planType = parts[1] || '1y';
        const cfg = PLAN_MAP[planType] || PLAN_MAP['1y'];

        await updateUserPlan(env, userId, {
          plan: cfg.planName,
          limit: cfg.limit,
          stripeCustomerId: null,
          stripeSubscriptionId: subscriptionId
        });
        console.log(`User ${userId} upgraded to ${cfg.planName} (${planType}) via ${event.event_type}`);

        await sendOwnerNotification(env,
          '🎉 New subscription: ' + cfg.planName + ' (' + planType + ')',
          '<h2>New subscription</h2>' +
          '<p><strong>User ID:</strong> ' + userId + '</p>' +
          '<p><strong>Plan:</strong> ' + cfg.planName + ' / ' + planType + '</p>' +
          '<p><strong>Limit:</strong> ' + cfg.limit + ' songs/month</p>' +
          '<p><strong>Subscription ID:</strong> ' + subscriptionId + '</p>' +
          '<p><strong>Event:</strong> ' + event.event_type + '</p>'
        );
      } else {
        console.error('No user_id found in webhook event');
      }
    }

    // ---------- 取消 / 到期 / 暂停 ----------
        // ---------- 取消订阅：只标记，不立即降级（缓冲期到 period_end） ----------
    if (event.event_type === 'BILLING.SUBSCRIPTION.CANCELLED' ||
        event.event_type === 'BILLING.SUBSCRIPTION.SUSPENDED') {
      const subscription = event.resource;
      let customId = subscription.custom_id;
      let subId = subscription.id;

      // 反查 custom_id
      if (!customId && subId) {
        try {
          const token = await getPayPalAccessToken(env);
          const subRes = await fetch(
            `${PAYPAL_API}/v1/billing/subscriptions/${subId}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
          );
          const subData = await subRes.json();
          customId = subData.custom_id;
        } catch (err) {
          console.error('Failed to fetch subscription for cancel:', err);
        }
      }

      // 拿周期结束时间（next_billing_time）
      let periodEnd = Date.now() + 30 * 24 * 60 * 60 * 1000; // 默认兜底 30 天
      if (subId) {
        try {
          const token = await getPayPalAccessToken(env);
          const subRes = await fetch(
            `${PAYPAL_API}/v1/billing/subscriptions/${subId}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
          );
          const subData = await subRes.json();
          const nextTime = subData?.billing_info?.next_billing_time;
          if (nextTime) periodEnd = new Date(nextTime).getTime();
        } catch (err) {
          console.error('Failed to fetch next_billing_time:', err);
        }
      }

      if (customId) {
        const userId = String(customId).split('|')[0];
        await env.DB.prepare(
          `UPDATE users SET cancel_at_period_end = 1, current_period_end = ?, updated_at = ? WHERE id = ?`
        ).bind(periodEnd, Date.now(), userId).run();
        console.log(`User ${userId} marked cancel_at_period_end, period ends at ${new Date(periodEnd).toISOString()}`);

        await sendOwnerNotification(env,
          '⚠️ Subscription canceled: ' + userId,
          '<h2>Subscription canceled</h2>' +
          '<p><strong>User ID:</strong> ' + userId + '</p>' +
          '<p><strong>Access ends at:</strong> ' + new Date(periodEnd).toISOString() + '</p>' +
          '<p><strong>Event:</strong> ' + event.event_type + '</p>'
        );
      }
    }

    // ---------- 订阅彻底过期：立即降级 ----------
    if (event.event_type === 'BILLING.SUBSCRIPTION.EXPIRED') {
      const subscription = event.resource;
      let customId = subscription.custom_id;

      if (!customId && subscription.id) {
        try {
          const token = await getPayPalAccessToken(env);
          const subRes = await fetch(
            `${PAYPAL_API}/v1/billing/subscriptions/${subscription.id}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
          );
          const subData = await subRes.json();
          customId = subData.custom_id;
        } catch (err) {
          console.error('Failed to fetch subscription for expire:', err);
        }
      }

      if (customId) {
        const userId = String(customId).split('|')[0];
        await updateUserPlan(env, userId, {
          plan: 'free',
          limit: 3,
          stripeCustomerId: null,
          stripeSubscriptionId: null
        });
        console.log(`User ${userId} downgraded to Free (subscription expired)`);
      }
    }

    return json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return json({ error: 'Webhook processing failed.' }, 400);
  }
}

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