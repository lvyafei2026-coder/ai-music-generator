// AI 歌词生成 / 优化
// 使用 Cloudflare Workers AI 的 Llama 3.1 8B

const MODEL = '@cf/meta/llama-3.1-8b-instruct';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// 根据语言，构造系统提示
function buildSystemPrompt(lang, mode) {
  const isZh = lang === 'zh';

  if (mode === 'generate') {
    if (isZh) {
      return [
        '你是一位专业的歌词创作者。用户会给你一个主题或场景，你需要创作一段中文歌词。',
        '要求：',
        '1. 歌词必须带结构标签，每个标签单独占一行，例如 [Verse]、[Chorus]、[Bridge]、[Pre Chorus]、[Outro]。',
        '2. 至少包含 1 段主歌、1 段副歌。如果有桥段更好。',
        '3. 歌词要押韵、有画面感、朗朗上口。',
        '4. 字数控制在 80-150 字之间。',
        '5. 只输出歌词本身，不要任何解释、说明或标题。'
      ].join('\n');
    }
    return [
      'You are a professional songwriter. The user gives you a topic or scene, and you write English lyrics.',
      'Requirements:',
      '1. The lyrics must include structure tags, each on its own line, e.g. [Verse], [Chorus], [Bridge], [Pre Chorus], [Outro].',
      '2. Include at least one verse and one chorus. A bridge is a plus.',
      '3. Lyrics should rhyme, paint a picture, and be singable.',
      '4. Keep it around 60-120 words.',
      '5. Output ONLY the lyrics. No explanations, no title, no commentary.'
    ].join('\n');
  }

  // mode === 'optimize'
  if (isZh) {
    return [
      '你是一位专业的歌词编辑。用户会给你一段现有的歌词，你需要优化它。',
      '要求：',
      '1. 保留原有的主题和核心表达。',
      '2. 补全或修正结构标签（[Verse]、[Chorus] 等），每个标签单独占一行。',
      '3. 优化押韵、节奏和用词，让歌词更适合演唱。',
      '4. 只输出优化后的歌词，不要任何解释、说明或对比。'
    ].join('\n');
  }
  return [
    'You are a professional lyric editor. The user gives you existing lyrics, and you improve them.',
    'Requirements:',
    '1. Preserve the original theme and core meaning.',
    '2. Complete or fix structure tags ([Verse], [Chorus], etc.), each on its own line.',
    '3. Improve rhyme, rhythm, and word choice so it sings better.',
    '4. Output ONLY the improved lyrics. No explanations, no comparison, no commentary.'
  ].join('\n');
}

function buildUserPrompt(lang, mode, topic, lyrics) {
  const isZh = lang === 'zh';
  if (mode === 'generate') {
    if (isZh) return '主题：' + topic + '\n\n请为这个主题创作歌词。';
    return 'Topic: ' + topic + '\n\nWrite lyrics for this topic.';
  }
  if (isZh) return '请优化以下歌词：\n\n' + lyrics;
  return 'Improve these lyrics:\n\n' + lyrics;
}

export async function handleLyrics(request, env) {
  try {
    const body = await request.json();
    const mode = body.mode === 'optimize' ? 'optimize' : 'generate';
    const lang = body.language === 'zh' ? 'zh' : 'en';
    const topic = (body.topic || '').trim();
    const lyrics = (body.lyrics || '').trim();

    // 参数校验
    if (mode === 'generate' && !topic) {
      return json({ error: lang === 'zh' ? '请输入主题。' : 'Please enter a topic.' }, 400);
    }
    if (mode === 'optimize' && !lyrics) {
      return json({ error: lang === 'zh' ? '请先输入歌词。' : 'Please enter lyrics first.' }, 400);
    }
    if (topic.length > 200) {
      return json({ error: lang === 'zh' ? '主题过长。' : 'Topic too long.' }, 400);
    }
    if (lyrics.length > 2000) {
      return json({ error: lang === 'zh' ? '歌词过长。' : 'Lyrics too long.' }, 400);
    }

    const systemPrompt = buildSystemPrompt(lang, mode);
    const userPrompt = buildUserPrompt(lang, mode, topic, lyrics);

    const aiRes = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 512,
      temperature: 0.85
    });

    // Llama 3.1 的返回通常是 { response: "..." }
    let text = (aiRes && (aiRes.response || aiRes.result)) || '';
    text = String(text).trim();

    // 去掉可能被包上的 Markdown 代码块标记
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();

    if (!text) {
      return json({ error: lang === 'zh' ? 'AI 返回为空，请重试。' : 'AI returned empty. Please try again.' }, 500);
    }

    return json({ lyrics: text });
  } catch (err) {
    console.error('[Lyrics] Error:', err);
    return json({ error: 'Lyrics generation failed. Please try again.' }, 500);
  }
}
