import { WorkflowEntrypoint } from 'cloudflare:workers';

export class MusicGenerationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { taskId, userId, prompt, lyrics, isInstrumental } = event.payload;

    // Step 1: 标记为 generating
    await step.do('mark-generating', async () => {
      await this.env.DB.prepare(
        `UPDATE music_tasks SET status = 'generating', updated_at = ? WHERE id = ?`
      ).bind(Date.now(), taskId).run();
    });

    // Step 2: 通过 AI Gateway BYOK 调用 MiniMax
    // 关键：timeout 设为 15 分钟，覆盖 MiniMax 同步生成的全部时间
    const audioResult = await step.do('generate-music', {
      retries: { limit: 0 },
      timeout: '15 minutes'
    }, async () => {
      const gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${this.env.CF_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/custom-minimax/v1/music_generation`;

      const payload = {
        model: 'music-2.6',
        prompt: prompt,
        is_instrumental: isInstrumental,
        lyrics_optimizer: !lyrics,
        audio_setting: {
          sample_rate: 44100,
          bitrate: 256000,
          format: 'mp3'
        }
      };

      // 有自定义歌词时传入
      if (lyrics && lyrics.trim()) {
        payload.lyrics = lyrics;
      }

      const response = await fetch(gatewayUrl, {
        method: 'POST',
        headers: {
          // 只带 Cloudflare 网关的认证头
          'cf-aig-authorization': `Bearer ${this.env.CF_AIG_TOKEN}`,
          'Content-Type': 'application/json'
          // 注意：不要带 Authorization 头，BYOK 会自动替换为存储的 MiniMax Key
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MiniMax API error ${response.status}: ${errorText.slice(0, 500)}`);
      }

      const data = await response.json();

      // 检查 MiniMax 的业务错误码
      if (data?.base_resp?.status_code !== 0) {
        throw new Error(`MiniMax error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
      }

      // 音频数据可能是 hex 编码的字符串，也可能是 URL
      const audioData = data?.data?.audio;
      const audioUrl = data?.data?.audio_url;

      if (!audioData && !audioUrl) {
        throw new Error('No audio in response: ' + JSON.stringify(data).slice(0, 500));
      }

      return { audioData, audioUrl };
    });

    // Step 3: 处理音频并存入 R2
    const audioKey = await step.do('store-audio', {
      retries: { limit: 0 }
    }, async () => {
      const { audioData, audioUrl } = audioResult;
      let bytes;

      if (audioData) {
        // hex 编码：转为二进制
        const len = audioData.length;
        bytes = new Uint8Array(len / 2);
        for (let i = 0; i < len; i += 2) {
          bytes[i / 2] = parseInt(audioData.substr(i, 2), 16);
        }
      } else if (audioUrl) {
        // URL：直接下载
        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) {
          throw new Error(`Failed to download audio: ${audioRes.status}`);
        }
        bytes = new Uint8Array(await audioRes.arrayBuffer());
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