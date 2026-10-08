import { WorkflowEntrypoint } from 'cloudflare:workers';

const REPLICATE_API = 'https://api.replicate.com/v1';
const MODEL_VERSION = 'minimax/music-2.6'; // 使用模型名称

export class MusicGenerationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { taskId, userId, prompt, lyrics, isInstrumental } = event.payload;

    // Step 1: 标记为 generating
    await step.do('mark-generating', async () => {
      await this.env.DB.prepare(
        `UPDATE music_tasks SET status = 'generating', updated_at = ? WHERE id = ?`
      ).bind(Date.now(), taskId).run();
    });

    // Step 2: 创建 Replicate Prediction（短请求，立即返回 prediction ID）
    const predictionId = await step.do('create-prediction', {
      retries: { limit: 0 },
      timeout: '30 seconds'
    }, async () => {
      const input = {
        prompt: prompt,
        is_instrumental: isInstrumental,
        lyrics_optimizer: !lyrics
      };
      if (lyrics && lyrics.trim()) {
        input.lyrics = lyrics;
      }

      const response = await fetch(`${REPLICATE_API}/models/${MODEL_VERSION}/predictions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.REPLICATE_API_TOKEN}`,
          'Content-Type': 'application/json',
          'Prefer': 'wait=3' // 最多等待 3 秒，超时则返回 prediction ID
        },
        body: JSON.stringify({ input })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(`Replicate error: ${JSON.stringify(data).slice(0, 300)}`);
      }

      // 如果 3 秒内已完成，直接返回结果；否则返回 prediction ID 用于轮询
      if (data.status === 'succeeded' && data.output) {
        return { done: true, output: data.output };
      }
      return { done: false, predictionId: data.id };
    });

    // 如果创建时已经完成，直接进入存储步骤
    let audioUrl = null;
    if (predictionId.done) {
      audioUrl = Array.isArray(predictionId.output) ? predictionId.output[0] : predictionId.output;
    } else {
      // Step 3: 轮询直到完成（每次都是短 GET）
      for (let i = 0; i < 30; i++) {
        await step.sleep('wait-for-generation', '10 seconds');

        const result = await step.do(`poll-${i}`, {
          retries: { limit: 0 },
          timeout: '30 seconds'
        }, async () => {
          const res = await fetch(`${REPLICATE_API}/predictions/${predictionId.predictionId}`, {
            headers: { 'Authorization': `Bearer ${this.env.REPLICATE_API_TOKEN}` }
          });
          return await res.json();
        });

        if (result.status === 'succeeded' && result.output) {
          audioUrl = Array.isArray(result.output) ? result.output[0] : result.output;
          break;
        }
        if (result.status === 'failed' || result.status === 'canceled') {
          throw new Error(`Generation ${result.status}: ${result.error || 'unknown'}`);
        }
      }
    }

    if (!audioUrl) {
      throw new Error('Generation timed out');
    }

    // Step 4: 下载音频并存入 R2
    const audioKey = await step.do('store-audio', {
      retries: { limit: 0 }
    }, async () => {
      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) {
        throw new Error(`Failed to download audio: ${audioRes.status}`);
      }
      const audioBuffer = await audioRes.arrayBuffer();
      const key = `music/${userId}/${taskId}.mp3`;
      await this.env.AUDIO.put(key, audioBuffer, {
        httpMetadata: { contentType: 'audio/mpeg' }
      });
      return key;
    });

    // Step 5: 更新任务状态为 completed
    await step.do('mark-completed', async () => {
      await this.env.DB.prepare(
        `UPDATE music_tasks SET status = 'completed', audio_key = ?, updated_at = ? WHERE id = ?`
      ).bind(audioKey, Date.now(), taskId).run();
    });

    return { taskId, audioKey };
  }
}