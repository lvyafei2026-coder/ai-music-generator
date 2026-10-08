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

    // Step 2: 调用 MiniMax 音乐生成 API（同步接口，直接返回音频）
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

      // 有自定义歌词时传入
      if (lyrics && lyrics.trim()) {
        payload.lyrics = lyrics;
      }

      // 纯器乐模式（MiniMax 支持 is_instrumental 参数）
      if (isInstrumental) {
        payload.is_instrumental = true;
      } else if (!lyrics || !lyrics.trim()) {
        // 没有歌词且不是纯器乐，让 AI 自动生成歌词
        payload.lyrics_optimizer = true;
      }

      const response = await fetch(gatewayUrl, {
        method: 'POST',
        headers: {
          'cf-aig-authorization': `Bearer ${this.env.CF_AIG_TOKEN}`,
          'Content-Type': 'application/json'
          // 注意：不要加 Authorization 头，BYOK 会自动替换
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MiniMax API error ${response.status}: ${errorText}`);
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
        throw new Error('No audio data in MiniMax response: ' + JSON.stringify(data).slice(0, 500));
      }

      return { audioData, audioUrl };
    });

    // Step 3: 处理音频并存入 R2
    const audioKey = await step.do('store-audio', async () => {
      const { audioData, audioUrl } = audioResult;
      let bytes;

      if (audioData) {
        // hex 编码：转为二进制
        const hexString = audioData;
        const len = hexString.length;
        bytes = new Uint8Array(len / 2);
        for (let i = 0; i < len; i += 2) {
          bytes[i / 2] = parseInt(hexString.substr(i, 2), 16);
        }
      } else if (audioUrl) {
        // URL：直接下载
        const audioRes = await fetch(audioUrl);
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