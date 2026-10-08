import { WorkflowEntrypoint } from 'cloudflare:workers';
import { updateTaskRunId } from './db.js';

export class MusicGenerationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { taskId, userId, prompt, lyrics, isInstrumental } = event.payload;

    // Step 1: 标记为 generating
    await step.do('mark-generating', async () => {
      await this.env.DB.prepare(
        `UPDATE music_tasks SET status = 'generating', updated_at = ? WHERE id = ?`
      ).bind(Date.now(), taskId).run();
    });

    // Step 2: 发起后台生成请求，立即返回 run_id
    const runId = await step.do('start-music-task', {
      retries: { limit: 0 }
    }, async () => {
      const gatewayUrl = `https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/ai/run/@cf/minimax/music-2.6`;

      const response = await fetch(gatewayUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.CF_AIG_TOKEN}`,
          'Content-Type': 'application/json',
          'cf-aig-gateway-id': this.env.AI_GATEWAY_ID
        },
        body: JSON.stringify({
          prompt: prompt,
          lyrics: lyrics || undefined,
          is_instrumental: isInstrumental,
          lyrics_optimizer: !lyrics,
          background: true,
          webhookUrl: `${this.env.APP_URL}/api/music-webhook`
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(`AI Gateway error ${response.status}: ${JSON.stringify(data)}`);
      }

      const id = data.result?.id || data.id;
      if (!id) {
        throw new Error('No run_id in response: ' + JSON.stringify(data).slice(0, 500));
      }

      return id;
    });

    // Step 3: 把 run_id 写回数据库
    await step.do('save-run-id', async () => {
      await updateTaskRunId(this.env, taskId, runId);
    });

    // 注意：这里不再等待生成结果。生成完成后，AI Gateway 会回调
    // `/api/music-webhook`，由 index.js 里的 handleMusicWebhook 处理。

    return { taskId, runId };
  }
}