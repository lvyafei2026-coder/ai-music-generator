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

    // Step 2: 调用 MiniMax 音乐生成 API（通过 AI Gateway BYOK）
    const audioResult = await step.do('generate-music', {
      retries: { limit: 0 }  // 不重试，避免重复扣费
    }, async () => {
      const gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${this.env.CF_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/custom-minimax/v1/music_generation`;

      const payload = {
        model: 'music-3.0',
        prompt: prompt,
        audio_setting: {
          sample_rate: 44100,
          bitrate: 256000,
          format: 'mp3'
        }
      };

      // 有自定义歌词时传入，否则让 AI 自动生成
      if (lyrics && lyrics.trim()) {
        payload.lyrics = lyrics;
      }

      // 纯器乐模式（MiniMax 可能不支持，先注释掉，按实际文档调整）
      // if (isInstrumental) {
      //   payload.is_instrumental = true;
      // }

      const response = await fetch(gatewayUrl, {
        method: 'POST',
        headers: {
          'cf-aig-authorization': `Bearer ${this.env.CF_AIG_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MiniMax API error ${response.status}: ${errorText}`);
      }

      const data = await response.json();

      // MiniMax 返回的音频数据通常在 data.data.audio 字段（base64 编码）
      // 具体字段名以 MiniMax 官方文档为准
      const audioBase64 = data?.data?.audio || data?.audio;

      if (!audioBase64) {
        throw new Error('No audio data in MiniMax response: ' + JSON.stringify(data).slice(0, 500));
      }

      return { audioBase64 };
    });

    // Step 3: 解码 base64 并存入 R2
    const audioKey = await step.do('store-audio', async () => {
      const { audioBase64 } = audioResult;

      // 将 base64 转为二进制
      const binaryString = atob(audioBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const key = `music/${userId}/${taskId}.mp3`;

      await this.env.AUDIO.put(key, bytes, {
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