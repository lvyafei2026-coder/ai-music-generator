import { WorkflowEntrypoint } from 'cloudflare:workers';

const REPLICATE_API = 'https://api.replicate.com/v1';
const MODEL_VERSION = 'minimax/music-2.6';

export class MusicGenerationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { taskId, userId, prompt, lyrics, isInstrumental } = event.payload;

    // Step 1: 标记为 generating
    await step.do('mark-generating', async () => {
      await this.env.DB.prepare(
        `UPDATE music_tasks SET status = 'generating', updated_at = ? WHERE id = ?`
      ).bind(Date.now(), taskId).run();
    });

    // Step 2: 创建 Replicate Prediction（返回 JSON 字符串）
    const predictionResultStr = await step.do('create-prediction', {
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
          'Prefer': 'wait=3'
        },
        body: JSON.stringify({ input })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(`Replicate error: ${JSON.stringify(data).slice(0, 300)}`);
      }

      if (data.status === 'succeeded' && data.output) {
        return JSON.stringify({ done: true, output: data.output });
      }
      return JSON.stringify({ done: false, predictionId: data.id });
    });

    const predictionInfo = JSON.parse(predictionResultStr);

    // 如果创建时已经完成，直接提取 audioUrl
    let audioUrl = null;
    if (predictionInfo.done) {
      audioUrl = Array.isArray(predictionInfo.output)
        ? predictionInfo.output[0]
        : predictionInfo.output;
    } else {
      // Step 3: 轮询直到完成
      const MAX_POLLS = 30;
      for (let i = 0; i < MAX_POLLS; i++) {
        await step.sleep(`wait-${i}`, '10 seconds');

        const pollResultStr = await step.do(`poll-${i}`, {
          retries: { limit: 0 },
          timeout: '30 seconds'
        }, async () => {
          const res = await fetch(
            `${REPLICATE_API}/predictions/${predictionInfo.predictionId}`,
            {
              headers: { 'Authorization': `Bearer ${this.env.REPLICATE_API_TOKEN}` }
            }
          );
          const data = await res.json();
          return JSON.stringify(data);
        });

        const pollResult = JSON.parse(pollResultStr);

        if (pollResult.status === 'succeeded' && pollResult.output) {
          audioUrl = Array.isArray(pollResult.output)
            ? pollResult.output[0]
            : pollResult.output;
          break;
        }
        if (pollResult.status === 'failed' || pollResult.status === 'canceled') {
          throw new Error(`Generation ${pollResult.status}: ${pollResult.error || 'unknown'}`);
        }
      }
    }

    if (!audioUrl) {
      throw new Error('Generation timed out after 5 minutes');
    }

    // Step 4: 下载音频并存入 R2
    const audioKey = await step.do('store-audio', {
      retries: { limit: 0 },
      timeout: '60 seconds'
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
      return key; // 字符串，不触发序列化 Bug
    });

    // Step 5: 更新任务状态为 completed
    await step.do('mark-completed', async () => {
      await this.env.DB.prepare(
        `UPDATE music_tasks SET status = 'completed', audio_key = ?, updated_at = ? WHERE id = ?`
      ).bind(audioKey, Date.now(), taskId).run();
    });

    return `completed:${taskId}`; // 返回字符串，不触发序列化 Bug
  }
}