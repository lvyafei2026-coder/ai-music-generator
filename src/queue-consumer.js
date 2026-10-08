export default {
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const { taskId, userId, prompt, lyrics, isInstrumental } = message.body;

      try {
        await env.DB.prepare(
          `UPDATE music_tasks SET status = 'generating', updated_at = ? WHERE id = ?`
        ).bind(Date.now(), taskId).run();

        // 1. 创建 Replicate Prediction
        const createRes = await fetch('https://api.replicate.com/v1/models/minimax/music-2.6/predictions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.REPLICATE_API_TOKEN}`,
            'Content-Type': 'application/json',
            'Prefer': 'wait=60'
          },
          body: JSON.stringify({
            input: {
              prompt: prompt,
              is_instrumental: isInstrumental,
              lyrics_optimizer: !lyrics,
              ...(lyrics && lyrics.trim() ? { lyrics: lyrics } : {})
            }
          })
        });

        let data = await createRes.json();

        // 2. 如果 60 秒内没完成，轮询
        let attempts = 0;
        while (data.status !== 'succeeded' && attempts < 30) {
          await new Promise(r => setTimeout(r, 10000));
          const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${data.id}`, {
            headers: { 'Authorization': `Bearer ${env.REPLICATE_API_TOKEN}` }
          });
          data = await pollRes.json();
          attempts++;
        }

        if (data.status !== 'succeeded' || !data.output) {
          throw new Error('Generation failed: ' + JSON.stringify(data).slice(0, 300));
        }

        const audioUrl = Array.isArray(data.output) ? data.output[0] : data.output;

        // 3. 下载音频并存入 R2
        const audioRes = await fetch(audioUrl);
        const audioBuffer = await audioRes.arrayBuffer();
        const key = `music/${userId}/${taskId}.mp3`;
        await env.AUDIO.put(key, audioBuffer, {
          httpMetadata: { contentType: 'audio/mpeg' }
        });

        // 4. 更新任务状态
        await env.DB.prepare(
          `UPDATE music_tasks SET status = 'completed', audio_key = ?, updated_at = ? WHERE id = ?`
        ).bind(key, Date.now(), taskId).run();

        message.ack();
      } catch (err) {
        console.error('Queue processing error:', err);
        await env.DB.prepare(
          `UPDATE music_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`
        ).bind(err.message || 'Unknown error', Date.now(), taskId).run();
        message.ack(); // 不重试，避免重复扣费
      }
    }
  }
};