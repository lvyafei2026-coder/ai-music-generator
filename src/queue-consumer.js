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
      console.log('[Queue] Payload: userId=' + userId + ' promptLen=' + (prompt || '').length + ' hasLyrics=' + !!lyrics + ' instrumental=' + isInstrumental + ' duration=' + audioDuration);

      try {
        // ========================================================
        // Step 1: 标记任务为生成中
        // ========================================================
        console.log('[Queue] Step 1: mark generating');
        await env.DB.prepare(
          `UPDATE music_tasks SET status = 'generating', updated_at = ? WHERE id = ?`
        ).bind(Date.now(), taskId).run();
        console.log('[Queue] Step 1 done');

        // ========================================================
        // Step 2: 提交任务到 EmpirioLabs (MiniMax Music 3)
        //   POST https://api.empiriolabs.ai/v1/audio/generations
        //   字段（已按官方 schema 校正）：
        //     model: minimax-music-3
        //     prompt: string（必填）
        //     lyrics: string（人声必填，带 [Verse] 等结构标签）
        //     instrumental: boolean（默认 true，要人声必须传 false）
        //     audio_duration: number（10-300，默认 10）
        //     format: "mp3"（默认 wav，这里指定 mp3 匹配 R2）
        //     response_format: "url"（默认 url）
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

        if (isInstrumental) {
          payload.instrumental = true;
        } else {
          payload.instrumental = false;
          if (hasUserLyrics) {
            const hasTags = /\[(intro|verse|chorus|bridge|outro|pre chorus|hook|solo|inst|break)/i.test(lyrics);
            payload.lyrics = hasTags ? lyrics.trim() : '[Verse]\n' + lyrics.trim();
          }
          // 人声但没填歌词时，接口会返回 "lyrics are required unless instrumental is true"
          // 这里不补默认歌词，让接口报错，便于前端排查
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

        const jobId = createData.job_id || createData.id;
        const pollUrl = createData.poll_url || `/v1/jobs/${jobId}`;
        if (!jobId) {
          throw new Error('No job_id returned: ' + JSON.stringify(createData).slice(0, 300));
        }

        // ========================================================
        // Step 3: 轮询任务状态
        //   GET https://api.empiriolabs.ai/v1/jobs/{job_id}
        // ========================================================
        console.log('[Queue] Step 3: polling job ' + jobId + ' at ' + pollUrl);

        let statusData = null;
        let attempts = 0;
        const maxAttempts = 60; // 最多轮询 60 次，每次间隔 10 秒 = 最多等 10 分钟
        let finished = false;

        while (!finished && attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 10000));

          const pollRes = await fetch('https://api.empiriolabs.ai' + pollUrl, {
            headers: { 'Authorization': `Bearer ${env.EMPIRIOLABS_API_KEY}` }
          });
          statusData = await pollRes.json();
          attempts++;
          console.log('[Queue] Poll #' + attempts + ': ' + JSON.stringify(statusData).slice(0, 300));

          const s = (statusData.status || '').toLowerCase();
          if (s === 'completed' || s === 'succeeded' || s === 'success' || s === 'done') {
            finished = true;
          } else if (s === 'failed' || s === 'error') {
            throw new Error('Generation failed: ' + JSON.stringify(statusData).slice(0, 300));
          }
        }

        if (!finished) {
          throw new Error('Generation timed out after ' + maxAttempts + ' polls.');
        }

        // ========================================================
        // Step 4: 取音频 URL（精确路径，已用真实返回确认）
        //   返回结构：
        //   {
        //     result: {
        //       data: [ { url, content_type, duration_seconds, ... } ],
        //       usage: { billable_units, billing_unit, ... }
        //     }
        //   }
        // ========================================================
        const audioUrl = statusData?.result?.data?.[0]?.url;
        if (!audioUrl) {
          throw new Error('No audio URL in result: ' + JSON.stringify(statusData).slice(0, 500));
        }

        const billable = statusData?.result?.usage?.billable_units;
        const audioSeconds = statusData?.result?.data?.[0]?.duration_seconds;
        console.log('[Queue] Audio ready: ' + audioSeconds + 's, billed ' + billable + 's');
        console.log('[Queue] Audio URL: ' + String(audioUrl).slice(0, 100));

        // ========================================================
        // Step 5: 下载音频并存入 R2
        // ========================================================
        console.log('[Queue] Step 5: downloading audio');
        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) {
          throw new Error('Failed to download audio: ' + audioRes.status);
        }
        const audioBuffer = await audioRes.arrayBuffer();
        console.log('[Queue] Audio downloaded: ' + audioBuffer.byteLength + ' bytes');

        const key = 'music/' + userId + '/' + taskId + '.mp3';
        await env.AUDIO.put(key, audioBuffer, {
          httpMetadata: { contentType: 'audio/mpeg' }
        });
        console.log('[Queue] Audio stored in R2: ' + key);

        // ========================================================
        // Step 6: 标记任务完成
        // ========================================================
        console.log('[Queue] Step 6: mark completed');
        await env.DB.prepare(
          `UPDATE music_tasks SET status = 'completed', audio_key = ?, updated_at = ? WHERE id = ?`
        ).bind(key, Date.now(), taskId).run();
        console.log('[Queue] Task completed: ' + taskId);

        message.ack();
        console.log('[Queue] Message acknowledged');
      } catch (err) {
        const errMsg = err && err.message ? err.message : String(err);
        const errName = err && err.name ? err.name : 'Error';
        const errStack = err && err.stack ? err.stack : '';

        console.error('[Queue] ERROR name=' + errName + ' message=' + errMsg);
        console.error('[Queue] ERROR stack=' + errStack);
        console.error('[Queue] ERROR taskId=' + taskId);

        try {
          await env.DB.prepare(
            `UPDATE music_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`
          ).bind(errMsg, Date.now(), taskId).run();
          console.log('[Queue] Failure written to D1');
        } catch (dbErr) {
          console.error('[Queue] Failed to write failure to D1: ' + (dbErr.message || String(dbErr)));
        }

        message.ack();
      }
    }
  }
};