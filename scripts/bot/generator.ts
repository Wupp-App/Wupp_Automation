import { genAI } from './config';
import { BotPersona } from './personas';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen3:latest';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// 1. Groq Bulut API
async function generateWithGroq(model: string, systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (!GROQ_API_KEY) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.85,
        max_tokens: 150,
      }),
    });

    clearTimeout(timeoutId);
    if (!response.ok) return null;

    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

// 2. Gemini Bulut API (İzole)
async function generateWithGemini(modelName: string, systemPrompt: string, userPrompt: string): Promise<string | null> {
  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(`${systemPrompt}\n\n${userPrompt}`);
    const response = await result.response;
    return response.text()?.trim() || null;
  } catch {
    return null;
  }
}

// 3. Yerel / Runner Ollama (Optimize - Kilitlenmeyi önler)
async function generateWithOllama(systemPrompt: string, userPrompt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: LOCAL_MODEL,
        stream: false,
        keep_alive: '5m',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        options: {
          temperature: 0.85,
          num_predict: 90,
        },
      }),
    });

    clearTimeout(timeoutId);
    if (!response.ok) return null;

    const data = await response.json();
    return data?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

export async function generateEntry(
  topicName: string,
  persona: BotPersona,
  existingEntries: string[] = []
): Promise<string> {
  const sentenceTarget = Math.floor(Math.random() * 2) + 2; // 2 veya 3 cümle

  const systemInstruction = `
Sen Ekşi Sözlük'te yazan gerçek bir Türk internet kullanıcısısın. Kullanıcı adın: "${persona.username}".
Tavrın: ${persona.tone || persona.style || 'Samimi, hafif alaycı, dobra, sokak ağzı'}.

KESİN KURALLAR:
1. Asla felsefi, edebi, akademik ve yapay zeka kalıpları ("çağrısına dönüştürüyor", "derinlemesine", "algı karmaşası", "statusuna geri dönmeyi", "kolektif hafıza") KULLANMA.
2. Sokaktaki bir insanın Twitter/Sözlük'te yazacağı gibi doğrudan fikrini söyle.
3. Tam olarak ${sentenceTarget} kısa cümle kur.
4. Başlık veya tırnak işareti koyma; sadece entry metnini ver.

ÖRNEK DOĞAL ENTRY'LER:
- "yıllardır aynı senaryo, önce umut verip sonra kanser ediyorlar insanı. bu sene de bir şey değişmez."
- "haberi görünce yine şaşırmadım. her transfer döneminde aynı isimleri ısıtıp ısıtıp önümüze koyuyorlar."
- "valla kim ne derse desin bu kadroyla işimiz çok zor. defans hattı resmen evlere şenlik."
`;

  const contextPart =
    existingEntries.length > 0
      ? `\nDiğer yazarların dedikleri:\n- ${existingEntries.slice(-2).join('\n- ')}`
      : '';

  const userPrompt = `Başlık: "${topicName}"${contextPart}\n\nDoğal ve kısa sözlük entry'si yaz:`;

  let text: string | null = null;

  // ── 1. ÖNCELİK: GROQ (Doğrulanmış Kararlı Modeller) ──
  const groqModels = ['llama3-70b-8192', 'llama3-8b-8192', 'mixtral-8x7b-32768'];
  for (const model of groqModels) {
    text = await generateWithGroq(model, systemInstruction, userPrompt);
    if (text) {
      console.log(`⚡ [Groq: ${model}] @${persona.username} yorum üretti.`);
      break;
    }
  }

  // ── 2. YEDEK: GEMINI ──
  if (!text) {
    const geminiModels = ['gemini-1.5-flash', 'gemini-1.5-pro'];
    for (const gModel of geminiModels) {
      text = await generateWithGemini(gModel, systemInstruction, userPrompt);
      if (text) {
        console.log(`✨ [Gemini: ${gModel}] @${persona.username} yorum üretti.`);
        break;
      }
    }
  }

  // ── 3. SON ÇARE: OLLAMA ──
  if (!text) {
    text = await generateWithOllama(systemInstruction, userPrompt);
    if (text) {
      console.log(`🦙 [Ollama: ${LOCAL_MODEL}] @${persona.username} yorum üretti.`);
    }
  }

  if (!text) {
    console.error(`[AI Hatası] @${persona.username} için hiçbir AI kaynağından metin üretilemedi.`);
    return '';
  }

  // Temizleme
  let cleanText = text
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/^(entry:|yorum:)/i, '')
    .trim();

  if (cleanText.length > 0 && Math.random() > 0.4) {
    cleanText = cleanText.charAt(0).toLowerCase() + cleanText.slice(1);
  }

  return cleanText;
}
