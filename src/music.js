import { WorkflowEntrypoint } from 'cloudflare:workers';

export class MusicGenerationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { taskId, userId, prompt, lyrics, isInstrumental } = event.payload;

    // Step 1: 更新状态为 generating
    await step.do('mark-generating', async () => {
      await this.env.DB.prepare(
        `UPDATE music_tasks SET status = 'generating', updated_at = ? WHERE id = ?`
      ).bind(Date.now(), taskId).run();
    });

    // Step 2: 调用 MiniMax Music 2.6
    const audioResult = await step.do('generate-music',{
        retries: {
          limit: 0,           // 最多重试 0 次（总共执行 1 次）
          delay: '10 seconds', // 重试前等待 10 秒
          backoff: 'linear'    // 固定间隔，不指数增长
        }
      }, async () => {
      const response = await this.env.AI.run(
        'minimax/music-2.6',
        {
          prompt: prompt,
          is_instrumental: isInstrumental,
          lyrics: lyrics || undefined,
          lyrics_optimizer: !lyrics,
        },
        {
          gateway: {
            id: this.env.AI_GATEWAY_ID,
            skipCache: false,
            cacheTtl: 3600,
          }
        }
      );
      return response;
    });

    // Step 3: 下载音频并存入 R2
    const audioKey = await step.do('store-audio', async () => {
      const audioUrl = audioResult.audio_url || audioResult.url || audioResult.audio;
      if (!audioUrl) {
        throw new Error('No audio URL in response');
      }
      
      const audioRes = await fetch(audioUrl);
      const audioBuffer = await audioRes.arrayBuffer();
      const key = `music/${userId}/${taskId}.mp3`;
      
      await this.env.AUDIO.put(key, audioBuffer, {
        httpMetadata: { contentType: 'audio/mpeg' }
      });
      
      return key;
    });

    // Step 4: 更新任务状态为 completed
    await step.do('mark-completed', async () => {
      await this.env.DB.prepare(
        `UPDATE music_tasks SET status = 'completed', audio_key = ?, updated_at = ? WHERE id = ?`
      ).bind(audioKey, Date.now(), taskId).run();
    });

    return { taskId, audioKey };
  }
}