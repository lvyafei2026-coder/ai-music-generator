export default {
  async queue(batch, env, ctx) {
    console.log('[Queue] Batch received, messages: ' + batch.messages.length);

    for (const message of batch.messages) {
      const body = message.body || {};
      const taskId = body.taskId;
      const userId = body.userId;
      const prompt = body.prompt;
      const lyrics = body.lyrics;
      const isInstrumental = body.isInstrumental;
      const audioDuration = body.audioDuration || 120;

      console.log('[Queue] Processing task: ' + taskId);

      try {
        console.log('[Queue] Step 1: mark generating');
        await env.DB.prepare(
          `UPDATE music_tasks SET status = 'generating', updated_at = ? WHERE id = ?`
        ).bind(Date.now(), taskId).run();

        // ========================================================
        // Step 2: 提交到 EmpirioLabs（字段名已按官方 schema 校正）
        //   model: minimax-music-3
        //   prompt: string（必填）
        //   lyrics: string（人声必填，带 [Verse] 等结构标签）
        //   instrumental: boolean（默认 true，要人声必须传 false）
        //   audio_duration: number（10-300，默认 10）
        //   format: "mp3"（默认 wav，这里指定 mp3 匹配 R2）
        //   response_format: "url"（默认 url）
        // ========================================================
        console.log('[Queue] Step 2: creating EmpirioLabs job');

        const hasUserLyrics = lyrics && lyrics.trim().length > 0;

        const payload = {
          model: 'minimax-music-3',
          prompt: prompt,
          audio_duration: audioDuration,
          format: 'mp3',
          response_format: 'url'
        };

        // instrumental 默认 true；要人声就显式传 false 并带上 lyrics
        if (isInstrumental) {
          payload.instrumental = true;
        } else {
          payload.instrumental = false;
          if (hasUserLyrics) {
            payload.lyrics = lyrics.trim();
          }
          // 如果用户没填歌词但要人声，文档说 lyrics 是 "required for a vocal track"。
          // 这里不强行补默认歌词，让接口自己报错，便于你发现前端问题。
        }

        const createRes = await fetch('https://api.empiriolabs.ai/v1/audio/generations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.EMPIRIOLABS_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        console.log('[Queue] EmpirioLabs response status: ' + createRes.status);
        const createData = await createRes.json();
        console.log('[Queue] EmpirioLabs create result: ' + JSON.stringify(createData).slice(0, 500));

        if (!createRes.ok) {
          throw new Error('EmpirioLabs create failed: ' + JSON.stringify(createData).slice(0, 300));
        }

        // ========================================================
        // Step 3: 取音频 URL
        // ⚠️ 待确认：文档只写了 POST /v1/audio/generations，
        //    没提轮询端点。这里先假设两种可能：
        //    A) 同步返回，audio URL 直接在 createData 里
        //    B) 异步返回，有 job id 需要轮询
        //    下面的代码先尝试直接从 createData 里找 URL，
        //    找不到再看是否有 job id 需要轮询。
        // ========================================================

        let audioUrl = null;

        // 情况 A：同步返回，直接取 URL
        audioUrl = extractAudioUrl(createData);

        // 情况 B：有 job id，需要轮询（URL 和字段名待你确认后修正）
        if (!audioUrl) {
          const jobId = createData.id || createData.job_id || createData.task_id;
          if (jobId) {
            console.log('[Queue] Step 3: polling job ' + jobId);
            let attempts = 0;
            const maxAttempts = 60;
            let finished = false;
            let statusData = null;

            while (!finished && attempts < maxAttempts) {
              await new Promise(r => setTimeout(r, 10000));
              // ⚠️ 轮询 URL 待确认，这里先用最常见的写法
              const pollRes = await fetch(`https://api.empiriolabs.ai/v1/audio/generations/${jobId}`, {
                headers: { 'Authorization': `Bearer ${env.EMPIRIOLABS_API_KEY}` }
              });
              statusData = await pollRes.json();
              attempts++;
              console.log('[Queue] Poll #' + attempts + ': ' + JSON.stringify(statusData).slice(0, 200));

              const s = (statusData.status || '').toLowerCase();
              if (s === 'completed' || s === 'succeeded' || s === 'success') {
                finished = true;
              } else if (s === 'failed' || s === 'error') {
                throw new Error('Generation failed: ' + JSON.stringify(statusData).slice(0, 300));
              }
            }
            if (!finished) throw new Error('Generation timed out.');
            audioUrl = extractAudioUrl(statusData);
          }
        }

        if (!audioUrl) {
          throw new Error('No audio URL in result: ' + JSON.stringify(createData).slice(0, 300));
        }

        console.log('[Queue] Audio URL: ' + String(audioUrl).slice(0, 100));

        // ========================================================
        // Step 4: 下载音频并存入 R2
        // ========================================================
        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) throw new Error('Failed to download audio: ' + audioRes.status);
        const audioBuffer = await audioRes.arrayBuffer();
        console.log('[Queue] Audio downloaded: ' + audioBuffer.byteLength + ' bytes');

        const key = 'music/' + userId + '/' + taskId + '.mp3';
        await env.AUDIO.put(key, audioBuffer, {
          httpMetadata: { contentType: 'audio/mpeg' }
        });

        // ========================================================
        // Step 5: 标记完成
        // ========================================================
        await env.DB.prepare(
          `UPDATE music_tasks SET status = 'completed', audio_key = ?, updated_at = ? WHERE id = ?`
        ).bind(key, Date.now(), taskId).run();
        console.log('[Queue] Task completed: ' + taskId);

        message.ack();
      } catch (err) {
        const errMsg = err && err.message ? err.message : String(err);
        console.error('[Queue] ERROR message=' + errMsg);
        console.error('[Queue] ERROR stack=' + (err && err.stack ? err.stack : ''));

        try {
          await env.DB.prepare(
            `UPDATE music_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`
          ).bind(errMsg, Date.now(), taskId).run();
        } catch (dbErr) {
          console.error('[Queue] Failed to write failure: ' + (dbErr.message || String(dbErr)));
        }
        message.ack();
      }
    }
  }
};

// 从各种可能的返回结构里提取音频 URL
function extractAudioUrl(data) {
  if (!data || typeof data !== 'object') return null;
  // 直接字段
  if (typeof data.audio_url === 'string') return data.audio_url;
  if (typeof data.url === 'string') return data.url;
  if (typeof data.output === 'string') return data.output;
  // output 是对象
  if (data.output && typeof data.output === 'object') {
    if (typeof data.output.audio_url === 'string') return data.output.audio_url;
    if (typeof data.output.url === 'string') return data.output.url;
    if (Array.isArray(data.output) && data.output.length > 0) {
      const first = data.output[0];
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object') return first.audio_url || first.url;
    }
  }
  // data 数组
  if (Array.isArray(data.data) && data.data.length > 0) {
    const first = data.data[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') return first.audio_url || first.url;
  }
  return null;
}