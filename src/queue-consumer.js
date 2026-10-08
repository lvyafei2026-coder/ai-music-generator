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

      console.log('[Queue] Processing task: ' + taskId);
      console.log('[Queue] Payload: userId=' + userId + ' promptLen=' + (prompt || '').length + ' hasLyrics=' + !!lyrics + ' instrumental=' + isInstrumental);

      try {
        console.log('[Queue] Step 1: mark generating');
        await env.DB.prepare(
          `UPDATE music_tasks SET status = 'generating', updated_at = ? WHERE id = ?`
        ).bind(Date.now(), taskId).run();
        console.log('[Queue] Step 1 done');

        console.log('[Queue] Step 2: creating Replicate prediction');
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

        console.log('[Queue] Replicate response status: ' + createRes.status);
        let data = await createRes.json();
        console.log('[Queue] Replicate prediction id: ' + data.id + ' status: ' + data.status);

        if (!createRes.ok) {
          throw new Error('Replicate create failed: ' + JSON.stringify(data).slice(0, 300));
        }

        console.log('[Queue] Step 3: polling');
        let attempts = 0;
        while (data.status !== 'succeeded' && attempts < 30) {
          await new Promise(r => setTimeout(r, 10000));
          const pollRes = await fetch('https://api.replicate.com/v1/predictions/' + data.id, {
            headers: { 'Authorization': `Bearer ${env.REPLICATE_API_TOKEN}` }
          });
          data = await pollRes.json();
          attempts++;
          console.log('[Queue] Poll #' + attempts + ': status=' + data.status);
        }

        if (data.status !== 'succeeded' || !data.output) {
          throw new Error('Generation failed: ' + JSON.stringify(data).slice(0, 300));
        }

        const audioUrl = Array.isArray(data.output) ? data.output[0] : data.output;
        console.log('[Queue] Generation succeeded, audio URL: ' + audioUrl.slice(0, 100));

        console.log('[Queue] Step 4: downloading audio');
        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) {
          throw new Error('Failed to download audio: ' + audioRes.status);
        }
        const audioBuffer = await audioRes.arrayBuffer();
        console.log('[Queue] Audio downloaded, size: ' + audioBuffer.byteLength + ' bytes');

        const key = 'music/' + userId + '/' + taskId + '.mp3';
        await env.AUDIO.put(key, audioBuffer, {
          httpMetadata: { contentType: 'audio/mpeg' }
        });
        console.log('[Queue] Audio stored in R2: ' + key);

        console.log('[Queue] Step 5: mark completed');
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