import { WorkflowEntrypoint } from 'cloudflare:workers';

export class MusicGenerationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { taskId, userId, prompt, lyrics, isInstrumental } = event.payload;

    await step.do('mark-generating', async () => {
      await this.env.DB.prepare(
        `UPDATE music_tasks SET status = 'generating', updated_at = ? WHERE id = ?`
      ).bind(Date.now(), taskId).run();
    });

    const audioResult = await step.do('generate-music', {
      retries: { limit: 0 },
      timeout: '15 minutes'
    }, async () => {
      const response = await this.env.AI.run('minimax/music-2.6', {
        prompt: prompt,
        is_instrumental: isInstrumental,
        lyrics_optimizer: !lyrics,
        ...(lyrics && lyrics.trim() ? { lyrics: lyrics } : {})
      });

      if (!response || !response.audio) {
        throw new Error('No audio in response: ' + JSON.stringify(response).slice(0, 500));
      }

      return { audioUrl: response.audio };
    });

    const audioKey = await step.do('store-audio', {
      retries: { limit: 0 }
    }, async () => {
      const audioRes = await fetch(audioResult.audioUrl);
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

    await step.do('mark-completed', async () => {
      await this.env.DB.prepare(
        `UPDATE music_tasks SET status = 'completed', audio_key = ?, updated_at = ? WHERE id = ?`
      ).bind(audioKey, Date.now(), taskId).run();
    });

    return { taskId, audioKey };
  }
}